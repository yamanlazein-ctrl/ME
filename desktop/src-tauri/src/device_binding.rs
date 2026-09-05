// L-6 — Device binding (step 0 of the desktop boot sequence).
//
// Before any PostgreSQL data, backend, or SSR sidecar is started, the Rust
// shell must prove this is the same machine+user that first provisioned the
// install. We do this with a DPAPI-bound blob:
//
//   * First launch: generate a random 32-byte binding secret, DPAPI-encrypt it
//     (CurrentUser scope) and persist it as `device-binding.dat`.
//   * Subsequent launches: the blob must decrypt successfully. If it does NOT
//     (different Windows user, different machine, or tampering/copy of the
//     install to another box), `ensure_device_binding` returns
//     `Err(DeviceBindError::Tampered)` and the shell must REFUSE to boot.
//
// This is "reasonable, not absolute" device binding: DPAPI ties the blob to the
// logged-in user + machine, so copying the whole app folder to another account
// or PC fails to decrypt and halts startup. It is defense-in-depth on top of the
// baked license, not a hard hardware fingerprint.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::secret_store::{dpapi_decrypt, dpapi_encrypt};
use std::fs;
use std::path::PathBuf;

#[derive(Debug)]
pub enum DeviceBindError {
    /// Blob could not be decrypted -> not the original user/machine (or tampered).
    Tampered,
    /// IO failure while reading/writing the binding file.
    Io(String),
}

fn binding_path() -> Result<PathBuf, DeviceBindError> {
    let mut dir = crate::app_data_dir().map_err(DeviceBindError::Io)?;
    dir.push("device-binding.dat");
    Ok(dir)
}

/// Step 0 of desktop boot. Creates the binding on first launch; on later
/// launches verifies it. Returns `Err(DeviceBindError::Tampered)` if the blob
/// cannot be decrypted — the caller must refuse to start the app.
pub fn ensure_device_binding() -> Result<(), DeviceBindError> {
    let path = binding_path()?;
    if path.exists() {
        let raw = fs::read(&path).map_err(|e| DeviceBindError::Io(e.to_string()))?;
        let cipher = B64
            .decode(&raw)
            .map_err(|_| DeviceBindError::Tampered)?;
        // Must decrypt on this exact user/machine or we refuse to boot.
        dpapi_decrypt(&cipher).map_err(|_| DeviceBindError::Tampered)?;
        Ok(())
    } else {
        let bytes: Vec<u8> = {
            use rand::RngCore;
            let mut b = vec![0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut b);
            b
        };
        let cipher = dpapi_encrypt(&bytes)
            .map_err(|e| DeviceBindError::Io(format!("dpapi encrypt: {}", e)))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| DeviceBindError::Io(format!("create dir '{}': {}", parent.display(), e)))?;
        }
        fs::write(&path, B64.encode(&cipher)).map_err(|e| DeviceBindError::Io(e.to_string()))?;
        Ok(())
    }
}
