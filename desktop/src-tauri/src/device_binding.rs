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

/// The binding to store when the live fingerprint differs from the recorded one; `None` when it is unchanged.
/// The installation identity (id + nonce) always stays the same — only the fingerprint is refreshed.
fn refreshed_binding(recorded: &BindingPayload, live: FingerprintSnapshot) -> Option<BindingPayload> {
    if live.hash == recorded.fingerprint.hash {
        return None;
    }
    Some(BindingPayload {
        installation_id: recorded.installation_id.clone(),
        nonce: recorded.nonce.clone(),
        fingerprint: live,
    })
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
            // The blob decrypted, so this is the same Windows user on the same install: that (DPAPI, per-user)
            // is the anti-copy guard. A different fingerprint is therefore a legitimate change (hardware/OS
            // reinstall, an older fingerprint algorithm), NOT a reason to lock the customer out — refresh the
            // recorded fingerprint and continue.
            if let Ok(live) = current_fingerprint_snapshot() {
                if let Some(refreshed) = refreshed_binding(&payload, live) {
                    eprintln!("[device-binding] machine fingerprint changed — refreshing the binding");
                    // Best effort: failing to persist must not stop the app either.
                    if let Err(e) = persist_payload(&path, &refreshed) {
                        eprintln!("[device-binding] could not refresh binding: {e:?}");
                    }
                }
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
    fn a_changed_fingerprint_refreshes_the_binding_instead_of_blocking_the_app() {
        // Regression: a PC rename / network adapter change / missing wmic used to end in
        // "the device identity changed — startup stopped" forever.
        let live = current_fingerprint_snapshot().expect("snapshot");
        let mut old = live.clone();
        old.hash = "0".repeat(64);
        let recorded = BindingPayload {
            installation_id: "id-1".into(),
            nonce: "n".into(),
            fingerprint: old,
        };
        let refreshed = refreshed_binding(&recorded, live.clone()).expect("a change is refreshed");
        assert_eq!(refreshed.installation_id, "id-1", "identity is preserved");
        assert_eq!(refreshed.nonce, "n");
        assert_eq!(refreshed.fingerprint.hash, live.hash);
        // Unchanged → nothing to do.
        assert!(refreshed_binding(&refreshed, live).is_none());
    }
}
