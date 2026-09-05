// Desktop secret store: locally generates JWT_SECRET and APP_MASTER_KEY on the
// client machine on first launch, encrypts them with Windows DPAPI (CurrentUser
// scope), and persists them so they survive restarts. The backend never sees a
// plaintext secret in the installer — it only receives the values via env vars
// injected by the sidecar at spawn time.
//
// Mirrors the D3 decision:
//  - JWT_SECRET, APP_MASTER_KEY: generated locally, DPAPI-encrypted, per machine.
//  - LICENSE_SIGNING_KEY (private): never generated or persisted here. The client
//    only ever holds LICENSE_SIGNING_PUBLIC_KEY (set in the backend .env), so the
//    license token signer runs verify-only.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN,
};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct SecretStore {
    pub jwt_secret: String,
    pub app_master_key: String,
}

pub fn secrets_path() -> Result<PathBuf, String> {
    let mut p = crate::app_data_dir()?;
    p.push("secrets.dat");
    Ok(p)
}

// DPAPI encrypt arbitrary bytes (CurrentUser scope, no UI prompt).
// Returns the encrypted blob or a human-readable error string.
pub fn dpapi_encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    let data = windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out = windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &data as *const _,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(|e| format!("CryptProtectData failed: {}", e))?;
    let result = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    // CryptProtectData allocates with LocalAlloc; must free.
    if !out.pbData.is_null() {
        unsafe {
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                out.pbData as *mut _,
            )))
        };
    }
    Ok(result)
}

// DPAPI decrypt bytes encrypted with the same user scope. Returns Err on failure
// (wrong user / machine / corrupt blob) instead of panicking.
pub fn dpapi_decrypt(cipher: &[u8]) -> windows::core::Result<Vec<u8>> {
    let data = windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut out = windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &data as *const _,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }?;
    let result = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    if !out.pbData.is_null() {
        unsafe {
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                out.pbData as *mut _,
            )))
        };
    }
    Ok(result)
}

// Load the store, generating + persisting it on first launch. A corrupt /
// unreadable / undecryptable store is treated as "first launch" and regenerated
// (no panic / uncontrolled crash) — satisfies the desktop robustness requirement.
pub fn load_or_generate() -> Result<SecretStore, String> {
    let path = secrets_path()?;
    if path.exists() {
        if let Ok(raw) = fs::read(&path) {
            if let Ok(json) = dpapi_decrypt(&raw) {
                if let Ok(s) = serde_json::from_slice::<SecretStore>(&json) {
                    if !s.jwt_secret.is_empty() && !s.app_master_key.is_empty() {
                        return Ok(s);
                    }
                }
            }
        }
        // Corrupt / undecryptable store: drop it and regenerate below.
        let _ = fs::remove_file(&path);
    }
    let store = SecretStore {
        jwt_secret: base64_encode(&random_bytes(32)),
        app_master_key: base64_encode(&random_bytes(32)),
    };
    persist(&store)?;
    Ok(store)
}

// Persist (encrypt + write). Returns Ok on success or a human-readable error
// string describing exactly what failed and why.
pub fn persist(store: &SecretStore) -> Result<(), String> {
    let json = serde_json::to_vec(store).map_err(|e| format!("serialize secrets: {}", e))?;
    let enc = dpapi_encrypt(&json)?;
    let dir = crate::app_data_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create data directory '{}': {}", dir.display(), e))?;
    let sp = secrets_path()?;
    fs::write(&sp, &enc)
        .map_err(|e| format!("write '{}': {} (os error {})", sp.display(), e, e.raw_os_error().unwrap_or(0)))?;
    Ok(())
}

// Explicitly clear the store — for test harnesses / "first launch" simulation.
pub fn clear_for_test() {
    if let Ok(p) = secrets_path() {
        let _ = fs::remove_file(p);
    }
}

fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}