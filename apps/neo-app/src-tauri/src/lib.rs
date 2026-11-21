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

#[derive(Default)]
struct UpdateCandidate(Mutex<Option<String>>);

fn validate_updater_endpoint(endpoint: &str, is_debug: bool) -> Result<(), String> {
    if !is_debug && !endpoint.starts_with("https://") {
        return Err(format!("Release updater endpoint must use HTTPS: {endpoint}"));
    }
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("Updater endpoint cannot be empty".into());
    }
    Ok(())
}

fn resolve_allowed_hosts(
    endpoint_urls: &[url::Url],
    configured_hosts: &[String],
) -> Vec<String> {
    let mut hosts = Vec::new();

    for ep in endpoint_urls {
        if let Some(host) = ep.host_str() {
            let host_lower = host.to_lowercase();
            if !hosts.contains(&host_lower) {
                hosts.push(host_lower.clone());
            }
            if host_lower == "github.com" || host_lower == "api.github.com" {
                for gh_host in ["objects.githubusercontent.com", "release-assets.githubusercontent.com"] {
                    let s = gh_host.to_string();
                    if !hosts.contains(&s) {
                        hosts.push(s);
                    }
                }
            }
        }
    }

    for h in configured_hosts {
        let h_lower = h.trim().to_lowercase();
        if !h_lower.is_empty() && !hosts.contains(&h_lower) {
            hosts.push(h_lower);
        }
    }

    #[cfg(debug_assertions)]
    {
        if let Ok(env_hosts) = std::env::var("NMH_UPDATER_ALLOWED_HOSTS") {
            for h in env_hosts.split(',') {
                let h_lower = h.trim().to_lowercase();
                if !h_lower.is_empty() && !hosts.contains(&h_lower) {
                    hosts.push(h_lower);
                }
            }
        }
    }

    hosts
}

fn validate_update_download_url(
    download_url: &url::Url,
    allowed_hosts: &[String],
    is_debug: bool,
) -> Result<(), String> {
    if !is_debug && download_url.scheme() != "https" {
        return Err(format!("Update download URL must use HTTPS in release builds: {download_url}"));
    }
    let download_host = download_url
        .host_str()
        .ok_or_else(|| format!("Update download URL has no valid host: {download_url}"))?
        .to_lowercase();

    let is_allowed = allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&download_host));

    if !is_allowed {
        return Err(format!(
            "Update download URL host '{download_host}' is not in the allowed hosts list: {allowed_hosts:?}"
        ));
    }
    Ok(())
}

fn get_updater_overrides() -> (Option<String>, Option<String>) {
    #[cfg(debug_assertions)]
    {
        let endpoint = std::env::var("NMH_UPDATER_ENDPOINT").ok().filter(|s| !s.trim().is_empty());
        let pubkey = std::env::var("NMH_UPDATER_PUBLIC_KEY").ok().filter(|s| !s.trim().is_empty());
        (endpoint, pubkey)
    }
    #[cfg(not(debug_assertions))]
    {
        (None, None)
    }
}

fn configure_updater_builder(
    app: &tauri::AppHandle,
) -> Result<(tauri_plugin_updater::UpdaterBuilder, Vec<String>), String> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    let (override_endpoint, override_pubkey) = get_updater_overrides();
    let mut effective_endpoints = Vec::new();

    if let Some(endpoint) = override_endpoint {
        validate_updater_endpoint(&endpoint, cfg!(debug_assertions))?;
        let url: url::Url = endpoint.trim().parse().map_err(|error| format!("Invalid updater URL: {error}"))?;
        builder = builder.endpoints(vec![url.clone()]).map_err(|error| error.to_string())?;
        effective_endpoints.push(url);
    } else {
        if let Some(endpoints) = app.config().plugins.0.get("updater").and_then(|val| val.get("endpoints")).and_then(|val| val.as_array()) {
            for ep in endpoints {
                if let Some(s) = ep.as_str() {
                    validate_updater_endpoint(s, cfg!(debug_assertions))?;
                    if let Ok(url) = s.trim().parse::<url::Url>() {
                        effective_endpoints.push(url);
                    }
                }
            }
        }
    }

    if let Some(public_key) = override_pubkey {
        builder = builder.pubkey(public_key.trim());
    }

    let mut configured_allowed_hosts = Vec::new();
    if let Some(hosts) = app.config().plugins.0.get("updater")
        .and_then(|val| val.get("allowedHosts"))
        .and_then(|val| val.as_array())
    {
        for h in hosts {
            if let Some(s) = h.as_str() {
                configured_allowed_hosts.push(s.to_string());
            }
        }
    }

    let allowed_hosts = resolve_allowed_hosts(&effective_endpoints, &configured_allowed_hosts);

    // Set Reqwest redirect policy: only HTTPS (in release) and target host in allowed_hosts
    let redirect_hosts = allowed_hosts.clone();
    builder = builder.configure_client(move |client_builder| {
        let hosts = redirect_hosts.clone();
        client_builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let next = attempt.url();
            if !cfg!(debug_assertions) && next.scheme() != "https" {
                return attempt.error("Updater redirects must use HTTPS in release builds");
            }
            if let Some(next_host) = next.host_str() {
                let is_allowed = hosts.iter().any(|h| h.eq_ignore_ascii_case(next_host));
                if !is_allowed {
                    return attempt.error("Updater redirect to an untrusted host is forbidden");
                }
            } else {
                return attempt.error("Updater redirect target has no host");
            }
            if attempt.previous().len() >= 5 {
                attempt.error("Too many updater redirects")
            } else {
                attempt.follow()
            }
        }))
    });

    Ok((builder, allowed_hosts))
}

async fn check_for_updates_internal(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let (builder, allowed_hosts) = configure_updater_builder(app)?;
    let updater = builder.build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    if let Some(ref update) = update {
        validate_update_download_url(&update.download_url, &allowed_hosts, cfg!(debug_assertions))?;
    }
    let version = update.map(|candidate| candidate.version);
    if let Some(state) = app.try_state::<UpdateCandidate>() {
        *state.0.lock().unwrap() = version.clone();
    }
    Ok(version)
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("Updates can only be checked from the main window".into());
    }
    check_for_updates_internal(&app).await
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Updates can only be installed from the main window".into());
    }
    let candidate = app.try_state::<UpdateCandidate>()
        .and_then(|state| state.0.lock().unwrap().clone())
        .ok_or_else(|| "No update candidate available. Check for updates first.".to_string())?;

    let (builder, allowed_hosts) = configure_updater_builder(&app)?;
    let updater = builder.build().map_err(|error| error.to_string())?;
    if let Some(update) = updater.check().await.map_err(|error| error.to_string())? {
        if update.version != candidate {
            return Err(format!("Available update version ({}) does not match expected candidate ({candidate})", update.version));
        }
        validate_update_download_url(&update.download_url, &allowed_hosts, cfg!(debug_assertions))?;
        update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
        app.restart();
    }
    Err("No update available to install".into())
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
        .invoke_handler(tauri::generate_handler![check_for_updates, install_update])
        .setup(|app| {
            let data_dir = std::env::var_os("NMH_DESKTOP_DATA_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_data_dir())?;
            let (sidecar, port) = GatewaySidecar::launch(app.handle(), data_dir.clone())?;
            let app_handle_for_update = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(Some(version)) = check_for_updates_internal(&app_handle_for_update).await {
                    if let Some(window) = app_handle_for_update.get_webview_window("main") {
                        if let Ok(payload) = serde_json::to_string(&version) {
                            let _ = window.eval(&format!(
                                "window.dispatchEvent(new CustomEvent('neo:update-available', {{detail: {payload}}}))"
                            ));
                        }
                    }
                }
            });
            let gateway_pid = sidecar.child.id();
            app.manage(GatewayState(Mutex::new(Some(sidecar))));
            app.manage(UpdateCandidate::default());

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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_endpoint_https_enforcement() {
        assert!(validate_updater_endpoint("http://insecure.example.com/latest.json", false).is_err());
        assert!(validate_updater_endpoint("https://secure.example.com/latest.json", false).is_ok());
        assert!(validate_updater_endpoint("http://127.0.0.1:8080/latest.json", true).is_ok());
        assert!(validate_updater_endpoint("", false).is_err());
    }

    #[test]
    fn test_resolve_allowed_hosts_github_defaults() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let hosts = resolve_allowed_hosts(&ep, &[]);
        assert!(hosts.contains(&"github.com".to_string()));
        assert!(hosts.contains(&"objects.githubusercontent.com".to_string()));
        assert!(hosts.contains(&"release-assets.githubusercontent.com".to_string()));
        assert!(!hosts.contains(&"attacker.com".to_string()));
    }

    #[test]
    fn test_download_url_validation_with_allowed_hosts() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &["updates.custom.com".to_string()]);

        // Disallowed scheme in release
        let http_url = url::Url::parse("http://objects.githubusercontent.com/asset.msi.zip").unwrap();
        assert!(validate_update_download_url(&http_url, &allowed_hosts, false).is_err());
        assert!(validate_update_download_url(&http_url, &allowed_hosts, true).is_ok());

        // Redirect to GitHub asset host (valid)
        let github_asset_url = url::Url::parse("https://objects.githubusercontent.com/asset.msi.zip").unwrap();
        assert!(validate_update_download_url(&github_asset_url, &allowed_hosts, false).is_ok());

        let release_asset_url = url::Url::parse("https://release-assets.githubusercontent.com/asset.msi.zip").unwrap();
        assert!(validate_update_download_url(&release_asset_url, &allowed_hosts, false).is_ok());

        // Configured custom host (valid)
        let custom_url = url::Url::parse("https://updates.custom.com/asset.msi.zip").unwrap();
        assert!(validate_update_download_url(&custom_url, &allowed_hosts, false).is_ok());

        // Untrusted third-party host (rejected)
        let attacker_url = url::Url::parse("https://attacker.com/asset.msi.zip").unwrap();
        assert!(validate_update_download_url(&attacker_url, &allowed_hosts, false).is_err());
        assert!(validate_update_download_url(&attacker_url, &allowed_hosts, true).is_err());
    }

    #[test]
    fn test_override_is_debug_only() {
        unsafe {
            std::env::set_var("NMH_UPDATER_PUBLIC_KEY", "injected_attacker_key");
            std::env::set_var("NMH_UPDATER_ENDPOINT", "http://attacker.example/update.json");
        }

        let (endpoint, pubkey) = get_updater_overrides();
        if cfg!(debug_assertions) {
            assert_eq!(endpoint.as_deref(), Some("http://attacker.example/update.json"));
            assert_eq!(pubkey.as_deref(), Some("injected_attacker_key"));
        } else {
            assert!(endpoint.is_none());
            assert!(pubkey.is_none());
        }
    }
}
