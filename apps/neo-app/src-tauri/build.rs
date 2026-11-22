include!("src/pubkey_validator.rs");

const ALT_CONFIGS: &[&str] = &[
    // JSON platform variants
    "tauri.windows.conf.json",
    "tauri.macos.conf.json",
    "tauri.linux.conf.json",
    "tauri.android.conf.json",
    "tauri.ios.conf.json",
    // JSON5 base and platform variants
    "tauri.conf.json5",
    "tauri.windows.conf.json5",
    "tauri.macos.conf.json5",
    "tauri.linux.conf.json5",
    "tauri.android.conf.json5",
    "tauri.ios.conf.json5",
    // TOML base and platform variants (Tauri.<platform>.toml and tauri.<platform>.toml)
    "Tauri.toml",
    "Tauri.windows.toml",
    "Tauri.macos.toml",
    "Tauri.linux.toml",
    "Tauri.android.toml",
    "Tauri.ios.toml",
    "tauri.toml",
    "tauri.windows.toml",
    "tauri.macos.toml",
    "tauri.linux.toml",
    "tauri.android.toml",
    "tauri.ios.toml",
];

fn json_merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
    if let serde_json::Value::Object(patch_obj) = patch {
        if !target.is_object() {
            *target = serde_json::Value::Object(serde_json::Map::new());
        }
        let target_obj = target.as_object_mut().unwrap();
        for (key, value) in patch_obj {
            if value.is_null() {
                target_obj.remove(key);
            } else {
                json_merge_patch(
                    target_obj.entry(key).or_insert(serde_json::Value::Null),
                    value,
                );
            }
        }
    } else {
        *target = patch.clone();
    }
}

fn validate_release_config() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());

    // Check for unsupported alternate config files that would bypass or conflict with tauri.conf.json
    for alt in ALT_CONFIGS {
        let p = std::path::Path::new(&manifest_dir).join(alt);
        if p.exists() {
            panic!(
                "Release build failed closed: alternate config file {} exists but is not supported for release validation; merge into tauri.conf.json or pass a release --config file",
                alt
            );
        }
    }

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

    // If TAURI_ENV_CONFIG is set, fail closed: Tauri tooling only reads TAURI_CONFIG
    if std::env::var_os("TAURI_ENV_CONFIG").is_some() {
        panic!("Release build failed closed: TAURI_ENV_CONFIG is not supported by Tauri; use TAURI_CONFIG instead");
    }

    // If TAURI_CONFIG is set in environment, parse and merge it via JSON merge patch.
    // If present, it MUST be valid JSON (fail closed on malformed config).
    if let Ok(ref raw) = std::env::var("TAURI_CONFIG") {
        let override_val: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                panic!(
                    "Release build failed closed: unresolvable updater configuration (invalid JSON in TAURI_CONFIG): {}",
                    e
                );
            }
        };
        json_merge_patch(&mut config, &override_val);
    }

    // Validate updater configuration
    let updater = match config.pointer("/plugins/updater") {
        Some(u) => u,
        None => {
            panic!("Release build failed closed: plugins.updater configuration is absent");
        }
    };

    let pubkey = match updater.get("pubkey").and_then(|v| v.as_str()) {
        Some(k) => k,
        None => {
            panic!("Release build failed closed: plugins.updater.pubkey is missing");
        }
    };

    if let Err(e) = validate_minisign_pubkey(pubkey) {
        panic!("Release build failed closed: {}", e);
    }
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());

    println!("cargo:rerun-if-env-changed=TAURI_ENV_CONFIG");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed={}", manifest_dir);
    for alt in ALT_CONFIGS {
        let p = std::path::Path::new(&manifest_dir).join(alt);
        println!("cargo:rerun-if-changed={}", p.display());
    }

    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        validate_release_config();
    }
    tauri_build::build()
}
