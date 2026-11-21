fn validate_release_config() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let base_conf_path = std::path::Path::new(&manifest_dir).join("tauri.conf.json");

    // Attempt to load base tauri.conf.json
    let base_content = match std::fs::read_to_string(&base_conf_path) {
        Ok(c) => c,
        Err(e) => {
            panic!(
                "Release build failed closed: unable to read base config at {}: {}",
                base_conf_path.display(),
                e
            );
        }
    };

    let mut config: serde_json::Value = match serde_json::from_str(&base_content) {
        Ok(v) => v,
        Err(e) => {
            panic!(
                "Release build failed closed: invalid JSON in base config {}: {}",
                base_conf_path.display(),
                e
            );
        }
    };

    // If TAURI_CONFIG or TAURI_ENV_CONFIG is set in environment, parse and merge it.
    // If either env var is present, it MUST be valid JSON (fail closed on malformed config).
    let env_config_str = std::env::var("TAURI_CONFIG").or_else(|_| std::env::var("TAURI_ENV_CONFIG"));
    if let Ok(ref raw) = env_config_str {
        let override_val: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                panic!(
                    "Release build failed closed: unresolvable updater configuration (invalid JSON in TAURI_CONFIG): {}",
                    e
                );
            }
        };

        if let Some(updater_override) = override_val.pointer("/plugins/updater") {
            if let Some(updater_obj) = config.pointer_mut("/plugins/updater") {
                if let (Some(dest), Some(src)) = (updater_obj.as_object_mut(), updater_override.as_object()) {
                    for (k, v) in src {
                        dest.insert(k.clone(), v.clone());
                    }
                }
            } else if let Some(plugins_obj) = config.pointer_mut("/plugins") {
                if let Some(dest) = plugins_obj.as_object_mut() {
                    dest.insert("updater".to_string(), updater_override.clone());
                }
            }
        } else if override_val.pointer("/plugins").is_some() && override_val.pointer("/plugins/updater").is_none() {
            if let Some(plugins_obj) = config.pointer_mut("/plugins") {
                if let Some(dest) = plugins_obj.as_object_mut() {
                    dest.remove("updater");
                }
            }
        }
    }

    // Validate updater configuration
    let updater = match config.pointer("/plugins/updater") {
        Some(u) => u,
        None => {
            panic!("Release build failed closed: plugins.updater configuration is absent");
        }
    };

    let pubkey = match updater.get("pubkey").and_then(|v| v.as_str()) {
        Some(k) => k.trim(),
        None => {
            panic!("Release build failed closed: plugins.updater.pubkey is missing");
        }
    };

    if pubkey.is_empty() {
        panic!("Release build failed closed: updater public key cannot be empty in a release build");
    }

    if pubkey == "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY" {
        panic!(
            "Release build failed closed: placeholder updater public key REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY must not ship in a release build! Provide owner key via --config or TAURI_CONFIG."
        );
    }

    if pubkey.len() < 40 || !pubkey.chars().all(|c| c.is_alphanumeric() || c == '+' || c == '/' || c == '=' || c.is_whitespace()) {
        panic!("Release build failed closed: updater public key is not a valid base64 minisign public key");
    }
}

fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        validate_release_config();
    }
    tauri_build::build()
}
