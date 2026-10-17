//! Installation secrets (`<root>\keys\secrets.dat` + `.bak`), DPAPI-bound to the Windows user.
//!
//! Rule (ADR-001 step 2): a new key set is created ONLY on a first install — no key files AND no
//! data. A missing or unreadable key file next to existing data stops the boot on the recovery
//! screen with every file left as it is. The only other way to new keys is `reset`, an explicit
//! typed action that moves the old files aside. Key material never reaches a log or an error text.

use crate::fsutil;
use crate::paths::Paths;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;

const ENTROPY: &[u8] = b"MotardERP/keys/v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub version: u32,
    pub app_master_key: String,
    pub jwt_secret: String,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets(<redacted>)")
    }
}

impl Secrets {
    /// `X-Motard-Runtime-Token`: what the backend compares for runtime-only routes.
    pub fn runtime_token(&self) -> String {
        use sha2::{Digest, Sha256};
        fsutil::hex(&Sha256::digest(self.app_master_key.as_bytes()))
    }
}

#[derive(Debug, PartialEq)]
pub enum KeyProblem {
    /// Data exists but no key file does.
    Missing,
    /// A key file exists but neither copy decrypts (other Windows user, corruption).
    Unreadable,
}

impl KeyProblem {
    pub fn code(&self) -> &'static str {
        match self {
            KeyProblem::Missing => "KEYS_MISSING",
            KeyProblem::Unreadable => "KEYS_UNREADABLE",
        }
    }
}

#[derive(Debug)]
pub enum KeyOutcome {
    Loaded(Secrets),
    /// First install: a new key set was written.
    Created(Secrets),
    Recovery(KeyProblem),
}

fn random_b64(n: usize) -> Result<String, String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| format!("random source failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

fn generate() -> Result<Secrets, String> {
    Ok(Secrets { version: 1, app_master_key: random_b64(32)?, jwt_secret: random_b64(48)? })
}

fn decode(blob: &[u8]) -> Option<Secrets> {
    let plain = dpapi::unprotect(blob).ok()?;
    let s: Secrets = serde_json::from_slice(&plain).ok()?;
    let key_ok = base64::engine::general_purpose::STANDARD
        .decode(&s.app_master_key)
        .map(|k| k.len() == 32)
        .unwrap_or(false);
    (key_ok && s.jwt_secret.len() >= 48).then_some(s)
}

fn write_both(paths: &Paths, s: &Secrets) -> Result<(), String> {
    let plain = serde_json::to_vec(s).map_err(|e| e.to_string())?;
    let blob = dpapi::protect(&plain)?;
    fs::create_dir_all(&paths.keys_dir).map_err(|e| e.to_string())?;
    fsutil::atomic_write(&paths.secrets, &blob).map_err(|e| format!("write secrets.dat: {e}"))?;
    fsutil::atomic_write(&paths.secrets_bak, &blob).map_err(|e| format!("write secrets.dat.bak: {e}"))?;
    Ok(())
}

/// `data_exists`: the database, `install.json` or anything else that proves this root was used.
pub fn load_or_create(paths: &Paths, data_exists: bool) -> Result<KeyOutcome, String> {
    let primary = fs::read(&paths.secrets).ok();
    let backup = fs::read(&paths.secrets_bak).ok();

    if let Some(s) = primary.as_deref().and_then(decode) {
        if backup.as_deref() != primary.as_deref() {
            // Repair the second copy from the good one (the backup may be absent or damaged).
            let _ = fsutil::atomic_write(&paths.secrets_bak, primary.as_deref().unwrap());
        }
        return Ok(KeyOutcome::Loaded(s));
    }
    if let Some(s) = backup.as_deref().and_then(decode) {
        if primary.is_some() {
            fsutil::move_aside(&paths.set_aside, "damaged-secrets", &[paths.secrets.clone()])
                .map_err(|e| format!("set aside damaged secrets.dat: {e}"))?;
        }
        fsutil::atomic_write(&paths.secrets, backup.as_deref().unwrap())
            .map_err(|e| format!("restore secrets.dat from .bak: {e}"))?;
        return Ok(KeyOutcome::Loaded(s));
    }
    if primary.is_none() && backup.is_none() {
        if data_exists {
            return Ok(KeyOutcome::Recovery(KeyProblem::Missing));
        }
        let s = generate()?;
        write_both(paths, &s)?;
        return Ok(KeyOutcome::Created(s));
    }
    Ok(KeyOutcome::Recovery(KeyProblem::Unreadable))
}

/// Explicit, confirmed reset: old files go to `set-aside\`, a new set is written.
pub fn reset(paths: &Paths) -> Result<Secrets, String> {
    fsutil::move_aside(&paths.set_aside, "keys-reset", &[paths.secrets.clone(), paths.secrets_bak.clone()])
        .map_err(|e| format!("set aside old keys: {e}"))?;
    let s = generate()?;
    write_both(paths, &s)?;
    Ok(s)
}

#[cfg(windows)]
pub(crate) mod dpapi {
    use super::ENTROPY;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        v
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        protect_with(plain, ENTROPY)
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        unprotect_with(sealed, ENTROPY)
    }

    /// DPAPI (current Windows user) with a purpose-specific entropy, so one sealed file can never be
    /// read as another (e.g. the Google link vs the installation keys).
    pub fn protect_with(plain: &[u8], purpose: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let entropy = blob(purpose);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| format!("DPAPI protect failed: {e}"))?;
            Ok(take(out))
        }
    }

    pub fn unprotect_with(sealed: &[u8], purpose: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed);
        let entropy = blob(purpose);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| format!("DPAPI unprotect failed: {e}"))?;
            Ok(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("motard-keys-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn first_install_creates_then_reloads_the_same_keys() {
        let p = Paths::at(&root());
        let KeyOutcome::Created(a) = load_or_create(&p, false).unwrap() else { panic!("not created") };
        let KeyOutcome::Loaded(b) = load_or_create(&p, true).unwrap() else { panic!("not loaded") };
        assert_eq!(a.app_master_key, b.app_master_key);
        assert!(!fs::read(&p.secrets).unwrap().windows(10).any(|w| w == &a.app_master_key.as_bytes()[..10]));
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn corrupt_primary_is_restored_from_backup() {
        let p = Paths::at(&root());
        let KeyOutcome::Created(a) = load_or_create(&p, false).unwrap() else { panic!() };
        fs::write(&p.secrets, b"garbage").unwrap();
        let KeyOutcome::Loaded(b) = load_or_create(&p, true).unwrap() else { panic!("not loaded") };
        assert_eq!(a.app_master_key, b.app_master_key);
        assert_eq!(fs::read(&p.secrets).unwrap(), fs::read(&p.secrets_bak).unwrap());
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn both_corrupt_never_regenerates() {
        let p = Paths::at(&root());
        load_or_create(&p, false).unwrap();
        fs::write(&p.secrets, b"garbage").unwrap();
        fs::write(&p.secrets_bak, b"garbage").unwrap();
        // Even with no data, a damaged key file is never silently replaced.
        for data in [true, false] {
            assert!(matches!(load_or_create(&p, data).unwrap(), KeyOutcome::Recovery(KeyProblem::Unreadable)));
        }
        assert_eq!(fs::read(&p.secrets).unwrap(), b"garbage", "files must be left untouched");
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn missing_keys_next_to_data_stop_the_boot() {
        let p = Paths::at(&root());
        assert!(matches!(load_or_create(&p, true).unwrap(), KeyOutcome::Recovery(KeyProblem::Missing)));
        assert!(!p.secrets.exists());
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn reset_moves_old_files_aside() {
        let p = Paths::at(&root());
        fs::create_dir_all(&p.keys_dir).unwrap();
        fs::write(&p.secrets, b"old").unwrap();
        let s = reset(&p).unwrap();
        assert!(matches!(load_or_create(&p, true).unwrap(), KeyOutcome::Loaded(x) if x.app_master_key == s.app_master_key));
        let aside = fs::read_dir(&p.set_aside).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(aside.join("secrets.dat")).unwrap(), b"old");
        assert_eq!(format!("{s:?}"), "Secrets(<redacted>)");
        fs::remove_dir_all(&p.root).ok();
    }
}
