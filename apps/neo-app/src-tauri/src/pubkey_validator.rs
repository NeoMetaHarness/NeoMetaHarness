pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.as_bytes();
    if bytes.is_empty() {
        return Err("invalid base64 length".to_string());
    }

    // Strict standard base64: no line wrapping, no whitespace, only [A-Za-z0-9+/=]
    for &b in bytes {
        if !b.is_ascii_alphanumeric() && b != b'+' && b != b'/' && b != b'=' {
            return Err(format!("invalid character in base64: {:?}", b as char));
        }
    }

    if bytes.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }

    // Reject data after '=' and check padding positions
    let first_eq = bytes.iter().position(|&b| b == b'=');
    let pad_count = if let Some(pos) = first_eq {
        if pos < bytes.len() - 2 {
            return Err("invalid padding in base64: '=' can only appear in the last two bytes".to_string());
        }
        for (idx, &b) in bytes.iter().enumerate().skip(pos) {
            if b != b'=' {
                return Err(format!("invalid character after '=' at index {}: {}", idx, b as char));
            }
        }
        bytes.len() - pos
    } else {
        0
    };

    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    let mut i = 0;
    while i < bytes.len() {
        let is_last_chunk = i == bytes.len() - 4;
        let chunk_pad = if is_last_chunk { pad_count } else { 0 };
        let chunk = &bytes[i..i + 4];
        let mut vals = [0u32; 4];
        for (j, &c) in chunk.iter().enumerate() {
            vals[j] = match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a' + 26) as u32,
                b'0'..=b'9' => (c - b'0' + 52) as u32,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    if !is_last_chunk || j < 4 - chunk_pad {
                        return Err(format!("unexpected padding '=' at index {}", i + j));
                    }
                    0
                }
                _ => unreachable!(),
            };
        }

        // Canonical padding: zero unused padding bits
        if chunk_pad == 1 {
            if (vals[2] & 0x03) != 0 {
                return Err("invalid base64 padding: nonzero unused padding bits".to_string());
            }
        } else if chunk_pad == 2 {
            if (vals[1] & 0x0F) != 0 {
                return Err("invalid base64 padding: nonzero unused padding bits".to_string());
            }
        }

        let triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
        out.push(((triple >> 16) & 0xff) as u8);
        if chunk_pad < 2 {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if chunk_pad < 1 {
            out.push((triple & 0xff) as u8);
        }
        i += 4;
    }
    Ok(out)
}

pub fn validate_minisign_pubkey(pubkey: &str) -> Result<(), String> {
    if pubkey.is_empty() {
        return Err("updater public key cannot be empty in a release build".to_string());
    }
    if pubkey == "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY" {
        return Err(
            "placeholder updater public key REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY must not ship in a release build! Put the real public key in apps/neo-app/src-tauri/tauri.conf.json."
                .to_string(),
        );
    }

    let outer_bytes = base64_decode(pubkey)
        .map_err(|e| format!("updater public key is not valid base64: {}", e))?;

    let file_content = String::from_utf8(outer_bytes)
        .map_err(|e| format!("updater public key decoded bytes are not valid UTF-8: {}", e))?;

    let mut lines = file_content.lines();
    let line1 = lines.next().ok_or_else(|| {
        "minisign public key file must have exactly 2 lines, got 0".to_string()
    })?;
    let line2 = lines.next().ok_or_else(|| {
        "minisign public key file must have exactly 2 lines, got 1".to_string()
    })?;
    if lines.next().is_some() {
        return Err("minisign public key file must have exactly 2 lines".to_string());
    }

    if !line1.starts_with("untrusted comment:") {
        return Err("minisign public key first line must start with 'untrusted comment:'".to_string());
    }

    if line2.is_empty() {
        return Err("minisign public key line 2 is empty".to_string());
    }

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

    // Reject test key ID 'TESTKEY1' in release builds
    let key_id = &key_bytes[2..10];
    if key_id == b"TESTKEY1" || line1 == "untrusted comment: NEO TEST KEY - DO NOT SHIP" {
        return Err(
            "test public key with ID 'TESTKEY1' must not ship in a release build! Put the real public key in apps/neo-app/src-tauri/tauri.conf.json."
                .to_string(),
        );
    }

    Ok(())
}

/// The release key must be the one checked in to tauri.conf.json. `effective` is the key after
/// TAURI_CONFIG is merged (the `--config` arguments `tauri build` passes, or an inherited value: the
/// build cannot tell them apart), so any key that differs from the checked-in one is refused.
#[allow(dead_code)]
pub fn validate_release_key_source(checked_in: Option<&str>, effective: Option<&str>) -> Result<(), String> {
    let checked_in = checked_in.ok_or("tauri.conf.json has no plugins.updater.pubkey")?;
    let effective = effective.ok_or("plugins.updater.pubkey is missing from the effective config")?;
    if checked_in != effective {
        return Err(
            "the updater public key differs from the key checked in to tauri.conf.json; release builds run with TAURI_CONFIG unset and must not change the key"
                .to_string(),
        );
    }
    Ok(())
}
