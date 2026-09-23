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
// The fingerprint is ONE stable signal (MachineGuid). `device_binding` records it at first launch and refreshes
// it if it legitimately changes (hardware/OS reinstall on the same Windows profile); it never stops the app.
use serde::{Deserialize, Serialize};

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

/// The signals that identify this machine for BINDING.
///
/// Exactly ONE: the Windows `MachineGuid`. It is stable across renames, network-adapter changes (VPN, USB
/// Ethernet, docking, Wi-Fi off), hardware upgrades and Windows updates, and it is read through the registry API.
///
/// The previous set (hostname + first MAC from `getmac` + CPU name from `wmic` + MachineGuid) stopped installs
/// for good the first time any one of them changed — renaming the PC, a VPN adapter appearing first in the
/// list, `wmic` missing on newer Windows 11 — with "the device identity changed". None of those is evidence of
/// a copied install; copying is already prevented by the DPAPI (per-user) encryption of the binding blob.
pub fn stable_signals() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let machine_id = get_machine_id()?;
    if machine_id.trim().is_empty() {
        return Err("empty MachineGuid".into());
    }
    let mut signals = serde_json::Map::new();
    signals.insert("machine_id".into(), serde_json::Value::String(machine_id));
    Ok(signals)
}

/// Canonical Desktop fingerprint for the current machine.
pub fn desktop_fingerprint() -> Result<String, String> {
    canonical_fingerprint_hash(DESKTOP_PLATFORM, FINGERPRINT_VERSION, &stable_signals()?)
}

/// Human-readable machine info (display only — NOT part of the fingerprint).
pub struct MachineInfo {
    pub hostname: String,
    pub os: String,
}

pub fn machine_info() -> MachineInfo {
    MachineInfo {
        hostname: hostname::get()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FingerprintSnapshot {
    pub hash: String,
    pub version: u32,
}

#[cfg(windows)]
fn get_machine_id() -> Result<String, String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            w!("MachineGuid"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            Some(&mut len),
        )
    };
    if status.0 != 0 {
        return Err(format!("MachineGuid unreadable (error {})", status.0));
    }
    // `len` is in bytes and includes the terminating NUL.
    let chars = (len as usize / 2).saturating_sub(1).min(buf.len());
    Ok(String::from_utf16_lossy(&buf[..chars]).trim().to_string())
}

#[cfg(not(windows))]
fn get_machine_id() -> Result<String, String> {
    std::fs::read_to_string("/etc/machine-id")
        .map(|s| s.trim().to_string())
        .map_err(|_| "no machine-id".into())
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

    #[test]
    fn binding_fingerprint_uses_only_the_stable_machine_id() {
        // Regression: hostname / MAC / CPU-name signals made a routine change (PC rename, VPN adapter,
        // missing wmic) lock the customer out with "device identity changed".
        let signals = stable_signals().expect("MachineGuid readable on Windows");
        let keys: Vec<&String> = signals.keys().collect();
        assert_eq!(keys, vec!["machine_id"]);
    }
}
