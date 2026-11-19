use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn forward_deep_link(app: &tauri::AppHandle, url: &str) {
    if !url.starts_with("neo://inbox/") && !url.starts_with("neo://coding/") {
        return;
    }
    focus_main(app);
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(payload) = serde_json::to_string(url) {
            let _ = window.eval(&format!(
                "window.dispatchEvent(new CustomEvent('neo:deep-link', {{detail: {payload}}}))"
            ));
        }
    }
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let endpoint = std::env::var("NMH_UPDATER_ENDPOINT")
        .map_err(|_| "Updater endpoint is not configured".to_string())?;
    let public_key = std::env::var("NMH_UPDATER_PUBLIC_KEY")
        .map_err(|_| "Updater public key is not configured".to_string())?;
    let endpoint = endpoint.parse().map_err(|error| format!("Invalid updater URL: {error}"))?;
    let updater = app.updater_builder()
        .endpoints(vec![endpoint]).map_err(|error| error.to_string())?
        .pubkey(public_key).build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|candidate| candidate.version))
}

struct GatewaySidecar {
    child: Child,
    input: ChildStdin,
}

impl GatewaySidecar {
    fn launch(app: &tauri::AppHandle, data_dir: PathBuf) -> Result<(Self, u16), Box<dyn std::error::Error>> {
        fs::create_dir_all(&data_dir)?;
        let repo = std::env::var_os("NMH_DESKTOP_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
        let bundled = app.path().resource_dir()?.join("gateway");
        let packaged = bundled.join("apps/gateway/src/main.ts").is_file();
        let gateway_dir = if packaged { bundled.join("apps/gateway") } else { repo.join("apps/gateway") };
        let extensions_dir = if packaged { bundled.join("extensions") } else { repo.join("extensions") };
        let node = if packaged {
            let filename = if cfg!(windows) { "neo-gateway.exe" } else { "neo-gateway" };
            std::env::current_exe()?.with_file_name(filename).into_os_string()
        } else {
            std::env::var_os("NMH_NODE").unwrap_or_else(|| "node".into())
        };
        let mut command = Command::new(node);
        command
            .args(["--import", "tsx", "src/main.ts"])
            .current_dir(gateway_dir)
            .env("NMH_PORT", "0")
            .env("NMH_DB_PATH", data_dir.join("neo.sqlite"))
            .env("NMH_EXTENSIONS_DIR", extensions_dir)
            .env("NEO_MODE", "desktop")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or("Gateway stdin unavailable")?;
        let output = child.stdout.take().ok_or("Gateway stdout unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Some(json) = line.strip_prefix("GATEWAY_READY ") {
                    let port = serde_json::from_str::<serde_json::Value>(json)
                        .ok()
                        .and_then(|value| value["port"].as_u64())
                        .and_then(|port| u16::try_from(port).ok())
                        .filter(|port| *port > 0);
                    let _ = sender.send(port);
                }
            }
        });

        let mut sidecar = Self { child, input };
        match receiver.recv_timeout(Duration::from_secs(25)) {
            Ok(Some(port)) => Ok((sidecar, port)),
            result => {
                sidecar.stop();
                Err(format!("Gateway did not report a port: {result:?}").into())
            }
        }
    }

    fn stop(&mut self) {
        let _ = self.input.write_all(b"shutdown\n");
        let _ = self.input.flush();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(not(windows))]
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct GatewayState(Mutex<Option<GatewaySidecar>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![check_for_updates])
        .setup(|app| {
            let data_dir = std::env::var_os("NMH_DESKTOP_DATA_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_data_dir())?;
            let (sidecar, port) = GatewaySidecar::launch(app.handle(), data_dir.clone())?;
            let gateway_pid = sidecar.child.id();
            app.manage(GatewayState(Mutex::new(Some(sidecar))));

            let token = fs::read_to_string(data_dir.join("desktop.token")).unwrap_or_default().trim().to_string();
            let mut url = if token.is_empty() {
                format!("index.html?gateway=http%3A%2F%2F127.0.0.1%3A{port}")
            } else {
                format!("index.html?gateway=http%3A%2F%2F127.0.0.1%3A{port}&token={token}")
            };
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(link) = urls.first() {
                    if link.scheme() == "neo" && ["inbox", "coding"].contains(&link.host_str().unwrap_or_default()) {
                        url.push_str("&deep_link=");
                        url.push_str(&percent_encoding::utf8_percent_encode(link.as_str(), percent_encoding::NON_ALPHANUMERIC).to_string());
                    }
                }
            }
            let url = WebviewUrl::App(url.into());
            WebviewWindowBuilder::new(app, "main", url)
                .title("Neo Meta Harness")
                .inner_size(1280.0, 860.0)
                .build()?;

            let shortcut = std::env::var("NMH_LAUNCHER_SHORTCUT").ok()
                .or_else(|| fs::read_to_string(data_dir.join("launcher-shortcut.txt")).ok())
                .unwrap_or_else(|| "Ctrl+Shift+Space".to_owned());
            app.global_shortcut().on_shortcut(shortcut.trim(), |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    focus_main(app);
                }
            })?;

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    forward_deep_link(&app_handle, url.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    forward_deep_link(app.handle(), url.as_str());
                }
            }

            let open = MenuItem::with_id(app, "open", "Open Neo", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop all agents", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Neo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("Desktop tray icon unavailable")?.clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => focus_main(app),
                    "stop" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.dispatchEvent(new Event('neo:stop-all-agents'))");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if let Some(file) = std::env::var_os("NMH_DESKTOP_STATUS_FILE") {
                fs::write(
                    file,
                    serde_json::json!({ "port": port, "gatewayPid": gateway_pid, "appPid": std::process::id(), "trayReady": true, "deepLinks": ["neo://inbox/", "neo://coding/"], "shortcut": shortcut.trim() }).to_string(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Neo desktop shell")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(mut sidecar) = app.state::<GatewayState>().0.lock().unwrap().take() {
                    sidecar.stop();
                }
            }
        });
}
