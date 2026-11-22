fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut clean: Vec<u8> = Vec::new();
    for b in input.bytes() {
        if !b.is_ascii_whitespace() {
            clean.push(b);
        }
    }
    if clean.is_empty() || clean.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < clean.len() {
        let chunk = &clean[i..i + 4];
        let mut vals = [0u32; 4];
        let mut pad_count = 0;
        for (j, &c) in chunk.iter().enumerate() {
            vals[j] = match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a' + 26) as u32,
                b'0'..=b'9' => (c - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    pad_count += 1;
                    0
                }
                _ => return Err(format!("invalid base64 character: {}", c as char)),
            };
        }
        if pad_count > 2 || (pad_count > 0 && i + 4 != clean.len()) {
            return Err("invalid base64 padding".to_string());
        }
        let triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
        out.push(((triple >> 16) & 0xff) as u8);
        if pad_count < 2 {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if pad_count < 1 {
            out.push((triple & 0xff) as u8);
        }
        i += 4;
    }
    Ok(out)
}

fn validate_minisign_pubkey(pubkey: &str) -> Result<(), String> {
    let trimmed = pubkey.trim();
    if trimmed.is_empty() {
        return Err("updater public key cannot be empty in a release build".to_string());
    }
    if trimmed == "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY" {
        return Err(
            "placeholder updater public key REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY must not ship in a release build! Provide owner key via --config or TAURI_CONFIG."
                .to_string(),
        );
    }

    let outer_bytes = base64_decode(trimmed)
        .map_err(|e| format!("updater public key is not valid base64: {}", e))?;

    let file_content = String::from_utf8(outer_bytes)
        .map_err(|e| format!("updater public key decoded bytes are not valid UTF-8: {}", e))?;

    let body = if let Some(s) = file_content.strip_suffix("\r\n") {
        s
    } else if let Some(s) = file_content.strip_suffix('\n') {
        s
    } else {
        file_content.as_str()
    };

    let lines: Vec<&str> = body
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();

    if lines.len() != 2 {
        return Err(format!(
            "minisign public key file must have exactly 2 lines, got {}",
            lines.len()
        ));
    }

    let line1 = lines[0].trim();
    if !line1.starts_with("untrusted comment:") {
        return Err("minisign public key first line must start with 'untrusted comment:'".to_string());
    }

    let line2 = lines[1].trim();
    let key_bytes = base64_decode(line2)
        .map_err(|e| format!("minisign public key line 2 is not valid base64: {}", e))?;

    if key_bytes.len() != 42 {
        return Err(format!(
            "minisign public key must decode to exactly 42 bytes, got {}",
            key_bytes.len()
        ));
    }

    if key_bytes[0] != 0x45 || key_bytes[1] != 0x64 {
        return Err(format!(
            "minisign public key algorithm ID must be 'Ed', got [0x{:02x}, 0x{:02x}]",
            key_bytes[0], key_bytes[1]
        ));
    }

    Ok(())
}

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

    // If TAURI_CONFIG or TAURI_ENV_CONFIG is set in environment, parse and merge it via JSON merge patch.
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
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        validate_release_config();
    }
    tauri_build::build()
}
