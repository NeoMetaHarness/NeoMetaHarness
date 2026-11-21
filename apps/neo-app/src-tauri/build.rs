fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        // If TAURI_CONFIG is set in environment (by Tauri CLI during tauri build/bundle),
        // verify that the effective merged configuration does not contain the placeholder public key.
        if let Ok(tauri_config) = std::env::var("TAURI_CONFIG").or_else(|_| std::env::var("TAURI_ENV_CONFIG")) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&tauri_config) {
                if let Some(updater) = json.pointer("/plugins/updater") {
                    let pubkey = updater.get("pubkey").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if pubkey.is_empty() || pubkey == "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY" {
                        panic!(
                            "Release build cannot ship with placeholder or empty updater public key! Provide owner key via --config."
                        );
                    }
                }
            }
        }
    }
    tauri_build::build()
}
