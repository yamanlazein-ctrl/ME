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
    /// The update being attempted, pinned to the copy taken before its first try. Retries of a
    /// failing update reuse it (a new copy would capture a half-migrated database), and the rollback
    /// returns to it. Cleared by the first healthy boot of the new version and by a rollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_update: Option<PendingUpdate>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub from: String,
    pub to: String,
    pub copy_dir: String,
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

/// The device identity the backend already holds (`<root>\install-id`). It belongs to this
/// installation, not to a company: a company reset keeps it, so FRESH must not mint another.
fn existing_installation_id(paths: &Paths) -> Option<String> {
    let id = fs::read_to_string(&paths.install_id).ok()?.trim().to_string();
    uuid::Uuid::parse_str(&id).is_ok().then_some(id)
}

pub fn decide(paths: &Paths) -> Decision {
    let install = read_install(paths);
    if !paths.db.exists() {
        return match install {
            Ok(None) if !paths.db_meta.exists() => Decision::Fresh(InstallInfo {
                installation_id: existing_installation_id(paths).unwrap_or_else(new_id),
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
            // db-meta is rewritten together with the database (boot, in-app restore); install.json
            // only by the shell. After an in-app restore they differ, and db-meta names the file
            // that is really there.
            let expected = meta_str(&meta, "data_id").or_else(|| Some(i.data_id.clone()).filter(|s| !s.is_empty()));
            Decision::Reuse { install: i, expected_data_id: expected }
        }
        // install.json lost or damaged: recover the identity from db-meta, never re-create.
        _ => {
            let install = InstallInfo {
                installation_id: meta_str(&meta, "installation_id").unwrap_or_else(new_id),
                data_id: meta_str(&meta, "data_id").unwrap_or_default(),
                tenant_id: meta_str(&meta, "tenant_id"),
                status: "ready".into(),
                ..Default::default()
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
    next.pending_update = None; // the update succeeded: its rollback point is released
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

/// The copy's manifest when every file still matches it.
fn verified_copy(dir: &Path) -> Option<CopyManifest> {
    let m: CopyManifest = serde_json::from_slice(&fs::read(dir.join("manifest.json")).ok()?).ok()?;
    let ok = m.files.iter().any(|(n, _)| n == "motard.db")
        && m.files.iter().all(|(n, sha)| fsutil::sha256_file(&dir.join(n)).ok().as_deref() == Some(sha));
    ok.then_some(m)
}

/// Newest pre-update copy whose files still match their manifest.
pub fn latest_pre_update(paths: &Paths) -> Option<(PathBuf, CopyManifest)> {
    let mut dirs: Vec<_> = fs::read_dir(&paths.pre_update).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.into_iter().rev().find_map(|d| verified_copy(&d).map(|m| (d, m)))
}

/// Before version `to` first opens data last opened by `from`: make (or, on a retry of the same
/// update, reuse) the verified pre-update copy and pin it in install.json. Returns the copy and
/// whether it was reused.
pub fn ensure_update_copy(paths: &Paths, install: &mut InstallInfo, from: &str, to: &str) -> Result<(PathBuf, bool), String> {
    if let Some(p) = &install.pending_update {
        let dir = PathBuf::from(&p.copy_dir);
        if p.from == from && p.to == to && verified_copy(&dir).is_some() {
            return Ok((dir, true));
        }
    }
    let dir = pre_update_copy(paths, from, to)?;
    install.pending_update = Some(PendingUpdate { from: from.into(), to: to.into(), copy_dir: dir.display().to_string() });
    write_install(paths, install).map_err(|e| format!("pin pre-update copy: {e}"))?;
    Ok((dir, false))
}

/// The copy a rollback returns to: the one pinned for the update in progress, else the newest.
pub fn rollback_copy(paths: &Paths) -> Option<(PathBuf, CopyManifest)> {
    let pinned = read_install(paths).ok().flatten().and_then(|i| i.pending_update);
    if let Some(p) = pinned {
        let dir = PathBuf::from(p.copy_dir);
        if let Some(m) = verified_copy(&dir) {
            return Some((dir, m));
        }
    }
    latest_pre_update(paths)
}

/// Roll back a failed update: the verified copy is staged first, then the current files move to
/// `set-aside\` and the staged ones take their place. A failure while staging changes nothing.
pub fn restore_pre_update(paths: &Paths) -> Result<CopyManifest, String> {
    let (dir, manifest) = rollback_copy(paths).ok_or("no verified pre-update copy")?;
    let staging = fsutil::new_aside_dir(&paths.set_aside, "rollback-staging");
    for (name, sha) in &manifest.files {
        let got = fsutil::copy_verified(&dir.join(name), &staging.join(name)).map_err(|e| e.to_string())?;
        if &got != sha {
            return Err(format!("{name} does not match its manifest"));
        }
    }
    let mut current = paths.db_files();
    current.push(paths.db_meta.clone());
    fsutil::move_aside(&paths.set_aside, "before-rollback", &current).map_err(|e| e.to_string())?;
    for (name, _) in &manifest.files {
        let dst: &Path = if name == "db-meta.json" { &paths.state_dir } else { &paths.data_dir };
        fs::rename(staging.join(name), dst.join(name)).map_err(|e| format!("put back {name}: {e}"))?;
    }
    let _ = fs::remove_dir(&staging);
    // The newer version makes a new copy before trying again; the pin is released.
    if let Ok(Some(mut i)) = read_install(paths) {
        i.last_app_version = Some(manifest.from_version.clone());
        i.pending_update = None;
        write_install(paths, &i).map_err(|e| e.to_string())?;
    }
    Ok(manifest)
}

/// Everything that describes the current company (the device identity `install-id` is not part of it).
fn company_items(paths: &Paths) -> Vec<PathBuf> {
    let mut items = paths.db_files();
    // The Drive link uploads THIS company's archive: it moves (and comes back) with the company.
    items.extend([
        paths.db_meta.clone(),
        paths.integrity.clone(),
        paths.install_json.clone(),
        paths.sync_dir.clone(),
        paths.google.clone(),
    ]);
    items
}

/// "Start new" / factory reset / restore: everything that describes the current company moves aside.
pub fn set_aside_company(paths: &Paths, label: &str) -> Result<PathBuf, String> {
    let dir = fsutil::new_aside_dir(&paths.set_aside, label);
    set_aside_company_into(paths, &dir)?;
    Ok(dir)
}

fn set_aside_company_into(paths: &Paths, dir: &Path) -> Result<(), String> {
    fsutil::move_into(dir, &company_items(paths)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.sync_dir).map_err(|e| e.to_string())
}

// ── Restore from the recovery screen (DESK-001) ───────────────────────────────────────────────
//
// The company has to move aside before the backend can boot FRESH with the archive, so a rejected
// archive must not leave the empty database it created in its place. The journal is written before
// the move and removed only when the restored company booted healthy; any other ending (the restore
// failed, the shell was killed) puts the company back.

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreJournal {
    pub archive: String,
    pub set_aside_dir: String,
    /// "moved" (company aside, restore running) → "returning" (rolling back: the attempt's files
    /// are already displaced, only the return of the company is left).
    pub phase: String,
}

pub fn read_restore_journal(paths: &Paths) -> Option<RestoreJournal> {
    serde_json::from_slice(&fs::read(&paths.restore_journal).ok()?).ok()
}

fn write_restore_journal(paths: &Paths, j: &RestoreJournal) -> Result<(), String> {
    fsutil::atomic_write(&paths.restore_journal, &serde_json::to_vec_pretty(j).unwrap()).map_err(|e| e.to_string())
}

/// Record the restore, then move the company aside. Returns the set-aside folder.
pub fn begin_restore(paths: &Paths, archive: &Path) -> Result<PathBuf, String> {
    let dir = fsutil::new_aside_dir(&paths.set_aside, "before-restore");
    write_restore_journal(paths, &RestoreJournal {
        archive: archive.display().to_string(),
        set_aside_dir: dir.display().to_string(),
        phase: "moved".into(),
    })?;
    if let Err(e) = set_aside_company_into(paths, &dir) {
        // move_into already put back whatever had moved; nothing is in progress any more
        let _ = fs::remove_file(&paths.restore_journal);
        return Err(e);
    }
    Ok(dir)
}

/// The restored company booted healthy: the restore is final.
pub fn commit_restore(paths: &Paths) {
    let _ = fs::remove_file(&paths.restore_journal);
}

/// Undo an unfinished restore: the attempt's files (an empty or half-restored database) move to
/// `set-aside\…-failed-restore`, the company comes back. Safe to repeat after an interruption.
pub fn rollback_restore(paths: &Paths) -> Result<Option<PathBuf>, String> {
    let Some(mut j) = read_restore_journal(paths) else { return Ok(None) };
    let aside = PathBuf::from(&j.set_aside_dir);
    if !fsutil::move_completed(&aside) {
        // The move itself was interrupted and has been (or will be) rolled back by
        // recover_unfinished_moves: the company never left, nothing was restored over it.
        fsutil::recover_unfinished_moves(&paths.set_aside);
        let _ = fs::remove_file(&paths.restore_journal);
        return Ok(None);
    }
    if j.phase == "moved" {
        fsutil::move_aside(&paths.set_aside, "failed-restore", &company_items(paths)).map_err(|e| e.to_string())?;
        j.phase = "returning".into();
        write_restore_journal(paths, &j)?;
    }
    for original in company_items(paths) {
        let src = aside.join(original.file_name().unwrap());
        if !src.exists() {
            continue; // already back, or never part of the company
        }
        if original.is_dir() && fs::read_dir(&original).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = fs::remove_dir(&original); // the empty folder recreated after the move
        }
        if let Some(parent) = original.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &original).map_err(|e| format!("put back {}: {e}", original.display()))?;
    }
    fs::create_dir_all(&paths.sync_dir).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&paths.restore_journal);
    Ok(Some(aside))
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

    #[test]
    fn a_company_reset_keeps_the_device_identity() {
        // DESK-004: the backend's install-id survives "start new"; FRESH must reuse it.
        let p = paths();
        let device = uuid::Uuid::new_v4().to_string();
        fs::write(&p.install_id, &device).unwrap();
        let Decision::Fresh(i) = decide(&p) else { panic!() };
        assert_eq!(i.installation_id, device);
        fs::write(&p.install_id, "not-a-uuid").unwrap();
        let Decision::Fresh(i) = decide(&p) else { panic!() };
        assert_ne!(i.installation_id, "not-a-uuid");
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn after_an_in_app_restore_the_database_identity_wins() {
        // DESK-003: the backend rewrote db-meta with the restored data id; install.json is stale.
        let p = paths();
        fs::write(&p.db, b"db").unwrap();
        write_install(&p, &InstallInfo { data_id: "old".into(), status: "ready".into(), ..Default::default() }).unwrap();
        fs::write(&p.db_meta, br#"{"data_id":"restored"}"#).unwrap();
        let Decision::Reuse { expected_data_id, .. } = decide(&p) else { panic!() };
        assert_eq!(expected_data_id.as_deref(), Some("restored"));
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_retried_update_keeps_its_first_copy_and_rollback_returns_to_it() {
        // DESK-009: retry 1 after a half-applied migration must not become the rollback point.
        let p = paths();
        fs::write(&p.db, b"version-1 data").unwrap();
        let mut install = InstallInfo { data_id: "d".into(), status: "ready".into(), last_app_version: Some("3.0.0".into()), ..Default::default() };
        write_install(&p, &install).unwrap();
        let (first, reused) = ensure_update_copy(&p, &mut install, "3.0.0", "3.1.0").unwrap();
        assert!(!reused);
        fs::write(&p.db, b"half-migrated").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // a later stamp sorts after
        let (again, reused) = ensure_update_copy(&p, &mut install, "3.0.0", "3.1.0").unwrap();
        assert!(reused);
        assert_eq!(again, first);
        // Even a newer copy made some other way does not displace the pinned one.
        pre_update_copy(&p, "3.0.0", "3.1.0").unwrap();
        let m = restore_pre_update(&p).unwrap();
        assert_eq!(m.from_version, "3.0.0");
        assert_eq!(fs::read(&p.db).unwrap(), b"version-1 data");
        assert_eq!(read_install(&p).unwrap().unwrap().pending_update, None);
        // A healthy boot also releases the pin.
        install.pending_update = Some(PendingUpdate { from: "a".into(), to: "b".into(), copy_dir: "x".into() });
        assert_eq!(mark_ready(&p, &install, "3.1.0").unwrap().pending_update, None);
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_rejected_restore_puts_the_company_back() {
        // DESK-001: the backend created an empty FRESH database before the archive was refused.
        let p = paths();
        fs::write(&p.db, b"the customer's data").unwrap();
        fs::write(&p.db_meta, br#"{"data_id":"d1"}"#).unwrap();
        write_install(&p, &InstallInfo { data_id: "d1".into(), status: "ready".into(), ..Default::default() }).unwrap();
        let aside = begin_restore(&p, Path::new(r"C:\backup.zip")).unwrap();
        assert!(!p.db.exists() && aside.join("motard.db").exists());
        assert!(read_restore_journal(&p).is_some());
        // The FRESH attempt left an empty company behind.
        fs::write(&p.db, b"empty fresh db").unwrap();
        write_install(&p, &InstallInfo { data_id: "new".into(), status: "creating".into(), ..Default::default() }).unwrap();

        assert_eq!(rollback_restore(&p).unwrap(), Some(aside));
        assert_eq!(fs::read(&p.db).unwrap(), b"the customer's data");
        assert_eq!(read_install(&p).unwrap().unwrap().data_id, "d1");
        assert!(read_restore_journal(&p).is_none());
        let Decision::Reuse { expected_data_id, .. } = decide(&p) else { panic!("not the old company") };
        assert_eq!(expected_data_id.as_deref(), Some("d1"));
        // The failed attempt's database was kept, not deleted.
        let failed = fs::read_dir(&p.set_aside).unwrap().flatten().map(|e| e.path())
            .find(|d| d.to_string_lossy().ends_with("failed-restore")).unwrap();
        assert_eq!(fs::read(failed.join("motard.db")).unwrap(), b"empty fresh db");
        assert_eq!(rollback_restore(&p).unwrap(), None, "nothing left to undo");
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_rollback_interrupted_after_displacing_the_attempt_finishes_on_the_next_start() {
        let p = paths();
        fs::write(&p.db, b"customer").unwrap();
        let aside = begin_restore(&p, Path::new("a.zip")).unwrap();
        fs::write(&p.db, b"fresh").unwrap();
        // Phase 1 of the rollback ran, then the shell died.
        fsutil::move_aside(&p.set_aside, "failed-restore", &company_items(&p)).unwrap();
        let mut j = read_restore_journal(&p).unwrap();
        j.phase = "returning".into();
        write_restore_journal(&p, &j).unwrap();
        assert_eq!(rollback_restore(&p).unwrap(), Some(aside));
        assert_eq!(fs::read(&p.db).unwrap(), b"customer");
        fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn a_committed_restore_is_not_undone() {
        let p = paths();
        fs::write(&p.db, b"old").unwrap();
        begin_restore(&p, Path::new("a.zip")).unwrap();
        fs::write(&p.db, b"restored").unwrap();
        commit_restore(&p);
        assert_eq!(rollback_restore(&p).unwrap(), None);
        assert_eq!(fs::read(&p.db).unwrap(), b"restored");
        fs::remove_dir_all(&p.root).ok();
    }
}
