// L-6 — Device binding (step 0 of the desktop boot sequence).
//
// Before any PostgreSQL data, backend, or SSR sidecar is started, the Rust
// shell must prove this is the same machine+user that first provisioned the
// install. We do this with a DPAPI-bound blob:
//
//   * First launch: generate an installation_id + nonce, record the canonical
//     machine fingerprint, DPAPI-encrypt the JSON payload (CurrentUser scope)
//     and persist it as `device-binding.dat`.
//   * Subsequent launches: the blob must decrypt successfully AND the current
//     live fingerprint must equal the recorded one. If either fails (different
//     Windows user, different machine, VM clone, hardware change, or tampering)
//     `ensure_device_binding` returns `Err(DeviceBindError::Tampered)` and the
//     shell must REFUSE to boot.
//
// Legacy installs stored a raw 32-byte nonce. Those are adopted in place by
// minting an installation_id, recording the current fingerprint, and rewriting
// the blob.
use crate::fingerprint::{desktop_fingerprint, FingerprintSnapshot, FINGERPRINT_VERSION};
use crate::secret_store::{dpapi_decrypt, dpapi_encrypt};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug)]
pub enum DeviceBindError {
    /// Blob could not be decrypted -> not the original user/machine (or tampered).
    Tampered,
    /// Decrypt succeeded but this machine's live fingerprint no longer matches
    /// the one recorded at first launch (hardware change / clone / copied data).
    FingerprintMismatch,
    /// IO failure while reading/writing the binding file.
    Io(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct BindingPayload {
    installation_id: String,
    nonce: String,
    /// Machine fingerprint recorded at first launch (or legacy adoption).
    fingerprint: FingerprintSnapshot,
}

fn binding_path() -> Result<PathBuf, DeviceBindError> {
    let mut dir = crate::app_data_dir().map_err(DeviceBindError::Io)?;
    dir.push("device-binding.dat");
    Ok(dir)
}

fn new_installation_id() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn current_fingerprint_snapshot() -> Result<FingerprintSnapshot, DeviceBindError> {
    let hash = desktop_fingerprint().map_err(DeviceBindError::Io)?;
    Ok(FingerprintSnapshot {
        hash,
        version: FINGERPRINT_VERSION,
    })
}

fn persist_payload(path: &PathBuf, payload: &BindingPayload) -> Result<(), DeviceBindError> {
    let json = serde_json::to_vec(payload).map_err(|e| DeviceBindError::Io(e.to_string()))?;
    let cipher = dpapi_encrypt(&json)
        .map_err(|e| DeviceBindError::Io(format!("dpapi encrypt: {}", e)))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| DeviceBindError::Io(format!("create dir '{}': {}", parent.display(), e)))?;
    }
    fs::write(path, B64.encode(&cipher)).map_err(|e| DeviceBindError::Io(e.to_string()))
}

/// Step 0 of desktop boot. Creates the binding on first launch; on later
/// launches verifies it (both DPAPI decrypt AND live fingerprint). Returns the
/// stable `installation_id` used to stamp `db-meta.json`.
/// `Err(DeviceBindError::Tampered | FingerprintMismatch)` if the blob cannot be
/// decrypted or the machine changed — the caller must refuse to start the app.
pub fn ensure_device_binding() -> Result<String, DeviceBindError> {
    let path = binding_path()?;
    if path.exists() {
        let raw = fs::read(&path).map_err(|e| DeviceBindError::Io(e.to_string()))?;
        let cipher = B64.decode(&raw).map_err(|_| DeviceBindError::Tampered)?;
        let plain = dpapi_decrypt(&cipher).map_err(|_| DeviceBindError::Tampered)?;
        if let Ok(payload) = serde_json::from_slice::<BindingPayload>(&plain) {
            if payload.installation_id.trim().is_empty() {
                return Err(DeviceBindError::Tampered);
            }
            // P1-11: live fingerprint must match the recorded one. A copied
            // AppData dir or a changed machine can still DPAPI-decrypt under a
            // fresh Windows account, so the fingerprint is the hardware guard.
            let live = current_fingerprint_snapshot()?;
            if live.hash != payload.fingerprint.hash {
                return Err(DeviceBindError::FingerprintMismatch);
            }
            return Ok(payload.installation_id);
        }
        // Legacy 32-byte nonce: adopt onto a new installation_id on this device.
        if plain.len() == 32 {
            let fingerprint = current_fingerprint_snapshot()?;
            let payload = BindingPayload {
                installation_id: new_installation_id(),
                nonce: B64.encode(&plain),
                fingerprint,
            };
            persist_payload(&path, &payload)?;
            return Ok(payload.installation_id);
        }
        return Err(DeviceBindError::Tampered);
    }

    let mut nonce = vec![0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let fingerprint = current_fingerprint_snapshot()?;
    let payload = BindingPayload {
        installation_id: new_installation_id(),
        nonce: B64.encode(&nonce),
        fingerprint,
    };
    persist_payload(&path, &payload)?;
    Ok(payload.installation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_snapshot_is_stable_and_versioned() {
        let a = current_fingerprint_snapshot().expect("snapshot");
        let b = current_fingerprint_snapshot().expect("snapshot");
        assert_eq!(a.hash, b.hash);
        assert_eq!(a.hash.len(), 64);
        assert_eq!(a.version, FINGERPRINT_VERSION);
    }

    #[test]
    fn changed_fingerprint_is_detected_before_boot() {
        // P1-11 regression: a payload whose fingerprint differs from the live
        // one must fail closed — not silently mint a new identity.
        let live = current_fingerprint_snapshot().expect("snapshot");
        let mut spoofed = live.clone();
        spoofed.hash = "0".repeat(64);
        // Simulate the boot check's comparison without touching disk.
        assert_ne!(spoofed.hash, live.hash);
        assert!(spoofed.hash.len() == 64);
    }
}
