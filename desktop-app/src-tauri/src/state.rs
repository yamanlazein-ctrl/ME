//! Startup decision and install identity (ADR-001 steps 3, 4 and 7).
//!
//! The one invariant: a database is only ever CREATED on an empty data root. Every other case opens
//! the existing file or stops on the recovery screen.

use crate::fsutil;
use crate::paths::Paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub installation_id: String,
    pub data_id: String,
    #[serde(default)]
    pub tenant_id: Option<String>,
    /// "creating" until the first healthy boot of a new database, then "ready".
    pub status: String,
    #[serde(default)]
    pub last_app_version: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Empty root: create the database with these ids.
    Fresh(InstallInfo),
    /// Open the existing database. `expected_data_id` is checked by the backend.
    Reuse { install: InstallInfo, expected_data_id: Option<String> },
    /// Evidence of earlier data but no database: never start empty.
    DataMissing,
}

pub fn read_install(paths: &Paths) -> Result<Option<InstallInfo>, ()> {
    match fs::read(&paths.install_json) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|_| ()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

pub fn write_install(paths: &Paths, info: &InstallInfo) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(info).map_err(std::io::Error::other)?;
    fsutil::atomic_write(&paths.install_json, &json)
}

pub fn read_db_meta(paths: &Paths) -> Option<Value> {
    serde_json::from_slice(&fs::read(&paths.db_meta).ok()?).ok()
}

fn meta_str(meta: &Option<Value>, key: &str) -> Option<String> {
    meta.as_ref()?.get(key)?.as_str().map(str::to_string).filter(|s| !s.is_empty())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Anything that proves this data root has been used before.
pub fn data_exists(paths: &Paths) -> bool {
    paths.db.exists() || paths.install_json.exists() || paths.db_meta.exists()
}

pub fn decide(paths: &Paths) -> Decision {
    let install = read_install(paths);
    if !paths.db.exists() {
        return match install {
            Ok(None) if !paths.db_meta.exists() => Decision::Fresh(InstallInfo {
                installation_id: new_id(),
                data_id: new_id(),
                status: "creating".into(),
                created_at: Some(fsutil::stamp()),
                ..Default::default()
            }),
            // A first boot that never finished: retry with the same identity.
            Ok(Some(i)) if i.status == "creating" => Decision::Fresh(i),
            _ => Decision::DataMissing,
        };
    }
    let meta = read_db_meta(paths);
    match install {
        Ok(Some(i)) => {
            let expected = Some(i.data_id.clone()).filter(|s| !s.is_empty());
            Decision::Reuse { install: i, expected_data_id: expected }
        }
        // install.json lost or damaged: recover the identity from db-meta, never re-create.
        _ => {
            let install = InstallInfo {
                installation_id: meta_str(&meta, "installation_id").unwrap_or_else(new_id),
                data_id: meta_str(&meta, "data_id").unwrap_or_default(),
                tenant_id: meta_str(&meta, "tenant_id"),
                status: "ready".into(),
                last_app_version: None,
                created_at: None,
            };
            let expected = Some(install.data_id.clone()).filter(|s| !s.is_empty());
            Decision::Reuse { install, expected_data_id: expected }
        }
    }
}

/// After a healthy boot: take the identity the backend wrote and mark the install ready.
pub fn mark_ready(paths: &Paths, install: &InstallInfo, app_version: &str) -> std::io::Result<InstallInfo> {
    let meta = read_db_meta(paths);
    let mut next = install.clone();
    if let Some(d) = meta_str(&meta, "data_id") {
        next.data_id = d;
    }
    next.tenant_id = meta_str(&meta, "tenant_id").or(next.tenant_id);
    next.status = "ready".into();
    next.last_app_version = Some(app_version.to_string());
    if next != *install {
        write_install(paths, &next)?;
    }
    Ok(next)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyManifest {
    pub from_version: String,
    pub to_version: String,
    pub files: Vec<(String, String)>,
}

/// Copy the database (+WAL/SHM, db-meta) into `backups\pre-update\<from>-to-<to>-<time>\` and verify
/// every file. Called before a new version first opens existing data; an error stops the boot.
pub fn pre_update_copy(paths: &Paths, from: &str, to: &str) -> Result<PathBuf, String> {
    // Time first, so a name sort is a time sort (`latest_pre_update`).
    let dir = paths.pre_update.join(format!("{}-{from}-to-{to}", fsutil::stamp()));
    let mut files = Vec::new();
    let mut sources = paths.db_files();
    sources.push(paths.db_meta.clone());
    for src in sources.iter().filter(|p| p.exists()) {
        let name = src.file_name().unwrap().to_string_lossy().to_string();
        let sha = fsutil::copy_verified(src, &dir.join(&name)).map_err(|e| format!("pre-update copy: {e}"))?;
        files.push((name, sha));
    }
    let manifest = CopyManifest { from_version: from.into(), to_version: to.into(), files };
    fsutil::atomic_write(&dir.join("manifest.json"), &serde_json::to_vec_pretty(&manifest).unwrap())
        .map_err(|e| format!("pre-update manifest: {e}"))?;
    Ok(dir)
}

/// Newest pre-update copy whose files still match their manifest.
pub fn latest_pre_update(paths: &Paths) -> Option<(PathBuf, CopyManifest)> {
    let mut dirs: Vec<_> = fs::read_dir(&paths.pre_update).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.into_iter().rev().find_map(|d| {
        let m: CopyManifest = serde_json::from_slice(&fs::read(d.join("manifest.json")).ok()?).ok()?;
        let ok = m.files.iter().any(|(n, _)| n == "motard.db")
            && m.files.iter().all(|(n, sha)| fsutil::sha256_file(&d.join(n)).ok().as_deref() == Some(sha));
        ok.then_some((d, m))
    })
}

/// Roll back a failed update: current files go to `set-aside\`, the verified copy comes back.
pub fn restore_pre_update(paths: &Paths) -> Result<CopyManifest, String> {
    let (dir, manifest) = latest_pre_update(paths).ok_or("no verified pre-update copy")?;
    let mut current = paths.db_files();
    current.push(paths.db_meta.clone());
    fsutil::move_aside(&paths.set_aside, "before-rollback", &current).map_err(|e| e.to_string())?;
    for (name, sha) in &manifest.files {
        let dst: &Path = if name == "db-meta.json" { &paths.state_dir } else { &paths.data_dir };
        let got = fsutil::copy_verified(&dir.join(name), &dst.join(name)).map_err(|e| e.to_string())?;
        if &got != sha {
            return Err(format!("{name} does not match its manifest"));
        }
    }
    // The next boot of the newer version makes a fresh pre-update copy before trying again.
    if let Ok(Some(mut i)) = read_install(paths) {
        i.last_app_version = Some(manifest.from_version.clone());
        write_install(paths, &i).map_err(|e| e.to_string())?;
    }
    Ok(manifest)
}

/// "Start new" / factory reset / restore: everything that describes the current company moves aside.
pub fn set_aside_company(paths: &Paths, label: &str) -> Result<PathBuf, String> {
    let mut items = paths.db_files();
    items.extend([paths.db_meta.clone(), paths.integrity.clone(), paths.install_json.clone(), paths.sync_dir.clone()]);
    let dir = fsutil::move_aside(&paths.set_aside, label, &items).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.sync_dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> Paths {
        let d = std::env::temp_dir().join(format!("motard-state-{}", uuid::Uuid::new_v4()));
        let p = Paths::at(&d);
        p.ensure_dirs().unwrap();
        p
    }

    #[test]
    fn empty_root_is_fresh_and_an_unfinished_first_boot_keeps_its_ids() {
        let p = paths();
        let Decision::Fresh(i) = decide(&p) else { panic!() };
        write_install(&p, &i).unwrap();
        assert_eq!(decide(&p), Decision::Fresh(i));
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_used_root_without_its_database_never_starts_empty() {
        let p = paths();
        let Decision::Fresh(mut i) = decide(&p) else { panic!() };
        i.status = "ready".into();
        write_install(&p, &i).unwrap();
        assert_eq!(decide(&p), Decision::DataMissing);
        fs::write(&p.install_json, b"{broken").unwrap();
        assert_eq!(decide(&p), Decision::DataMissing);
        fs::remove_file(&p.install_json).unwrap();
        fs::write(&p.db_meta, br#"{"data_id":"d1"}"#).unwrap();
        assert_eq!(decide(&p), Decision::DataMissing);
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn existing_database_is_reused_and_identity_recovered_from_db_meta() {
        let p = paths();
        fs::write(&p.db, b"db").unwrap();
        fs::write(&p.db_meta, br#"{"data_id":"d1","installation_id":"i1","tenant_id":"t1"}"#).unwrap();
        let Decision::Reuse { install, expected_data_id } = decide(&p) else { panic!() };
        assert_eq!((install.installation_id.as_str(), expected_data_id.as_deref()), ("i1", Some("d1")));
        let ready = mark_ready(&p, &install, "3.0.0").unwrap();
        assert_eq!(read_install(&p).unwrap().unwrap(), ready);
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn pre_update_copy_is_verified_and_rolls_back() {
        let p = paths();
        fs::write(&p.db, b"version-1 data").unwrap();
        fs::write(p.db_files()[1].clone(), b"wal").unwrap();
        write_install(&p, &InstallInfo { data_id: "d".into(), status: "ready".into(), last_app_version: Some("3.0.0".into()), ..Default::default() }).unwrap();
        pre_update_copy(&p, "3.0.0", "3.1.0").unwrap();
        fs::write(&p.db, b"half-migrated").unwrap();
        let m = restore_pre_update(&p).unwrap();
        assert_eq!(fs::read(&p.db).unwrap(), b"version-1 data");
        assert_eq!(m.from_version, "3.0.0");
        assert_eq!(read_install(&p).unwrap().unwrap().last_app_version.as_deref(), Some("3.0.0"));
        // The half-migrated file was kept, not deleted.
        let aside = fs::read_dir(&p.set_aside).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(aside.join("motard.db")).unwrap(), b"half-migrated");
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_tampered_copy_is_not_offered() {
        let p = paths();
        fs::write(&p.db, b"data").unwrap();
        let dir = pre_update_copy(&p, "a", "b").unwrap();
        fs::write(dir.join("motard.db"), b"changed").unwrap();
        assert!(latest_pre_update(&p).is_none());
        fs::remove_dir_all(&p.root).ok();
    }
}
