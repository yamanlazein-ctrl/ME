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
    /// Password for the bundled PostgreSQL role; persisted DPAPI-encrypted
    /// alongside the application secrets and never shipped in pgdata.
    #[serde(default)]
    pub db_password: String,
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

// Load the store, generating + persisting it on first launch only when no
// secrets.dat exists. DFP-011: an existing but undecryptable/corrupt store
// fails closed — we preserve the original as secrets.dat.corrupt-<ts> and
// refuse to silently rotate JWT/APP keys (would invalidate sessions / crypto).
pub fn load_or_generate() -> Result<SecretStore, String> {
    let path = secrets_path()?;
    if path.exists() {
        match fs::read(&path) {
            Ok(raw) => match dpapi_decrypt(&raw) {
                Ok(json) => match serde_json::from_slice::<SecretStore>(&json) {
                    Ok(s) if !s.jwt_secret.is_empty() && !s.app_master_key.is_empty() => {
                        // P2-5: a store from before the scram-sha-256 migration
                        // has no db_password. Provisioning one is NOT a key
                        // rotation (JWT/APP keys are untouched) — it is the
                        // creation of the role secret the bundled PostgreSQL
                        // needs so `trust` auth can be retired.
                        if s.db_password.is_empty() {
                            let mut upgraded = s.clone();
                            upgraded.db_password = generate_db_password();
                            persist(&upgraded)?;
                            return Ok(upgraded);
                        }
                        return Ok(s);
                    }
                    Ok(_) => {
                        let msg = preserve_corrupt_and_fail(
                            &path,
                            "secrets.dat decrypted but JWT/APP keys are empty",
                        );
                        if !explicit_secrets_reset_allowed() {
                            return Err(msg);
                        }
                    }
                    Err(e) => {
                        let msg = preserve_corrupt_and_fail(
                            &path,
                            &format!("secrets.dat JSON parse failed: {e}"),
                        );
                        if !explicit_secrets_reset_allowed() {
                            return Err(msg);
                        }
                    }
                },
                Err(e) => {
                    let msg = preserve_corrupt_and_fail(
                        &path,
                        &format!("secrets.dat DPAPI decrypt failed: {e}"),
                    );
                    if !explicit_secrets_reset_allowed() {
                        return Err(msg);
                    }
                }
            },
            Err(e) => {
                return Err(format!(
                    "secrets.dat exists but cannot be read at {}: {e}",
                    path.display()
                ));
            }
        }
    }
    let store = SecretStore {
        jwt_secret: base64_encode(&random_bytes(32)),
        app_master_key: base64_encode(&random_bytes(32)),
        db_password: generate_db_password(),
    };
    persist(&store)?;
    Ok(store)
}

/// P2-5: the password for the bundled PostgreSQL superuser role.
///
/// Deliberately restricted to `[A-Za-z0-9]` so the value needs no
/// percent-encoding when placed in `DATABASE_URL` (a `$`, `/`, `:` or `@`
/// would change the URL grammar, and libpq would silently mis-parse it).
fn generate_db_password() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let bytes = random_bytes(28);
    let mut out = String::with_capacity(bytes.len());
    for b in bytes {
        out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
    }
    out
}

fn preserve_corrupt_and_fail(path: &std::path::Path, reason: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_extension(format!("dat.corrupt-{ts}"));
    let _ = fs::rename(path, &backup);
    format!(
        "رفض تحميل secrets.dat التالف/غير القابل للفك — لم تُستبدل المفاتيح تلقائياً.\n\
         السبب: {reason}\n\
         نُقلت النسخة الأصلية إلى: {}\n\
         للاستعادة: أعد تسمية الملف إلى secrets.dat بعد إصلاح DPAPI/المستخدم، \
         أو اضبط MOTARD_RESET_SECRETS=1 بعد موافقة صريحة ثم أعد التشغيل \
         لإعادة توليد مفاتيح جديدة (سيُبطل الجلسات الحالية).",
        backup.display()
    )
}

fn explicit_secrets_reset_allowed() -> bool {
    matches!(
        std::env::var("MOTARD_RESET_SECRETS").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    )
}

// Persist (encrypt + write) via temp file + rename (DFP-011 atomic write).
pub fn persist(store: &SecretStore) -> Result<(), String> {
    let json = serde_json::to_vec(store).map_err(|e| format!("serialize secrets: {}", e))?;
    let enc = dpapi_encrypt(&json)?;
    let dir = crate::app_data_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create data directory '{}': {}", dir.display(), e))?;
    let sp = secrets_path()?;
    let tmp = sp.with_extension("dat.tmp");
    fs::write(&tmp, &enc).map_err(|e| {
        format!(
            "write '{}': {} (os error {})",
            tmp.display(),
            e,
            e.raw_os_error().unwrap_or(0)
        )
    })?;
    fs::rename(&tmp, &sp).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!(
            "rename '{}' -> '{}': {}",
            tmp.display(),
            sp.display(),
            e
        )
    })?;
    Ok(())
}

// Explicitly clear the store — for test harnesses / "first launch" simulation.
pub fn clear_for_test() {
    if let Ok(p) = secrets_path() {
        let _ = fs::remove_file(p);
    }
}

/// P2-5: the bundled PostgreSQL superuser password. Loaded (and, for a store
/// that predates the scram migration, provisioned) BEFORE the database starts,
/// so the boot can retire `trust` authentication on the very first launch.
pub fn db_password() -> Result<String, String> {
    Ok(load_or_generate()?.db_password)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// DPAPI roundtrip on THIS machine/user (Plan §2 step-0 gate depends on
    /// it: a copied install fails decrypt and refuses boot). Touches no
    /// files — pure encrypt/decrypt of in-memory bytes.
    #[test]
    fn dpapi_roundtrip_current_user() {
        let plain = b"motard-erp device-binding probe";
        let cipher = dpapi_encrypt(plain).expect("DPAPI encrypt must succeed");
        assert_ne!(cipher, plain.to_vec(), "ciphertext must differ from plaintext");
        let back = dpapi_decrypt(&cipher).expect("DPAPI decrypt must succeed");
        assert_eq!(back, plain);
    }

    #[test]
    fn dpapi_rejects_tampered_blob() {
        let mut cipher = dpapi_encrypt(b"hello").expect("encrypt");
        let last = cipher.len() - 1;
        cipher[last] ^= 0xff;
        assert!(dpapi_decrypt(&cipher).is_err(), "tampered blob must not decrypt");
    }

    #[test]
    fn preserve_corrupt_renames_and_does_not_delete() {
        let dir = std::env::temp_dir().join(format!(
            "motard-secrets-corrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.dat");
        fs::write(&path, b"not-a-dpapi-blob").unwrap();
        let msg = preserve_corrupt_and_fail(&path, "unit-test");
        assert!(!path.exists(), "original path must be renamed away");
        assert!(msg.contains("corrupt"), "message must mention backup: {msg}");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains("corrupt")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup must remain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_fail_message_documents_explicit_reset_env() {
        let dir = std::env::temp_dir().join(format!(
            "motard-secrets-msg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.dat");
        fs::write(&path, b"garbage").unwrap();
        let msg = preserve_corrupt_and_fail(&path, "unit");
        assert!(msg.contains("MOTARD_RESET_SECRETS"), "recovery path must be documented: {msg}");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_store_has_both_secrets() {
        // load_or_generate touches the REAL %LOCALAPPDATA% store: only assert
        // shape, never delete or overwrite the operator's file.
        let store = load_or_generate().expect("load_or_generate must succeed");
        assert!(!store.jwt_secret.is_empty());
        assert!(!store.app_master_key.is_empty());
    }

    /// P2-5: the bundled PostgreSQL superuser password must exist and be
    /// URL-safe, because it is injected into `DATABASE_URL` verbatim — a
    /// metacharacter there would silently corrupt the connection string and
    /// look like an unrelated "backend cannot reach the database" crash.
    #[test]
    fn db_password_is_url_safe() {
        let store = load_or_generate().expect("load_or_generate must succeed");
        assert!(!store.db_password.is_empty(), "db_password must be provisioned");
        assert!(
            store
                .db_password
                .chars()
                .all(|c| c.is_ascii_alphanumeric()),
            "db_password must need no URL encoding: {}",
            store.db_password
        );
    }
}