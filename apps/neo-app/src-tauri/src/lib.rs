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

/// The single source of truth for updates. The frontend renders `snapshot()` (via `update_state`) and
/// never a command reply or event payload.
///
/// - Every check (startup or manual) starts a new **generation**. Only the newest generation may store its
///   result, so a late startup check or an older manual reply can never set or clear the candidate.
/// - Every mutation bumps **revision**, so the frontend can drop an out-of-order `update_state` reply.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct CandidateState {
    version: Option<String>,
    generation: u64,
    revision: u64,
    checking: bool,
    installing: bool,
    error: Option<String>,
}

impl CandidateState {
    /// A check is starting (startup or manual): it supersedes every check already in flight.
    pub fn begin_check(&mut self) -> u64 {
        self.generation += 1;
        self.revision += 1;
        self.checking = true;
        self.error = None;
        self.generation
    }

    /// Store a finished check, only if it is still the newest. Returns whether it applied.
    /// The state then describes that check: a new version, no update, or an error (no candidate).
    pub fn finish_check(&mut self, generation: u64, result: Result<Option<String>, String>) -> bool {
        if generation != self.generation {
            return false;
        }
        self.revision += 1;
        self.checking = false;
        match result {
            Ok(version) => {
                self.version = version;
                self.error = None;
            }
            Err(error) => {
                self.version = None;
                self.error = Some(error);
            }
        }
        true
    }

    /// Installing the current candidate. Returns it, or an error when there is none or one is running.
    pub fn begin_install(&mut self) -> Result<String, String> {
        if self.installing {
            return Err("An update is already being installed".into());
        }
        let version = self.version.clone().ok_or("No update candidate available. Check for updates first.")?;
        self.revision += 1;
        self.installing = true;
        self.error = None;
        Ok(version)
    }

    pub fn fail_install(&mut self, error: String) {
        self.revision += 1;
        self.installing = false;
        self.error = Some(format!("Installation failed: {error}"));
    }

    pub fn version(&self) -> Option<String> {
        self.version.clone()
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "generation": self.generation,
            "revision": self.revision,
            "available": self.version.is_some(),
            "version": self.version,
            "checking": self.checking,
            "installing": self.installing,
            "error": self.error,
        })
    }
}

#[derive(Default)]
struct UpdateCandidate(Mutex<CandidateState>);

pub const SHORTCUT_RETRY_DELAY: Duration = Duration::from_millis(400);

/// Register the global launcher shortcut without ever failing setup: try, retry once after `retry_delay`,
/// and on a second failure log and continue without the shortcut. Returns whether it is registered.
pub fn register_shortcut_non_fatal(
    mut register: impl FnMut() -> Result<(), String>,
    retry_delay: Duration,
    mut log: impl FnMut(String),
) -> bool {
    match register() {
        Ok(()) => true,
        Err(first) => {
            log(format!("Launcher shortcut registration failed ({first}); retrying once"));
            thread::sleep(retry_delay);
            match register() {
                Ok(()) => true,
                Err(second) => {
                    log(format!("Launcher shortcut unavailable ({second}); continuing without it"));
                    false
                }
            }
        }
    }
}

/// Tell an open webview that the update state changed. No payload: it must call `update_state`.
fn notify_update_state(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('neo:update-state'))");
    }
}

/// Run one check as a new generation and record its result in the shared state.
async fn run_update_check(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<UpdateCandidate>() else { return };
    let generation = state.0.lock().unwrap().begin_check();
    notify_update_state(app);
    let result = check_for_updates_internal(app).await;
    state.0.lock().unwrap().finish_check(generation, result);
    notify_update_state(app);
}

/// How to start the new version after a Linux update: the same executable selected for installation
/// (the AppImage file, or the real deb executable). Tauri's `restart()` would use its cached APPIMAGE.
#[derive(Debug, Clone, PartialEq)]
pub struct RelaunchPlan {
    pub program: PathBuf,
    /// A deb install must not pass an inherited APPIMAGE/APPDIR on to the new process.
    pub clear_appimage_env: bool,
}

pub fn relaunch_plan(target: &str, executable: &std::path::Path) -> RelaunchPlan {
    RelaunchPlan { program: executable.to_path_buf(), clear_appimage_env: !target.ends_with("-appimage") }
}

pub fn relaunch_command<I, S>(plan: &RelaunchPlan, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new(&plan.program);
    command.args(args);
    if plan.clear_appimage_env {
        command.env_remove("APPIMAGE").env_remove("APPDIR");
    }
    command
}

pub const PRODUCTION_UPDATER_ENDPOINT: &str =
    "https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json";

pub const PRODUCTION_ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// A stable candidate with strictly higher SemVer precedence. Build metadata is ignored, so
/// `1.2.3+1` is not newer than `1.2.3` (`>` on `semver::Version` would order build metadata).
pub fn is_valid_stable_update(current: &semver::Version, candidate: &semver::Version) -> bool {
    candidate.pre.is_empty() && candidate.cmp_precedence(current).is_gt()
}

pub fn is_valid_stable_update_str(current: &str, candidate: &str) -> bool {
    match (semver::Version::parse(current), semver::Version::parse(candidate)) {
        (Ok(cur), Ok(cand)) => is_valid_stable_update(&cur, &cand),
        _ => false,
    }
}

pub fn resolve_linux_target_for(arch: &str, is_appimage: bool) -> String {
    let pkg = if is_appimage { "appimage" } else { "deb" };
    format!("linux-{arch}-{pkg}")
}

/// The AppImage file to replace, only when this process really runs from it. The AppImage runtime
/// sets `APPIMAGE` (the image file) and `APPDIR` (its mount point) and starts the app from inside
/// `APPDIR`. An inherited or unrelated `APPIMAGE` (for example from a parent process started by an
/// AppImage) does not make a deb install an AppImage install.
pub fn appimage_for_exe(
    appimage: Option<&std::path::Path>,
    appdir: Option<&std::path::Path>,
    exe: &std::path::Path,
) -> Option<PathBuf> {
    let appimage = appimage.filter(|path| path.is_absolute())?;
    let appdir = appdir.filter(|path| path.is_absolute() && path.parent().is_some())?;
    if exe.starts_with(appdir) && !appimage.starts_with(appdir) {
        Some(appimage.to_path_buf())
    } else {
        None
    }
}

/// The Linux updater target and the executable the updater replaces: the AppImage file when the
/// running executable belongs to it, otherwise the real executable (deb).
pub fn resolve_linux_install(
    arch: &str,
    appimage: Option<&std::path::Path>,
    appdir: Option<&std::path::Path>,
    exe: &std::path::Path,
) -> (String, PathBuf) {
    match appimage_for_exe(appimage, appdir, exe) {
        Some(image) => (resolve_linux_target_for(arch, true), image),
        None => (resolve_linux_target_for(arch, false), exe.to_path_buf()),
    }
}

pub fn linux_updater_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "armv7"
    } else if cfg!(target_arch = "x86") {
        "i686"
    } else {
        "x86_64"
    }
}

fn validate_updater_endpoint(endpoint: &str, is_debug: bool) -> Result<(), String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err("Updater endpoint cannot be empty".into());
    }
    if !is_debug {
        if trimmed != PRODUCTION_UPDATER_ENDPOINT {
            return Err(format!(
                "Production updater endpoint must be '{PRODUCTION_UPDATER_ENDPOINT}', got '{trimmed}'"
            ));
        }
    } else if !trimmed.starts_with("https://") && !trimmed.starts_with("http://127.0.0.1:") && !trimmed.starts_with("http://localhost:") {
        return Err(format!("Updater endpoint must use HTTPS or loopback HTTP in debug builds: {endpoint}"));
    }
    Ok(())
}

fn resolve_allowed_hosts(
    endpoint_urls: &[url::Url],
    configured_hosts: &[String],
    is_debug: bool,
) -> Vec<String> {
    if !is_debug {
        return PRODUCTION_ALLOWED_HOSTS.iter().map(|s| s.to_string()).collect();
    }
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

    if let Ok(env_hosts) = std::env::var("NMH_UPDATER_ALLOWED_HOSTS") {
        for h in env_hosts.split(',') {
            let h_lower = h.trim().to_lowercase();
            if !h_lower.is_empty() && !hosts.contains(&h_lower) {
                hosts.push(h_lower);
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

pub fn evaluate_redirect_attempt(
    next_url: &url::Url,
    previous_count: usize,
    allowed_hosts: &[String],
    is_debug: bool,
) -> Result<(), String> {
    if !is_debug && next_url.scheme() != "https" {
        return Err(format!("Updater redirects must use HTTPS in release builds: {next_url}"));
    }
    if previous_count >= 5 {
        return Err("Too many updater redirects".to_string());
    }
    let next_host = next_url
        .host_str()
        .ok_or_else(|| format!("Updater redirect target has no host: {next_url}"))?;

    let is_allowed = allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(next_host));
    if !is_allowed {
        return Err(format!("Updater redirect to untrusted host '{next_host}' is forbidden"));
    }
    Ok(())
}

struct ConfiguredUpdater {
    builder: tauri_plugin_updater::UpdaterBuilder,
    allowed_hosts: Vec<String>,
    /// Linux only: how to start the installed version.
    #[allow(dead_code)]
    relaunch: Option<RelaunchPlan>,
}

fn configure_updater_builder(app: &tauri::AppHandle) -> Result<ConfiguredUpdater, String> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    #[allow(unused_mut)]
    let mut relaunch = None;

    // Linux package-specific target (linux-{arch}-appimage or linux-{arch}-deb) and the executable to
    // replace. The plugin's default trusts APPIMAGE alone; override both from the running executable.
    #[cfg(target_os = "linux")]
    {
        let exe = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
        let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_file());
        let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
        let (target, executable) =
            resolve_linux_install(linux_updater_arch(), appimage.as_deref(), appdir.as_deref(), &exe);
        relaunch = Some(relaunch_plan(&target, &executable));
        builder = builder.target(target).executable_path(executable);
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(target) = std::env::var("NMH_UPDATER_TARGET") {
            if !target.trim().is_empty() {
                builder = builder.target(target.trim());
            }
        }
    }

    // Version comparator: accept stable candidates with strictly greater SemVer precedence
    builder = builder.version_comparator(|current, release| {
        is_valid_stable_update(&current, &release.version)
    });

    // Windows / updater pre-exit callback: stop the Gateway sidecar before the installer launches, then
    // run the app's own cleanup (tray, webviews), which this hook replaces from the plugin's default.
    let app_handle_for_exit = app.clone();
    builder = builder.on_before_exit(move || {
        if let Some(state) = app_handle_for_exit.try_state::<GatewayState>() {
            if let Some(mut sidecar) = state.0.lock().unwrap().take() {
                sidecar.stop();
            }
        }
        app_handle_for_exit.cleanup_before_exit();
    });

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

    let allowed_hosts = resolve_allowed_hosts(&effective_endpoints, &configured_allowed_hosts, cfg!(debug_assertions));

    // Set Reqwest redirect policy: only HTTPS (in release) and target host in allowed_hosts
    let redirect_hosts = allowed_hosts.clone();
    builder = builder.configure_client(move |client_builder| {
        let hosts = redirect_hosts.clone();
        client_builder.redirect(reqwest::redirect::Policy::custom(move |attempt| {
            match evaluate_redirect_attempt(
                attempt.url(),
                attempt.previous().len(),
                &hosts,
                cfg!(debug_assertions),
            ) {
                Ok(()) => attempt.follow(),
                Err(err) => attempt.error(err),
            }
        }))
    });

    Ok(ConfiguredUpdater { builder, allowed_hosts, relaunch })
}

/// Fetch the feed and return the newer version, if any. Stores nothing: callers record the result in
/// UpdateCandidate under their generation.
async fn check_for_updates_internal(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let configured = configure_updater_builder(app)?;
    let updater = configured.builder.build().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    if let Some(ref update) = update {
        validate_update_download_url(&update.download_url, &configured.allowed_hosts, cfg!(debug_assertions))?;
    }
    Ok(update.map(|candidate| candidate.version))
}

/// Start a manual check. The result goes into the shared state only; the reply carries nothing to render.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Updates can only be checked from the main window".into());
    }
    run_update_check(&app).await;
    Ok(())
}

/// The current update state, straight from UpdateCandidate. Never contacts the network.
#[tauri::command]
fn update_state(app: tauri::AppHandle, window: tauri::Window) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Updates can only be read from the main window".into());
    }
    let state = app.try_state::<UpdateCandidate>().ok_or("Update state is not registered")?;
    let snapshot = state.0.lock().unwrap().snapshot();
    Ok(snapshot)
}

/// Install the current candidate. Failures are recorded in the shared state for the frontend to render.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Updates can only be installed from the main window".into());
    }
    let state = app.try_state::<UpdateCandidate>().ok_or("Update state is not registered")?;
    let candidate = state.0.lock().unwrap().begin_install()?;
    notify_update_state(&app);
    let result = install_candidate(&app, candidate).await;
    if let Err(error) = &result {
        state.0.lock().unwrap().fail_install(error.clone());
        notify_update_state(&app);
    }
    result
}

async fn install_candidate(app: &tauri::AppHandle, candidate: String) -> Result<(), String> {
    let app = app.clone();
    let ConfiguredUpdater { builder, allowed_hosts, relaunch } = configure_updater_builder(&app)?;
    let updater = builder.build().map_err(|error| error.to_string())?;
    if let Some(update) = updater.check().await.map_err(|error| error.to_string())? {
        if update.version != candidate {
            return Err(format!("Available update version ({}) does not match expected candidate ({candidate})", update.version));
        }
        let current_ver = app.package_info().version.clone();
        if let (Ok(cur), Ok(cand)) = (semver::Version::parse(&current_ver.to_string()), semver::Version::parse(&update.version)) {
            if !is_valid_stable_update(&cur, &cand) {
                return Err(format!("Update version {} is not a valid stable update over current version {}", update.version, current_ver));
            }
        }
        validate_update_download_url(&update.download_url, &allowed_hosts, cfg!(debug_assertions))?;
        update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
        if let Some(state) = app.try_state::<GatewayState>() {
            if let Some(mut sidecar) = state.0.lock().unwrap().take() {
                sidecar.stop();
            }
        }
        // Linux: start the executable that was just updated (AppImage file or deb executable), never
        // Tauri's cached APPIMAGE, then exit cleanly. Elsewhere Tauri's restart is correct.
        if let Some(plan) = relaunch {
            relaunch_command(&plan, std::env::args_os().skip(1))
                .spawn()
                .map_err(|error| format!("Update installed, but starting {} failed: {error}", plan.program.display()))?;
            app.exit(0);
            return Ok(());
        }
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
        .invoke_handler(tauri::generate_handler![check_for_updates, update_state, install_update])
        .setup(|app| {
            let data_dir = std::env::var_os("NMH_DESKTOP_DATA_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_data_dir())?;
            let (sidecar, port) = GatewaySidecar::launch(app.handle(), data_dir.clone())?;
            let gateway_pid = sidecar.child.id();
            app.manage(GatewayState(Mutex::new(Some(sidecar))));
            // Register every updater state before the startup check can finish.
            app.manage(UpdateCandidate::default());
            // The startup check takes its generation now, before any manual check can start, so every manual
            // check supersedes it. Its result lands only in UpdateCandidate; the webview reads update_state.
            let startup_generation = app.state::<UpdateCandidate>().0.lock().unwrap().begin_check();
            let app_handle_for_update = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = check_for_updates_internal(&app_handle_for_update).await;
                app_handle_for_update.state::<UpdateCandidate>().0.lock().unwrap().finish_check(startup_generation, result);
                notify_update_state(&app_handle_for_update);
            });

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
            // Non-fatal: after an update relaunch the old process may still hold the shortcut for a moment.
            // Retry once, then run without the launcher shortcut rather than abort setup.
            let shortcut_registered = register_shortcut_non_fatal(
                || {
                    app.global_shortcut()
                        .on_shortcut(shortcut.trim(), |app, _, event| {
                            if event.state() == ShortcutState::Pressed {
                                focus_main(app);
                            }
                        })
                        .map_err(|error| error.to_string())
                },
                SHORTCUT_RETRY_DELAY,
                |message| eprintln!("{message}"),
            );

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
                    serde_json::json!({ "port": port, "gatewayPid": gateway_pid, "appPid": std::process::id(), "trayReady": true, "deepLinks": ["neo://inbox/", "neo://coding/"], "shortcut": shortcut.trim(), "shortcutRegistered": shortcut_registered }).to_string(),
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



include!("pubkey_validator.rs");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_endpoint_https_enforcement() {
        assert!(validate_updater_endpoint("http://insecure.example.com/latest.json", false).is_err());
        assert!(validate_updater_endpoint("https://secure.example.com/latest.json", false).is_err());
        assert!(validate_updater_endpoint(PRODUCTION_UPDATER_ENDPOINT, false).is_ok());
        assert!(validate_updater_endpoint("http://127.0.0.1:8080/latest.json", true).is_ok());
        assert!(validate_updater_endpoint("", false).is_err());
    }

    #[test]
    fn test_endpoint_production_pin() {
        assert!(validate_updater_endpoint(PRODUCTION_UPDATER_ENDPOINT, false).is_ok());
        assert!(validate_updater_endpoint("https://attacker.com/latest.json", false).is_err());
        assert!(validate_updater_endpoint("https://github.com/OtherOrg/repo/releases/latest/download/latest.json", false).is_err());
    }

    #[test]
    fn test_resolve_allowed_hosts_github_defaults() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let hosts = resolve_allowed_hosts(&ep, &[], true);
        assert!(hosts.contains(&"github.com".to_string()));
        assert!(hosts.contains(&"objects.githubusercontent.com".to_string()));
        assert!(hosts.contains(&"release-assets.githubusercontent.com".to_string()));
        assert!(!hosts.contains(&"attacker.com".to_string()));
    }

    #[test]
    fn test_resolve_allowed_hosts_production_pin() {
        let ep = vec![url::Url::parse("https://evil.com/latest.json").unwrap()];
        let evil_hosts = vec!["evil.com".to_string(), "attacker.com".to_string()];
        let hosts = resolve_allowed_hosts(&ep, &evil_hosts, false);
        assert_eq!(hosts, vec!["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
    }

    #[test]
    fn test_version_comparator() {
        // Pre-release must be rejected over stable release
        assert!(!is_valid_stable_update_str("0.1.0", "0.2.0-rc.1"));
        assert!(!is_valid_stable_update_str("0.2.0", "0.2.0-rc.1"));
        assert!(!is_valid_stable_update_str("0.1.0", "0.1.0-alpha"));
        // Equal version must be rejected
        assert!(!is_valid_stable_update_str("0.1.0", "0.1.0"));
        // Lower version must be rejected
        assert!(!is_valid_stable_update_str("0.1.0", "0.0.9"));
        assert!(!is_valid_stable_update_str("1.0.0", "0.9.9"));
        // Greater stable version must be accepted
        assert!(is_valid_stable_update_str("0.1.0", "0.2.0"));
        assert!(is_valid_stable_update_str("0.1.0", "0.1.1"));
        assert!(is_valid_stable_update_str("0.1.0", "1.0.0"));
    }

    #[test]
    fn test_version_comparator_ignores_build_metadata() {
        // Build metadata has no precedence: same version, different build is not an update.
        assert!(!is_valid_stable_update_str("1.2.3", "1.2.3+1"));
        assert!(!is_valid_stable_update_str("1.2.3", "1.2.3+build.99"));
        assert!(!is_valid_stable_update_str("1.2.3+5", "1.2.3+1"));
        assert!(!is_valid_stable_update_str("1.2.3+1", "1.2.3"));
        assert!(!is_valid_stable_update_str("1.2.3", "1.2.2+999"));
        // A real increase still passes, with or without metadata.
        assert!(is_valid_stable_update_str("1.2.3", "1.2.4+1"));
        assert!(is_valid_stable_update_str("1.2.3+7", "1.2.4"));
        assert!(!is_valid_stable_update_str("1.2.3", "1.2.4-rc.1+1"));
    }

    #[test]
    fn test_linux_install_appimage_only_when_exe_is_inside_it() {
        use std::path::{Path, PathBuf};
        // Absolute on every host OS (the logic runs on Linux; tests also run on Windows).
        let abs = |p: &str| PathBuf::from(if cfg!(windows) { format!("C:{p}") } else { p.to_string() });
        let image = &abs("/home/u/Apps/Neo.AppImage");
        let mount = &abs("/tmp/.mount_NeoAbc");
        let mounted_exe = &abs("/tmp/.mount_NeoAbc/usr/bin/neo-meta-harness");
        let deb_exe = &abs("/usr/bin/neo-meta-harness");

        // Running from the AppImage: AppImage target, replace the image file.
        assert_eq!(
            resolve_linux_install("x86_64", Some(image), Some(mount), mounted_exe),
            ("linux-x86_64-appimage".to_string(), image.to_path_buf())
        );
        // Inherited APPIMAGE/APPDIR from another AppImage: the deb exe is not inside the mount.
        assert_eq!(
            resolve_linux_install("x86_64", Some(image), Some(mount), deb_exe),
            ("linux-x86_64-deb".to_string(), deb_exe.to_path_buf())
        );
        // APPIMAGE alone (no APPDIR) is not enough.
        assert_eq!(
            resolve_linux_install("x86_64", Some(image), None, deb_exe),
            ("linux-x86_64-deb".to_string(), deb_exe.to_path_buf())
        );
        assert_eq!(appimage_for_exe(Some(image), None, mounted_exe), None);
        // No AppImage variables at all: deb with the real executable.
        assert_eq!(
            resolve_linux_install("aarch64", None, None, deb_exe),
            ("linux-aarch64-deb".to_string(), deb_exe.to_path_buf())
        );
        // Relative or root paths, or an image inside its own mount, are rejected.
        assert_eq!(appimage_for_exe(Some(Path::new("Neo.AppImage")), Some(mount), mounted_exe), None);
        assert_eq!(appimage_for_exe(Some(image), Some(abs("/").as_path()), deb_exe), None);
        assert_eq!(appimage_for_exe(Some(image), Some(Path::new(".mount_NeoAbc")), mounted_exe), None);
        assert_eq!(
            appimage_for_exe(Some(abs("/tmp/.mount_NeoAbc/x.AppImage").as_path()), Some(mount), mounted_exe),
            None
        );
        // A sibling directory that only shares a name prefix is not the mount.
        assert_eq!(
            appimage_for_exe(Some(image), Some(mount), abs("/tmp/.mount_NeoAbcd/usr/bin/neo-meta-harness").as_path()),
            None
        );
    }

    #[test]
    fn test_update_state_transitions() {
        let mut state = CandidateState::default();
        let snap = state.snapshot();
        assert_eq!(snap["generation"], 0);
        assert_eq!(snap["available"], false);
        assert_eq!(snap["checking"], false);

        // Check finds a version: checking, then available with that version.
        let g = state.begin_check();
        assert_eq!(state.snapshot()["checking"], true);
        assert_eq!(state.snapshot()["generation"], 1);
        assert!(state.finish_check(g, Ok(Some("1.2.4".into()))));
        let snap = state.snapshot();
        assert_eq!(snap["available"], true);
        assert_eq!(snap["version"], "1.2.4");
        assert_eq!(snap["checking"], false);

        // A failed check clears the candidate and records the error.
        let g = state.begin_check();
        assert!(state.finish_check(g, Err("offline".into())));
        assert_eq!(state.version(), None);
        assert_eq!(state.snapshot()["error"], "offline");

        // Install: only with a candidate, not twice, and a failure is recorded.
        assert!(state.begin_install().is_err());
        let g = state.begin_check();
        state.finish_check(g, Ok(Some("1.2.5".into())));
        assert_eq!(state.begin_install().unwrap(), "1.2.5");
        assert_eq!(state.snapshot()["installing"], true);
        assert!(state.begin_install().is_err(), "no second install while one runs");
        state.fail_install("disk full".into());
        let snap = state.snapshot();
        assert_eq!(snap["installing"], false);
        assert_eq!(snap["error"], "Installation failed: disk full");
        assert_eq!(state.version(), Some("1.2.5".into()), "a failed install keeps the candidate");

        // Every mutation bumps the revision.
        let before = state.snapshot()["revision"].as_u64().unwrap();
        state.begin_check();
        assert!(state.snapshot()["revision"].as_u64().unwrap() > before);
    }

    #[test]
    fn test_out_of_order_replies_never_restore_stale_state() {
        // Startup check (g1) and two manual checks (g2, g3) all in flight; replies land in the worst order.
        let mut state = CandidateState::default();
        let startup = state.begin_check();
        let older_manual = state.begin_check();
        let newer_manual = state.begin_check();
        assert!(state.finish_check(newer_manual, Ok(None)), "newest check applies: nothing to install");
        assert!(!state.finish_check(older_manual, Ok(Some("1.2.5".into()))), "older manual reply cannot restore Install");
        assert!(!state.finish_check(startup, Ok(Some("1.2.4".into()))), "late startup result cannot restore Install");
        let snap = state.snapshot();
        assert_eq!(snap["available"], false);
        assert_eq!(snap["checking"], false);
        assert_eq!(snap["generation"], 3);
        assert!(state.begin_install().is_err());

        // The reverse: the newest sets a candidate; a stale "no update" or error cannot clear it.
        let mut state = CandidateState::default();
        let startup = state.begin_check();
        let manual = state.begin_check();
        assert!(state.finish_check(manual, Ok(Some("1.2.6".into()))));
        assert!(!state.finish_check(startup, Ok(None)));
        assert!(!state.finish_check(startup, Err("timeout".into())));
        assert_eq!(state.version(), Some("1.2.6".into()));
        assert_eq!(state.snapshot()["error"], serde_json::Value::Null);

        // A stale reply also leaves "checking" to the check that is still running.
        let mut state = CandidateState::default();
        let startup = state.begin_check();
        let _running = state.begin_check();
        assert!(!state.finish_check(startup, Ok(Some("1.2.4".into()))));
        assert_eq!(state.snapshot()["checking"], true);

        // The manual command goes through a generation and replies with nothing to render.
        let lib_rs = include_str!("lib.rs");
        let manual_cmd = &lib_rs[lib_rs.find("async fn check_for_updates(").unwrap()..];
        let manual_cmd = &manual_cmd[..manual_cmd.find("\n}\n").unwrap()];
        assert!(manual_cmd.contains("run_update_check(&app).await") && manual_cmd.contains("Result<(), String>"));
        assert!(lib_rs.contains(concat!("generate_handler![check_for_updates, ", "update_state, install_update]")));
    }

    #[test]
    fn test_shortcut_registration_is_non_fatal() {
        let mut logs = Vec::new();
        // Held by the old process on both attempts: setup continues without the shortcut.
        let mut attempts = 0;
        let registered = register_shortcut_non_fatal(
            || {
                attempts += 1;
                Err("HotKey already registered".into())
            },
            Duration::from_millis(1),
            |m| logs.push(m),
        );
        assert!(!registered);
        assert_eq!(attempts, 2, "one retry");
        assert!(logs.last().unwrap().contains("continuing without it"));

        // Released by the old process before the retry: registered on the second attempt.
        let mut attempts = 0;
        let registered = register_shortcut_non_fatal(
            || {
                attempts += 1;
                if attempts == 1 { Err("busy".into()) } else { Ok(()) }
            },
            Duration::from_millis(1),
            |_| {},
        );
        assert!(registered);
        assert_eq!(attempts, 2);

        // Free: registered first time, nothing logged.
        let mut logs = Vec::new();
        assert!(register_shortcut_non_fatal(|| Ok(()), Duration::from_millis(1), |m| logs.push(m)));
        assert!(logs.is_empty());
    }

    #[test]
    fn test_relaunch_uses_the_selected_executable() {
        use std::ffi::OsStr;
        use std::path::PathBuf;
        let abs = |p: &str| PathBuf::from(if cfg!(windows) { format!("C:{p}") } else { p.to_string() });
        let image = abs("/home/u/Apps/Neo.AppImage");
        let mount = abs("/tmp/.mount_NeoAbc");
        let deb_exe = abs("/usr/bin/neo-meta-harness");
        let envs = |command: &Command| -> Vec<(String, Option<String>)> {
            command
                .get_envs()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
                .collect()
        };

        // Deb install with an inherited APPIMAGE/APPDIR: relaunch the real executable, and clear both.
        let (target, executable) =
            resolve_linux_install("x86_64", Some(image.as_path()), Some(mount.as_path()), &deb_exe);
        let plan = relaunch_plan(&target, &executable);
        assert_eq!(plan, RelaunchPlan { program: deb_exe.clone(), clear_appimage_env: true });
        let command = relaunch_command(&plan, ["--flag"]);
        assert_eq!(command.get_program(), deb_exe.as_os_str());
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![OsStr::new("--flag")]);
        let removed = envs(&command);
        assert!(removed.contains(&("APPIMAGE".into(), None)) && removed.contains(&("APPDIR".into(), None)));

        // AppImage install: relaunch the AppImage file that was replaced, environment untouched.
        let mounted_exe = abs("/tmp/.mount_NeoAbc/usr/bin/neo-meta-harness");
        let (target, executable) =
            resolve_linux_install("x86_64", Some(image.as_path()), Some(mount.as_path()), &mounted_exe);
        let plan = relaunch_plan(&target, &executable);
        assert_eq!(plan, RelaunchPlan { program: image.clone(), clear_appimage_env: false });
        let command = relaunch_command(&plan, Vec::<&OsStr>::new());
        assert_eq!(command.get_program(), image.as_os_str());
        assert!(envs(&command).is_empty());

        // No AppImage variables at all: deb, with the environment cleared.
        let (target, executable) = resolve_linux_install("aarch64", None, None, &deb_exe);
        assert!(relaunch_plan(&target, &executable).clear_appimage_env);

        // The install path relaunches through the plan, then exits, instead of Tauri's restart.
        let lib_rs = include_str!("lib.rs");
        let install = &lib_rs[lib_rs.find("async fn install_update(").unwrap()..];
        let install = &install[..install.find("\nstruct GatewaySidecar").unwrap()];
        assert!(install.find("relaunch_command(&plan").unwrap() < install.find("app.restart()").unwrap());
        assert!(install.find("relaunch_command(&plan").unwrap() < install.find("app.exit(0)").unwrap());
    }

    #[test]
    fn test_release_key_source_must_be_checked_in() {
        let real = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let other = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQ0KUldSUFYwNUZVa3RGV1ZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGENCg==";
        assert!(validate_release_key_source(Some(real), Some(real)).is_ok());
        // TAURI_CONFIG-only key over the checked-in placeholder, or a different real key: refused.
        let err = validate_release_key_source(Some("REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY"), Some(real)).unwrap_err();
        assert!(err.contains("differs from the key checked in"));
        assert!(validate_release_key_source(Some(real), Some(other)).is_err());
        assert!(validate_release_key_source(None, Some(real)).is_err());
        assert!(validate_release_key_source(Some(real), None).is_err());
        // build.rs takes the checked-in key before merging TAURI_CONFIG, then enforces the source rule.
        let build_rs = include_str!("../build.rs");
        assert!(build_rs.contains("validate_release_key_source(checked_in_pubkey.as_deref(), Some(pubkey))"));
        assert!(build_rs.find("let checked_in_pubkey").unwrap() < build_rs.find("std::env::var(\"TAURI_CONFIG\")").unwrap());
    }

    #[test]
    fn test_startup_state_registered_before_check_and_exit_hook_cleans_up() {
        let lib_rs = include_str!("lib.rs");
        let setup = &lib_rs[lib_rs.find(".setup(|app|").unwrap()..];
        let candidate = setup.find("app.manage(UpdateCandidate::default())").unwrap();
        let begin = setup.find(".begin_check();").unwrap();
        let spawn = setup.find("check_for_updates_internal(&app_handle_for_update)").unwrap();
        assert!(candidate < begin && begin < spawn, "state is managed and the startup generation taken before the check starts");
        assert!(!lib_rs.contains(concat!("startup_update", "_status")), "the startup cache command is gone");
        // Shortcut registration never aborts setup.
        let registration = &setup[setup.find("register_shortcut_non_fatal(").unwrap()..];
        let registration = &registration[..registration.find(");\n").unwrap()];
        assert!(!registration.contains(")?"), "shortcut registration must not use ? in setup");
        let hook = &lib_rs[lib_rs.find("builder.on_before_exit(move ||").unwrap()..];
        let hook = &hook[..hook.find("});").unwrap()];
        assert!(hook.find("sidecar.stop()").unwrap() < hook.find("cleanup_before_exit()").unwrap());
    }

    #[test]
    fn test_linux_updater_targets() {
        assert_eq!(resolve_linux_target_for("x86_64", true), "linux-x86_64-appimage");
        assert_eq!(resolve_linux_target_for("x86_64", false), "linux-x86_64-deb");
        assert_eq!(resolve_linux_target_for("aarch64", true), "linux-aarch64-appimage");
        assert_eq!(resolve_linux_target_for("aarch64", false), "linux-aarch64-deb");
    }

    #[test]
    fn test_download_url_validation_with_allowed_hosts() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &["updates.custom.com".to_string()], true);

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
    fn test_redirect_policy_allowed_host_chain() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &[], false);

        // Initial request host: github.com
        let url0 = url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/download/v0.2.0/app.zip").unwrap();
        assert!(evaluate_redirect_attempt(&url0, 0, &allowed_hosts, false).is_ok());

        // Redirect 1: objects.githubusercontent.com
        let url1 = url::Url::parse("https://objects.githubusercontent.com/github-production-release-asset-2e6506/12345").unwrap();
        assert!(evaluate_redirect_attempt(&url1, 1, &allowed_hosts, false).is_ok());

        // Redirect 2: release-assets.githubusercontent.com
        let url2 = url::Url::parse("https://release-assets.githubusercontent.com/asset-download-url").unwrap();
        assert!(evaluate_redirect_attempt(&url2, 2, &allowed_hosts, false).is_ok());

        // Further hops within allowed hosts below limit
        assert!(evaluate_redirect_attempt(&url1, 3, &allowed_hosts, false).is_ok());
        assert!(evaluate_redirect_attempt(&url2, 4, &allowed_hosts, false).is_ok());
    }

    #[test]
    fn test_redirect_policy_untrusted_host() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &[], false);

        // External attacker host
        let untrusted1 = url::Url::parse("https://attacker.com/fake-release.zip").unwrap();
        assert!(evaluate_redirect_attempt(&untrusted1, 1, &allowed_hosts, false).is_err());
        assert!(evaluate_redirect_attempt(&untrusted1, 1, &allowed_hosts, true).is_err());

        // Subdomain attack on github.com
        let untrusted_subdomain = url::Url::parse("https://github.com.attacker.com/fake.zip").unwrap();
        assert!(evaluate_redirect_attempt(&untrusted_subdomain, 1, &allowed_hosts, false).is_err());
    }

    #[test]
    fn test_redirect_policy_http_enforcement() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &[], false);

        let http_url = url::Url::parse("http://objects.githubusercontent.com/asset.zip").unwrap();
        // In release builds, HTTP redirect must be rejected
        assert!(evaluate_redirect_attempt(&http_url, 1, &allowed_hosts, false).is_err());
        // In debug/test builds, HTTP is allowed for local test fixtures
        assert!(evaluate_redirect_attempt(&http_url, 1, &allowed_hosts, true).is_ok());
    }

    #[test]
    fn test_redirect_policy_more_than_5_hops() {
        let ep = vec![url::Url::parse("https://github.com/NeoMetaHarness/NeoMetaHarness/releases/latest/download/latest.json").unwrap()];
        let allowed_hosts = resolve_allowed_hosts(&ep, &[], false);
        let valid_url = url::Url::parse("https://objects.githubusercontent.com/asset.zip").unwrap();

        // 4 previous redirects (attempting 5th request) -> OK
        assert!(evaluate_redirect_attempt(&valid_url, 4, &allowed_hosts, false).is_ok());

        // 5 previous redirects (attempting 6th request) -> Error (> 5 hops)
        assert!(evaluate_redirect_attempt(&valid_url, 5, &allowed_hosts, false).is_err());
        assert!(evaluate_redirect_attempt(&valid_url, 6, &allowed_hosts, false).is_err());
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

    #[test]
    fn test_validate_minisign_pubkey_valid() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        assert!(validate_minisign_pubkey(valid_key).is_ok());
    }

    #[test]
    fn test_validate_minisign_pubkey_accepted_crlf() {
        let valid_crlf = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQ0KUldSUFYwNUZVa3RGV1ZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGENCg==";
        assert!(validate_minisign_pubkey(valid_crlf).is_ok());
    }

    #[test]
    fn test_validate_minisign_pubkey_test_key_rejected() {
        let test_key = "dW50cnVzdGVkIGNvbW1lbnQ6IE5FTyBURVNUIEtFWSAtIERPIE5PVCBTSElQClJXUlVSVk5VUzBWWk1WcGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhCg==";
        let err = validate_minisign_pubkey(test_key).unwrap_err();
        assert!(err.contains("test public key with ID 'TESTKEY1' must not ship in a release build"));
    }

    #[test]
    fn test_validate_minisign_pubkey_empty_line2() {
        let empty_line2 = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQoK";
        let err = validate_minisign_pubkey(empty_line2).unwrap_err();
        assert!(err.contains("line 2 is empty"));
    }

    #[test]
    fn test_validate_minisign_pubkey_two_trailing_newlines() {
        let two_trailing = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQoK";
        let err = validate_minisign_pubkey(two_trailing).unwrap_err();
        assert!(err.contains("must have exactly 2 lines"));
    }

    #[test]
    fn test_validate_minisign_pubkey_bad_length_32() {
        let bad_len_32 = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xvPQo=";
        let err = validate_minisign_pubkey(bad_len_32).unwrap_err();
        assert!(err.contains("must decode to exactly 42 bytes, got 32"));
    }

    #[test]
    fn test_validate_minisign_pubkey_data_after_eq() {
        let data_after_eq = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JTVDFkT1JWSkxSVmxhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2w9QQo=";
        let err = validate_minisign_pubkey(data_after_eq).unwrap_err();
        assert!(err.contains("invalid character after '='"));
    }

    #[test]
    fn test_validate_minisign_pubkey_bom_rejected() {
        let bom_key = "77u/dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let err = validate_minisign_pubkey(bom_key).unwrap_err();
        assert!(err.contains("first line must start with 'untrusted comment:'"));
    }

    #[test]
    fn test_validate_minisign_pubkey_wrapped_outer_rejected() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let wrapped = format!("{}\n{}", &valid_key[..32], &valid_key[32..]);
        let err = validate_minisign_pubkey(&wrapped).unwrap_err();
        assert!(err.contains("invalid character in base64"));
    }

    #[test]
    fn test_validate_minisign_pubkey_unused_bits_outer_rejected() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let unused_bits = format!("{}YQp=", &valid_key[..valid_key.len() - 4]);
        let err = validate_minisign_pubkey(&unused_bits).unwrap_err();
        assert!(err.contains("nonzero unused padding bits"));
    }

    #[test]
    fn test_validate_minisign_pubkey_unused_bits_inner_rejected() {
        let inner_unused_bits = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwPQo=";
        let err = validate_minisign_pubkey(inner_unused_bits).unwrap_err();
        assert!(err.contains("nonzero unused padding bits"));
    }

    #[test]
    fn test_validate_minisign_pubkey_vertical_tab_rejected() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let vt_key = format!("\x0b{}", valid_key);
        let err = validate_minisign_pubkey(&vt_key).unwrap_err();
        assert!(err.contains("invalid character in base64"));
    }

    #[test]
    fn test_validate_minisign_pubkey_trailing_newline_rejected() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let trailing_nl = format!("{}\n", valid_key);
        let err = validate_minisign_pubkey(&trailing_nl).unwrap_err();
        assert!(err.contains("invalid character in base64"));
    }

    #[test]
    fn test_validate_minisign_pubkey_leading_whitespace_rejected() {
        let valid_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=";
        let leading_space = format!(" {}", valid_key);
        let err_space = validate_minisign_pubkey(&leading_space).unwrap_err();
        assert!(err_space.contains("invalid character in base64"));

        let leading_tab = format!("\t{}", valid_key);
        let err_tab = validate_minisign_pubkey(&leading_tab).unwrap_err();
        assert!(err_tab.contains("invalid character in base64"));
    }

    #[test]
    fn test_validate_minisign_pubkey_space_before_key_line_rejected() {
        // Line 2 has leading space inside decoded file
        let space_before_key = "dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQogUldSUFYwNUZVa3RGV1ZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK";
        let err = validate_minisign_pubkey(space_before_key).unwrap_err();
        assert!(err.contains("minisign public key line 2 is not valid base64"));
        assert!(err.contains("invalid character in base64"));
    }


    #[test]
    fn test_validate_minisign_pubkey_placeholder() {
        assert!(validate_minisign_pubkey("REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY").is_err());
    }

    #[test]
    fn test_validate_minisign_pubkey_empty() {
        assert!(validate_minisign_pubkey("   ").is_err());
    }

    #[test]
    fn test_validate_minisign_pubkey_malformed_surface_base64() {
        let surface_b64 = "dGhpcyBpcyBhIHN1cmZhY2UtdmFsaWQgYmFzZTY0IHN0cmluZyB0aGF0IGlzIG5vdCBhIG1pbmlzaWduIGtleSBhdCBhbGw=";
        assert!(validate_minisign_pubkey(surface_b64).is_err());
    }

    #[test]
    fn test_validate_minisign_pubkey_wrong_algorithm() {
        let bad_alg = "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QKV0ZoVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK";
        let err = validate_minisign_pubkey(bad_alg).unwrap_err();
        assert!(err.contains("algorithm ID must be 'Ed'"));
    }

    #[test]
    fn test_validate_minisign_pubkey_third_line() {
        let third_line = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkKUldSVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEKZXh0cmEgdGhpcmQgbGluZQo=";
        let err = validate_minisign_pubkey(third_line).unwrap_err();
        assert!(err.contains("must have exactly 2 lines"));
    }

    #[test]
    fn test_validate_minisign_pubkey_invalid_utf8() {
        let invalid_utf8 = "//79/A==";
        let err = validate_minisign_pubkey(invalid_utf8).unwrap_err();
        assert!(err.contains("not valid UTF-8"));
    }

    #[test]
    fn test_shared_pubkey_validator_included() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let build_rs = std::fs::read_to_string(std::path::Path::new(manifest_dir).join("build.rs")).unwrap_or_default();
        let lib_rs = std::fs::read_to_string(std::path::Path::new(manifest_dir).join("src/lib.rs")).unwrap_or_default();
        assert!(build_rs.contains(r#"include!("src/pubkey_validator.rs");"#));
        assert!(lib_rs.contains(r#"include!("pubkey_validator.rs");"#));
    }

}
