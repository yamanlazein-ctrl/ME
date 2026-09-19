// Canonical machine fingerprint (P0-1 / DFP-039 / P1-11).
//
// ONE spec, implemented identically in Rust (here) and in Node
// (`backend/src/infrastructure/fingerprint/canonical.ts`):
//
//   payload = JSON.stringify({ platform, version, signals })   // signals keys sorted
//   hash    = SHA-256(payload) as 64 lowercase hex chars
//
// The Desktop shell uses `platform = "tauri-desktop"`; the Node backend uses
// `"node"`. The envelope SHAPE and the ordering rule are the shared contract —
// the platform label is part of the identity, not a divergence.
//
// This module also owns the live boot gate used by `device_binding`: the
// binding blob records the fingerprint observed at first launch, and every
// later launch must reproduce it. A copied install or a VM clone therefore
// refuses to boot instead of silently binding to the wrong machine.
use crate::runtime::no_window_command;
use serde::{Deserialize, Serialize};
use std::process::Command;

/// Algorithm version. Bump only together with the Node side; an intentional
/// change invalidates every existing fingerprint.
pub const FINGERPRINT_VERSION: u32 = 1;

/// Platform label used by the Desktop shell in the canonical envelope.
pub const DESKTOP_PLATFORM: &str = "tauri-desktop";

#[derive(Debug, Serialize)]
struct Envelope<'a> {
    platform: &'a str,
    version: u32,
    signals: serde_json::Map<String, serde_json::Value>,
}

/// Canonical SHA-256 over the versioned envelope, with signal keys sorted so
/// two implementations can never disagree on serialisation order.
pub fn canonical_fingerprint_hash(
    platform: &str,
    version: u32,
    signals: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut keys: Vec<&String> = signals.keys().collect();
    keys.sort();
    let mut ordered = serde_json::Map::new();
    for key in keys {
        ordered.insert(key.clone(), signals[key].clone());
    }
    let payload = serde_json::to_string(&Envelope { platform, version, signals: ordered })
        .map_err(|e| e.to_string())?;
    Ok(Sha256::digest(payload.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Collect the deterministic hardware signals available on this machine.
///
/// Only stable signals are included: an absent signal is omitted (never
/// hashed as an empty string), so a machine that cannot report a MAC is still
/// distinguishable from one whose MAC is literally "".
pub fn collect_signals() -> serde_json::Map<String, serde_json::Value> {
    let mut signals = serde_json::Map::new();

    let hostname = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    signals.insert("hostname".into(), serde_json::Value::String(hostname));

    let os_label = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    signals.insert(
        "platform_release".into(),
        serde_json::Value::String(os_label),
    );

    if let Ok(mac) = get_primary_mac() {
        if !mac.is_empty() {
            signals.insert("primary_mac".into(), serde_json::Value::String(mac));
        }
    }
    if let Ok(machine_id) = get_machine_id() {
        if !machine_id.is_empty() {
            signals.insert("machine_id".into(), serde_json::Value::String(machine_id));
        }
    }
    if let Ok(cpu) = get_cpu_model() {
        if !cpu.is_empty() {
            signals.insert("cpu_model".into(), serde_json::Value::String(cpu));
        }
    }

    signals
}

/// Canonical Desktop fingerprint for the current machine.
pub fn desktop_fingerprint() -> Result<String, String> {
    canonical_fingerprint_hash(DESKTOP_PLATFORM, FINGERPRINT_VERSION, &collect_signals())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FingerprintSnapshot {
    pub hash: String,
    pub version: u32,
}

fn get_primary_mac() -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        no_window_command("getmac")
            .args(["/fo", "csv", "/nh"])
            .output()
    } else {
        Command::new("sh")
            .args([
                "-c",
                "ip link show 2>/dev/null | grep -oP 'link/ether \\K[^ ]+' | head -1",
            ])
            .output()
    };

    match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // Windows getmac returns quoted CSV: "device","MAC"
            let mac = if s.contains(',') {
                s.split(',').nth(1).unwrap_or(&s).trim_matches('"').to_string()
            } else {
                s
            };
            if mac.is_empty() {
                Err("no MAC found".into())
            } else {
                Ok(mac)
            }
        }
        _ => Err("failed to get MAC".into()),
    }
}

fn get_machine_id() -> Result<String, String> {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/etc/machine-id")
            .map(|s| s.trim().to_string())
            .map_err(|_| "no machine-id".into())
    } else if cfg!(target_os = "windows") {
        let output = no_window_command("reg")
            .args([
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let id = s
                    .lines()
                    .find(|l| l.contains("MachineGuid"))
                    .and_then(|l| l.split("REG_SZ").nth(1))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                Ok(id)
            }
            _ => Err("no MachineGuid".into()),
        }
    } else if cfg!(target_os = "macos") {
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let id = s
                    .lines()
                    .find(|l| l.contains("IOPlatformUUID"))
                    .and_then(|l| l.split('"').nth(3))
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                Ok(id)
            }
            _ => Err("no IOPlatformUUID".into()),
        }
    } else {
        Err("unsupported platform".into())
    }
}

fn get_cpu_model() -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let output = no_window_command("wmic")
            .args(["cpu", "get", "name", "/format:value"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let cpu = s
                    .lines()
                    .find(|l| l.starts_with("Name="))
                    .map(|l| l.trim_start_matches("Name=").trim().to_string())
                    .unwrap_or_default();
                Ok(cpu)
            }
            _ => Err("no CPU info".into()),
        }
    } else {
        let output = Command::new("sh")
            .args(["-c", "lscpu 2>/dev/null | grep 'Model name' | cut -d: -f2"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                Ok(s)
            }
            _ => Err("no CPU info".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dfp039_cross_language_golden_vector_tauri_desktop() {
        let mut signals = serde_json::Map::new();
        signals.insert("cpu_model".into(), json!("x"));
        signals.insert("hostname".into(), json!("h"));
        signals.insert("platform_release".into(), json!("win32 10"));
        assert_eq!(
            canonical_fingerprint_hash(DESKTOP_PLATFORM, FINGERPRINT_VERSION, &signals).unwrap(),
            "d8c84ceade7eb700c75a2f606c5aa4ac8184ac57942dcb7792e48ca8da88d59f"
        );
    }

    #[test]
    fn dfp039_cross_language_golden_vector_node_platform() {
        // Same signals, Node's platform label — must equal the Node golden hash
        // asserted in backend/tests/fingerprint.test.ts.
        let mut signals = serde_json::Map::new();
        signals.insert("cpu_model".into(), json!("x"));
        signals.insert("hostname".into(), json!("h"));
        signals.insert("platform_release".into(), json!("win32 10"));
        assert_eq!(
            canonical_fingerprint_hash("node", FINGERPRINT_VERSION, &signals).unwrap(),
            "6caa9e386ac42f8a20edb067201db3d1784c14f3fd8b6e9ed977f9cd10a05481"
        );
    }

    #[test]
    fn dfp039_hash_is_hex64_and_order_independent() {
        let mut a = serde_json::Map::new();
        a.insert("hostname".into(), json!("h"));
        a.insert("cpu_model".into(), json!("x"));
        let mut b = serde_json::Map::new();
        b.insert("cpu_model".into(), json!("x"));
        b.insert("hostname".into(), json!("h"));
        let ha = canonical_fingerprint_hash(DESKTOP_PLATFORM, 1, &a).unwrap();
        let hb = canonical_fingerprint_hash(DESKTOP_PLATFORM, 1, &b).unwrap();
        assert_eq!(ha, hb);
        assert_eq!(ha.len(), 64);
        assert!(ha.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn live_fingerprint_is_stable_across_calls() {
        let a = desktop_fingerprint().expect("live fingerprint");
        let b = desktop_fingerprint().expect("live fingerprint");
        assert_eq!(a, b, "fingerprint must be stable for the same machine");
        assert_eq!(a.len(), 64);
    }
}