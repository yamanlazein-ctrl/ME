//! Fixed locations (ADR-001 "Fixed, separated locations").
//!
//! Program files live wherever the installer put the executable and are replaced on every update.
//! Everything that belongs to the customer lives under ONE data root that no installer step touches:
//! `%LOCALAPPDATA%\MotardERP` (`MotardERP-Dev` for debug builds, so a developer build can never open
//! a customer's data). `MOTARD_DATA_ROOT` overrides it — used by the clean-profile and two-device
//! tests, never needed by a customer.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Paths {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    pub db: PathBuf,
    pub keys_dir: PathBuf,
    pub secrets: PathBuf,
    pub secrets_bak: PathBuf,
    /// The Google Drive link (OAuth client + refresh token), DPAPI-sealed (google.rs).
    pub google: PathBuf,
    pub backups: PathBuf,
    pub pre_update: PathBuf,
    pub logs: PathBuf,
    pub state_dir: PathBuf,
    pub db_meta: PathBuf,
    pub integrity: PathBuf,
    pub sync_dir: PathBuf,
    pub logos: PathBuf,
    pub set_aside: PathBuf,
    pub install_json: PathBuf,
    /// The backend's device identity file (`DesktopInstallationIdStorage`); it outlives a company.
    pub install_id: PathBuf,
    /// Durable record of a restore in progress (`state::RestoreJournal`).
    pub restore_journal: PathBuf,
    pub lock_file: PathBuf,
    pub reset_request: PathBuf,
}

pub fn profile() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

impl Paths {
    pub fn resolve() -> Result<Paths, String> {
        let root = match std::env::var_os("MOTARD_DATA_ROOT") {
            Some(v) if !v.is_empty() => PathBuf::from(v),
            _ => {
                let base = std::env::var_os("LOCALAPPDATA")
                    .ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
                let name = if cfg!(debug_assertions) { "MotardERP-Dev" } else { "MotardERP" };
                PathBuf::from(base).join(name)
            }
        };
        Ok(Paths::at(&root))
    }

    pub fn at(root: &Path) -> Paths {
        let r = root.to_path_buf();
        let data_dir = r.join("data");
        let keys_dir = r.join("keys");
        let backups = r.join("backups");
        let state_dir = r.join("state");
        let sync_dir = r.join("sync");
        Paths {
            db: data_dir.join("motard.db"),
            data_dir,
            secrets: keys_dir.join("secrets.dat"),
            secrets_bak: keys_dir.join("secrets.dat.bak"),
            google: keys_dir.join("google.dat"),
            keys_dir,
            pre_update: backups.join("pre-update"),
            backups,
            logs: r.join("logs"),
            db_meta: state_dir.join("db-meta.json"),
            integrity: state_dir.join("data-integrity.json"),
            state_dir,
            sync_dir,
            logos: r.join("logos"),
            set_aside: r.join("set-aside"),
            install_json: r.join("install.json"),
            install_id: r.join("install-id"),
            restore_journal: r.join("restore-pending.json"),
            lock_file: r.join("motard.lock"),
            reset_request: r.join("reset-requested.json"),
            root: r,
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for d in [
            &self.root,
            &self.data_dir,
            &self.keys_dir,
            &self.backups,
            &self.pre_update,
            &self.logs,
            &self.state_dir,
            &self.sync_dir,
            &self.logos,
        ] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }

    /// Database files that move together (the WAL holds committed pages until a checkpoint).
    pub fn db_files(&self) -> Vec<PathBuf> {
        vec![
            self.db.clone(),
            PathBuf::from(format!("{}-wal", self.db.display())),
            PathBuf::from(format!("{}-shm", self.db.display())),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn customer_data_is_never_under_the_program_folder() {
        let p = Paths::at(Path::new(r"C:\Users\x\AppData\Local\MotardERP"));
        for f in [&p.db, &p.secrets, &p.backups, &p.install_json, &p.logs] {
            assert!(f.starts_with(&p.root), "{} outside the data root", f.display());
            assert!(!f.to_string_lossy().contains("Programs"));
        }
        assert_eq!(p.db.file_name().unwrap(), "motard.db");
        assert!(p.pre_update.starts_with(&p.backups));
    }
}
