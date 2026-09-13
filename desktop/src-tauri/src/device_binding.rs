// L-6 — Device binding (step 0 of the desktop boot sequence).
//
// Before any PostgreSQL data, backend, or SSR sidecar is started, the Rust
// shell must prove this is the same machine+user that first provisioned the
// install. We do this with a DPAPI-bound blob:
//
//   * First launch: generate an installation_id + nonce, DPAPI-encrypt the
//     JSON payload (CurrentUser scope) and persist it as `device-binding.dat`.
//   * Subsequent launches: the blob must decrypt successfully. If it does NOT
//     (different Windows user, different machine, or tampering/copy of the
//     install to another box), `ensure_device_binding` returns
//     `Err(DeviceBindError::Tampered)` and the shell must REFUSE to boot.
//
// Legacy installs stored a raw 32-byte nonce. Those are adopted in place by
// minting an installation_id and rewriting the blob.
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
/// launches verifies it. Returns the stable `installation_id` used to stamp
/// `db-meta.json`. `Err(DeviceBindError::Tampered)` if the blob cannot be
/// decrypted — the caller must refuse to start the app.
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
            return Ok(payload.installation_id);
        }
        // Legacy 32-byte nonce: adopt onto a new installation_id on this device.
        if plain.len() == 32 {
            let payload = BindingPayload {
                installation_id: new_installation_id(),
                nonce: B64.encode(&plain),
            };
            persist_payload(&path, &payload)?;
            return Ok(payload.installation_id);
        }
        return Err(DeviceBindError::Tampered);
    }

    let mut nonce = vec![0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let payload = BindingPayload {
        installation_id: new_installation_id(),
        nonce: B64.encode(&nonce),
    };
    persist_payload(&path, &payload)?;
    Ok(payload.installation_id)
}
