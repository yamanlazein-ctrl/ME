//! Desktop data-root identity and the startup state machine (specs/001-desktop-sqlite-engine T076/T081/
//! T084, contracts/data-root-and-startup-states.md, data-model.md §5.1, decisions D-1/D-2).
//!
//! The local database is `<root>\data\motard.db` (SQLite). Its identity lives in the database
//! (`motard_meta`) and is mirrored by the backend into the `<root>\db-meta.json` sidecar. Before the
//! server is spawned the runtime evaluates, from files only and READ-ONLY:
//!
//! | State              | Trigger                                                                                  |
//! |--------------------|------------------------------------------------------------------------------------------|
//! | `FRESH`            | empty data root                                                                          |
//! | `REUSE`            | binding + sidecar + meta agree and same install instance (or a valid update token)       |
//! | `PRIOR_DATA_FOUND` | data present and this is a new installation (new instance without token / new binding)   |
//! | `MISMATCH`         | sidecar ≠ meta, or the device binding is not one this database knows                    |
//! | `CORRUPT`          | not a SQLite file, `integrity_check` fails, or no `motard_meta`                          |
//! | `TOO_NEW`          | schema newer than this binary                                                            |
//! | `DATA_MISSING`     | evidence of prior data but no database                                                   |
//! (`LOCKED_UNKNOWN` is decided by `data_lock`, `SERVICE_STOPPED` by the supervisor.)
//!
//! No evaluation deletes, overwrites or creates anything (C-13). The actions the user can choose
//! (`open_existing`, `restore_backup`, `start_new`) are applied by the runtime afterwards; "start new"
//! only MOVES data into `<root>\set-aside\<timestamp>\`.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

pub const META_FILE: &str = "db-meta.json";
pub const INTEGRITY_MANIFEST_FILE: &str = "data-integrity.json";
pub const DATA_DIR: &str = "data";
pub const DATABASE_FILE: &str = "motard.db";
pub const UPDATE_TOKEN_FILE: &str = "pending-update.json";
pub const BACKUP_REGISTRY_FILE: &str = "backups.json";
pub const SET_ASIDE_DIR: &str = "set-aside";

/// HKCU key/value written by the installer (T075) — only if absent; removed by the uninstaller.
pub const INSTALL_INSTANCE_KEY: &str = r"Software\MotardFabricsErp";
pub const INSTALL_INSTANCE_VALUE: &str = "InstallInstanceId";

#[derive(Debug, Clone, Deserialize)]
struct IntegrityManifestLite {
    #[serde(default)]
    last_known_counts: Option<LastKnownCounts>,
    #[serde(rename = "lastKnownCounts")]
    last_known_counts_camel: Option<LastKnownCounts>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct LastKnownCounts {
    #[serde(default)]
    invoices: i64,
    #[serde(default)]
    parties: i64,
    #[serde(default)]
    rolls: i64,
}

impl IntegrityManifestLite {
    fn business_rows(&self) -> i64 {
        match self.last_known_counts.as_ref().or(self.last_known_counts_camel.as_ref()) {
            Some(c) => c.invoices + c.parties + c.rolls,
            None => 0,
        }
    }
}

pub fn integrity_manifest_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(INTEGRITY_MANIFEST_FILE)
}

pub fn database_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(DATA_DIR).join(DATABASE_FILE)
}

pub fn meta_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(META_FILE)
}

pub fn update_token_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(UPDATE_TOKEN_FILE)
}

/// The sidecar `{ data_id, tenant_id, schema_journal_idx, installation_id, install_instance_id }`
/// written by the backend. Unknown keys (e.g. the PostgreSQL-era `pg_major`) are ignored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DbMeta {
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub data_id: Option<String>,
    #[serde(default)]
    pub tenant_id: Option<String>,
    #[serde(default)]
    pub install_instance_id: Option<String>,
    #[serde(default)]
    pub installation_id: Option<String>,
    #[serde(default)]
    pub schema_journal_idx: i32,
}

pub fn read_meta(app_data_root: &Path) -> io::Result<Option<DbMeta>> {
    let path = meta_path(app_data_root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, format!("db-meta.json تالف: {e}")))
}

/// Last `idx` in the bundled SQLite migrations journal (`sqlite-migrations/meta/_journal.json`).
pub fn bundled_schema_journal_idx(migrations_dir: &Path) -> i32 {
    let path = migrations_dir.join("meta").join("_journal.json");
    let Ok(raw) = fs::read_to_string(path) else { return 0 };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return 0 };
    v.get("entries")
        .and_then(|e| e.as_array())
        .and_then(|a| a.last())
        .and_then(|l| l.get("idx"))
        .and_then(|i| i.as_i64())
        .map(|i| i as i32)
        .unwrap_or(0)
}

/// What `motard_meta` (inside the database) says, read read-only after `PRAGMA integrity_check`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DbFacts {
    pub data_id: String,
    pub tenant_id: Option<String>,
    pub install_instance_id: Option<String>,
    pub schema_journal_idx: i32,
    pub created_by_installation_id: String,
    pub adopted_installation_ids: Vec<String>,
    /// The program version that last opened this database (None when never recorded).
    pub app_version_last_opened: Option<String>,
}

/// `file:` URI for a read-only, side-file-free open (`immutable=1`), percent-encoding what URIs reserve.
fn immutable_uri(db: &Path) -> String {
    let mut out = String::from("file:");
    let s = db.display().to_string().replace('\\', "/");
    if !s.starts_with('/') {
        out.push('/');
    }
    for ch in s.chars() {
        match ch {
            '%' | '?' | '#' | ' ' => out.push_str(&format!("%{:02X}", ch as u32)),
            c => out.push(c),
        }
    }
    out.push_str("?immutable=1");
    out
}

/// Open `motard.db` READ-ONLY, run `PRAGMA integrity_check`, read `motard_meta`. Never writes.
#[hotpath::measure]
pub fn inspect_database(db: &Path) -> Result<DbFacts, String> {
    use rusqlite::{Connection, OpenFlags};
    let mut header = [0u8; 16];
    {
        use std::io::Read;
        let mut f = fs::File::open(db).map_err(|e| format!("cannot open the database file: {e}"))?;
        if f.read_exact(&mut header).is_err() || &header != b"SQLite format 3\0" {
            return Err("not a SQLite database file".into());
        }
    }
    // With no WAL content the main file IS the database: open it `immutable=1`, so the inspection
    // creates no -wal/-shm side files at all (the negative lifecycle cases assert the data folder is
    // byte-identical afterwards). With WAL content present, a plain read-only open is needed to see
    // the committed-but-uncheckpointed pages; SQLite then maintains its -shm index (derived, not data).
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    let wal_empty = fs::metadata(&wal).map(|m| m.len() == 0).unwrap_or(true);
    let conn = if wal_empty {
        Connection::open_with_flags(
            immutable_uri(db),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
        )
    } else {
        Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
    }
    .map_err(|e| format!("cannot open the database read-only: {e}"))?;
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("integrity_check could not run: {e}"))?;
    if check != "ok" {
        return Err(format!("integrity_check: {check}"));
    }
    let mut facts = conn.query_row(
        "SELECT data_id, tenant_id, install_instance_id, schema_journal_idx, created_by_installation_id, adopted_installation_ids \
         FROM motard_meta WHERE id = 1",
        [],
        |r| {
            let adopted: String = r.get(5)?;
            Ok(DbFacts {
                data_id: r.get(0)?,
                tenant_id: r.get(1)?,
                install_instance_id: r.get(2)?,
                schema_journal_idx: r.get(3)?,
                created_by_installation_id: r.get(4)?,
                adopted_installation_ids: serde_json::from_str(&adopted).unwrap_or_default(),
                app_version_last_opened: None,
            })
        },
    )
    .map_err(|e| format!("no readable motard_meta (not a Motard database): {e}"))?;
    // Separate read: a database without the column simply has no recorded version.
    facts.app_version_last_opened = conn
        .query_row("SELECT app_version_last_opened FROM motard_meta WHERE id = 1", [], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten();
    Ok(facts)
}

/// `a` is a strictly newer `major.minor.patch` than `b` (pre-release/build suffixes ignored).
fn version_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Option<Vec<u64>> {
        v.trim().split(['-', '+']).next()?.split('.').map(|p| p.parse().ok()).collect()
    };
    matches!((parse(a), parse(b)), (Some(x), Some(y)) if x > y)
}

/// `<root>\pending-update.json`, written immediately before an in-app update (T083).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateToken {
    pub install_instance_id: Option<String>,
    pub from_version: String,
    pub to_version: String,
    pub created_at: String,
}

pub fn read_update_token(app_data_root: &Path) -> Option<UpdateToken> {
    serde_json::from_str(&fs::read_to_string(update_token_path(app_data_root)).ok()?).ok()
}

pub fn write_update_token(app_data_root: &Path, token: &UpdateToken) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(token).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    let tmp = app_data_root.join(format!("{UPDATE_TOKEN_FILE}.tmp"));
    fs::write(&tmp, body)?;
    fs::rename(tmp, update_token_path(app_data_root))
}

/// What the runtime knows about this launch, besides the files.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LaunchFacts {
    /// The installer's HKCU install-instance marker (T075), if present.
    pub install_instance_marker: Option<String>,
    /// The DPAPI device-binding installation id.
    pub installation_id: String,
    /// `device-binding.dat` did not exist before this launch (created now).
    pub binding_new: bool,
    /// This binary's version (`CARGO_PKG_VERSION`), for the update token.
    pub running_version: String,
}

/// The startup state (contract table). `Fresh` and `Reuse` start the server; every other state
/// waits for the user's choice and has changed nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupState {
    Fresh { data_id: String },
    /// `adopt`: the install instance changed legitimately (application update with a valid token):
    /// the backend records the new instance; the runtime then removes the token.
    Reuse { data_id: String, adopt: bool },
    PriorDataFound { detail: String },
    Mismatch { detail: String },
    Corrupt { detail: String },
    TooNew { detail: String },
    DataMissing { detail: String },
}

impl StartupState {
    pub fn code(&self) -> &'static str {
        match self {
            StartupState::Fresh { .. } => "FRESH",
            StartupState::Reuse { .. } => "REUSE",
            StartupState::PriorDataFound { .. } => "PRIOR_DATA_FOUND",
            StartupState::Mismatch { .. } => "MISMATCH",
            StartupState::Corrupt { .. } => "CORRUPT",
            StartupState::TooNew { .. } => "TOO_NEW",
            StartupState::DataMissing { .. } => "DATA_MISSING",
        }
    }

    /// The options the screen offers, exactly as in contracts/data-root-and-startup-states.md.
    pub fn options(&self) -> &'static [&'static str] {
        match self {
            StartupState::Fresh { .. } | StartupState::Reuse { .. } => &[],
            StartupState::PriorDataFound { .. } => &["open_existing", "restore_backup", "start_new"],
            StartupState::Mismatch { .. } | StartupState::Corrupt { .. } => &["restore_backup", "start_new", "show_details"],
            StartupState::TooNew { .. } => &["install_newer"],
            StartupState::DataMissing { .. } => &["restore_backup", "locate", "start_new"],
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            StartupState::Fresh { .. } | StartupState::Reuse { .. } => "",
            StartupState::PriorDataFound { detail }
            | StartupState::Mismatch { detail }
            | StartupState::Corrupt { detail }
            | StartupState::TooNew { detail }
            | StartupState::DataMissing { detail } => detail,
        }
    }
}

/// Evidence that this root held company data before (so an empty-looking root is NOT fresh).
fn prior_data_evidence(app_data_root: &Path) -> Option<&'static str> {
    if meta_path(app_data_root).exists() {
        return Some("db-meta.json");
    }
    if app_data_root.join("pgdata").exists() {
        return Some("pgdata (بيانات إصدار PostgreSQL السابق)");
    }
    let manifest = fs::read_to_string(integrity_manifest_path(app_data_root))
        .ok()
        .and_then(|raw| serde_json::from_str::<IntegrityManifestLite>(&raw).ok());
    if manifest.map_or(false, |m| m.business_rows() > 0) {
        return Some("data-integrity.json");
    }
    None
}

fn norm(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|v| !v.is_empty())
}

/// The full state machine (data-model.md §5.1). READ-ONLY: never changes a file.
pub fn evaluate_startup_state(
    app_data_root: &Path,
    launch: &LaunchFacts,
    bundled_schema_idx: i32,
    mint_data_id: impl FnOnce() -> String,
) -> StartupState {
    let db = database_path(app_data_root);
    if !db.exists() {
        return match prior_data_evidence(app_data_root) {
            None => StartupState::Fresh { data_id: mint_data_id() },
            Some(evidence) => StartupState::DataMissing {
                detail: format!("ملف قاعدة البيانات ({}) غير موجود، مع وجود دليل على بيانات سابقة: {evidence}.", db.display()),
            },
        };
    }
    let facts = match inspect_database(&db) {
        Ok(f) => f,
        Err(e) => return StartupState::Corrupt { detail: e },
    };
    if facts.schema_journal_idx > bundled_schema_idx {
        return StartupState::TooNew {
            detail: format!("مخطط قاعدة البيانات ({}) أحدث من هذا البرنامج ({bundled_schema_idx}).", facts.schema_journal_idx),
        };
    }
    let meta = match read_meta(app_data_root) {
        Ok(m) => m,
        Err(e) => return StartupState::Mismatch { detail: e.to_string() },
    };
    let Some(meta) = meta else {
        return StartupState::PriorDataFound { detail: "قاعدة بيانات موجودة دون ملف الهوية db-meta.json لهذا التثبيت.".into() };
    };
    if norm(meta.data_id.as_deref()) != Some(facts.data_id.as_str())
        || (meta.tenant_id.is_some() && norm(meta.tenant_id.as_deref()) != norm(facts.tenant_id.as_deref()))
    {
        return StartupState::Mismatch {
            detail: format!(
                "ملف الهوية لا يطابق قاعدة البيانات (data_id {} ≠ {}).",
                meta.data_id.as_deref().unwrap_or("—"),
                facts.data_id
            ),
        };
    }
    if launch.binding_new {
        return StartupState::PriorDataFound { detail: "ربط هذا الجهاز جديد (تثبيت جديد أو حساب مستخدم مختلف).".into() };
    }
    let known = facts.created_by_installation_id == launch.installation_id
        || facts.adopted_installation_ids.iter().any(|i| i == &launch.installation_id);
    if !known {
        return StartupState::Mismatch { detail: "قاعدة البيانات أُنشئت لتثبيت آخر ولم تُعتمد على هذا الجهاز.".into() };
    }
    let marker = norm(launch.install_instance_marker.as_deref());
    let recorded = norm(facts.install_instance_id.as_deref());
    if marker == recorded {
        return StartupState::Reuse { data_id: facts.data_id, adopt: false };
    }
    // T084: an application update re-runs the installer; a marker that differs from the recorded one is
    // REUSE only when the hand-off token names the recorded instance and this binary is its target.
    if let Some(token) = read_update_token(app_data_root) {
        if norm(token.install_instance_id.as_deref()) == recorded && token.to_version == launch.running_version {
            return StartupState::Reuse { data_id: facts.data_id, adopt: true };
        }
    }
    // A NEWER program opening this company's data on this machine's own binding is an update, even
    // when the installer replaced the marker (running a new setup over the installed copy uninstalls
    // it first, and that removes the marker). Reinstalling the SAME version or an older one still
    // asks (D-1); a new machine/user binding was refused above.
    if facts
        .app_version_last_opened
        .as_deref()
        .is_some_and(|last| version_newer(&launch.running_version, last))
    {
        return StartupState::Reuse { data_id: facts.data_id, adopt: true };
    }
    StartupState::PriorDataFound { detail: "هذا تثبيت جديد للبرنامج وتوجد على الجهاز بيانات شركة سابقة.".into() }
}

/// "Start a new project" / before "Restore a backup": MOVE the current data, its identity sidecar,
/// integrity manifest, update token and backup registry into `<root>\set-aside\<timestamp>\`.
/// Nothing is deleted (C-13). Returns the set-aside directory (None when there was nothing).
#[hotpath::measure]
pub fn set_aside(app_data_root: &Path) -> io::Result<Option<PathBuf>> {
    let movable = [DATA_DIR, META_FILE, INTEGRITY_MANIFEST_FILE, UPDATE_TOKEN_FILE, BACKUP_REGISTRY_FILE];
    if !movable.iter().any(|m| app_data_root.join(m).exists()) {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut target = app_data_root.join(SET_ASIDE_DIR).join(format!("utc-{stamp}"));
    let mut n = 1;
    while target.exists() {
        target = app_data_root.join(SET_ASIDE_DIR).join(format!("utc-{stamp}-{n}"));
        n += 1;
    }
    fs::create_dir_all(&target)?;
    for m in movable {
        let from = app_data_root.join(m);
        if from.exists() {
            fs::rename(&from, target.join(m))?;
        }
    }
    Ok(Some(target))
}

/// A "Restore a backup" whose archive the server rejected: whatever the failed attempt created is
/// itself moved aside (kept, never deleted), then the data moved aside by that choice is put back.
pub fn undo_set_aside(app_data_root: &Path, aside: &Path) -> io::Result<()> {
    set_aside(app_data_root)?;
    for entry in fs::read_dir(aside)? {
        let entry = entry?;
        fs::rename(entry.path(), app_data_root.join(entry.file_name()))?;
    }
    let _ = fs::remove_dir(aside);
    Ok(())
}

/// A random RFC 4122 v4 UUID (the FRESH `data_id`).
pub fn new_data_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The installer's HKCU install-instance marker (T075), if present.
#[cfg(windows)]
pub fn read_install_instance_marker() -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(INSTALL_INSTANCE_KEY),
            &HSTRING::from(INSTALL_INSTANCE_VALUE),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if status.is_err() {
        return None;
    }
    let chars = (len as usize / 2).saturating_sub(1);
    let value = String::from_utf16_lossy(&buf[..chars.min(buf.len())]).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(not(windows))]
pub fn read_install_instance_marker() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const DATA_ID: &str = "11111111-1111-4111-8111-111111111111";
    const TENANT: &str = "22222222-2222-4222-8222-222222222222";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "motard-dbmeta-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every file under the root with its bytes — "no file changed" is compared on this.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.insert(p.clone(), fs::read(&p).unwrap());
                }
            }
        }
        out
    }

    /// A real SQLite database with a motard_meta row, like the backend creates.
    fn company(root: &Path, recorded_instance: Option<&str>, created_by: &str, adopted: &[&str]) {
        fs::create_dir_all(root.join(DATA_DIR)).unwrap();
        let conn = rusqlite::Connection::open(database_path(root)).unwrap();
        conn.execute_batch(
            "CREATE TABLE motard_meta (id INTEGER PRIMARY KEY, data_id TEXT NOT NULL, tenant_id TEXT, install_instance_id TEXT,
               schema_journal_idx INTEGER NOT NULL, created_by_installation_id TEXT NOT NULL, adopted_installation_ids TEXT NOT NULL DEFAULT '[]');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO motard_meta VALUES (1, ?1, ?2, ?3, 0, ?4, ?5)",
            rusqlite::params![DATA_ID, TENANT, recorded_instance, created_by, serde_json::to_string(adopted).unwrap()],
        )
        .unwrap();
        drop(conn);
        let meta = DbMeta {
            engine: Some("sqlite".into()),
            data_id: Some(DATA_ID.into()),
            tenant_id: Some(TENANT.into()),
            install_instance_id: recorded_instance.map(Into::into),
            installation_id: Some(created_by.into()),
            schema_journal_idx: 0,
        };
        fs::write(meta_path(root), serde_json::to_string(&meta).unwrap()).unwrap();
    }

    #[test]
    fn a_failed_restore_puts_the_previous_data_back_and_keeps_the_attempt() {
        let root = scratch("undo-aside");
        company(&root, Some("g1"), "inst-1", &[]);
        let original = fs::read(database_path(&root)).unwrap();
        let aside = set_aside(&root).unwrap().expect("moved");
        // the failed attempt created a fresh database
        fs::create_dir_all(root.join(DATA_DIR)).unwrap();
        fs::write(database_path(&root), b"attempt").unwrap();
        undo_set_aside(&root, &aside).unwrap();
        assert_eq!(fs::read(database_path(&root)).unwrap(), original, "previous database is back");
        assert!(meta_path(&root).exists(), "its sidecar is back");
        assert!(!aside.exists());
        let kept: Vec<_> = fs::read_dir(root.join(SET_ASIDE_DIR)).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1, "the failed attempt is kept aside, not deleted");
        assert_eq!(fs::read(kept[0].path().join(DATA_DIR).join("motard.db")).unwrap(), b"attempt");
    }

    #[test]
    fn inspecting_a_wal_database_creates_no_side_files() {
        let root = scratch("wal immutable %#");
        company(&root, Some("g1"), "inst-1", &[]);
        {
            let c = rusqlite::Connection::open(database_path(&root)).unwrap();
            c.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(())).unwrap();
        } // last close checkpoints and removes -wal/-shm
        let before = snapshot(&root);
        let facts = inspect_database(&database_path(&root)).expect("inspect");
        assert_eq!(facts.install_instance_id.as_deref(), Some("g1"));
        assert_eq!(snapshot(&root), before, "no -wal/-shm may appear");
    }

    #[test]
    fn inspection_sees_committed_rows_still_in_the_wal() {
        let root = scratch("wal-content");
        company(&root, Some("g1"), "inst-1", &[]);
        let writer = rusqlite::Connection::open(database_path(&root)).unwrap();
        writer.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(())).unwrap();
        writer.execute_batch("PRAGMA wal_autocheckpoint=0; UPDATE motard_meta SET install_instance_id = 'g2';").unwrap();
        assert!(fs::metadata(format!("{}-wal", database_path(&root).display())).unwrap().len() > 0);
        let facts = inspect_database(&database_path(&root)).expect("inspect");
        assert_eq!(facts.install_instance_id.as_deref(), Some("g2"), "an un-checkpointed commit is visible");
        drop(writer);
    }

    fn launch(marker: Option<&str>) -> LaunchFacts {
        LaunchFacts { install_instance_marker: marker.map(Into::into), installation_id: "inst-1".into(), binding_new: false, running_version: "2.0.0".into() }
    }

    fn eval(root: &Path, l: &LaunchFacts) -> StartupState {
        let before = snapshot(root);
        let s = evaluate_startup_state(root, l, 0, || "minted".into());
        assert_eq!(snapshot(root), before, "evaluation must never change a file ({})", s.code());
        s
    }

    #[test]
    fn fresh_on_an_empty_root() {
        let root = scratch("fresh");
        assert_eq!(eval(&root, &launch(None)), StartupState::Fresh { data_id: "minted".into() });
        fs::write(root.join("secrets.dat"), b"x").unwrap(); // a first boot that failed later is still fresh
        assert!(matches!(eval(&root, &launch(Some("g"))), StartupState::Fresh { .. }));
    }

    #[test]
    fn reuse_when_everything_agrees() {
        let root = scratch("reuse");
        company(&root, Some("guid-A"), "inst-1", &[]);
        assert_eq!(eval(&root, &launch(Some("guid-A"))), StartupState::Reuse { data_id: DATA_ID.into(), adopt: false });
        let both_absent = scratch("reuse-unmarked");
        company(&both_absent, None, "inst-1", &[]);
        assert!(matches!(eval(&both_absent, &launch(None)), StartupState::Reuse { adopt: false, .. }));
        // an installation adopted earlier ("Open existing") is known too
        let adopted = scratch("reuse-adopted");
        company(&adopted, Some("guid-A"), "inst-0", &["inst-1"]);
        assert!(matches!(eval(&adopted, &launch(Some("guid-A"))), StartupState::Reuse { .. }));
    }

    #[test]
    fn reuse_after_update_needs_a_valid_token() {
        let root = scratch("update");
        company(&root, Some("guid-A"), "inst-1", &[]);
        let token = |inst: &str, to: &str| UpdateToken { install_instance_id: Some(inst.into()), from_version: "1.9.0".into(), to_version: to.into(), created_at: "t".into() };
        write_update_token(&root, &token("guid-A", "2.0.0")).unwrap();
        assert_eq!(eval(&root, &launch(Some("guid-B"))), StartupState::Reuse { data_id: DATA_ID.into(), adopt: true });
        write_update_token(&root, &token("guid-A", "1.9.5")).unwrap(); // a token for another version
        assert!(matches!(eval(&root, &launch(Some("guid-B"))), StartupState::PriorDataFound { .. }));
        write_update_token(&root, &token("guid-X", "2.0.0")).unwrap(); // a token for another instance
        assert!(matches!(eval(&root, &launch(Some("guid-B"))), StartupState::PriorDataFound { .. }));
    }

    #[test]
    fn a_newer_version_over_the_installed_copy_is_an_update_not_a_new_installation() {
        let opened = |root: &Path, v: &str| {
            let c = rusqlite::Connection::open(database_path(root)).unwrap();
            c.execute_batch("ALTER TABLE motard_meta ADD COLUMN app_version_last_opened TEXT;").unwrap();
            c.execute("UPDATE motard_meta SET app_version_last_opened = ?1", [v]).unwrap();
        };
        let root = scratch("upgrade-manual");
        company(&root, Some("guid-A"), "inst-1", &[]);
        opened(&root, "1.9.0");
        // setup.exe 2.0.0 run over 1.9.0: the old uninstaller removed the marker, a new one was written
        assert_eq!(eval(&root, &launch(Some("guid-B"))), StartupState::Reuse { data_id: DATA_ID.into(), adopt: true });
        assert_eq!(eval(&root, &launch(None)), StartupState::Reuse { data_id: DATA_ID.into(), adopt: true });
        let mut moved = launch(Some("guid-B"));
        moved.binding_new = true;
        assert!(matches!(eval(&root, &moved), StartupState::PriorDataFound { .. }), "another machine/user still asks");

        let same = scratch("reinstall-same");
        company(&same, Some("guid-A"), "inst-1", &[]);
        opened(&same, "2.0.0");
        assert!(matches!(eval(&same, &launch(Some("guid-B"))), StartupState::PriorDataFound { .. }), "same version = reinstall");
        let older = scratch("downgrade");
        company(&older, Some("guid-A"), "inst-1", &[]);
        opened(&older, "2.1.0");
        assert!(matches!(eval(&older, &launch(Some("guid-B"))), StartupState::PriorDataFound { .. }), "downgrade asks");
        assert!(version_newer("2.0.10", "2.0.9") && !version_newer("2.0.0", "2.0.0-beta") && !version_newer("x", "1.0.0"));
    }

    #[test]
    fn prior_data_found_for_a_new_installation() {
        let root = scratch("prior");
        company(&root, Some("guid-A"), "inst-1", &[]);
        assert!(matches!(eval(&root, &launch(Some("guid-B"))), StartupState::PriorDataFound { .. }), "new instance, no token");
        assert!(matches!(eval(&root, &launch(None)), StartupState::PriorDataFound { .. }), "marker removed");
        let mut new_binding = launch(Some("guid-A"));
        new_binding.binding_new = true;
        assert!(matches!(eval(&root, &new_binding), StartupState::PriorDataFound { .. }), "device-binding.dat deleted");
        let no_sidecar = scratch("prior-no-sidecar");
        company(&no_sidecar, Some("guid-A"), "inst-1", &[]);
        fs::remove_file(meta_path(&no_sidecar)).unwrap();
        assert!(matches!(eval(&no_sidecar, &launch(Some("guid-A"))), StartupState::PriorDataFound { .. }));
        assert_eq!(StartupState::PriorDataFound { detail: String::new() }.options(), &["open_existing", "restore_backup", "start_new"]);
    }

    #[test]
    fn mismatch_when_sidecar_and_meta_disagree_or_the_binding_is_foreign() {
        let root = scratch("mismatch");
        company(&root, Some("guid-A"), "inst-1", &[]);
        let mut meta = read_meta(&root).unwrap().unwrap();
        meta.data_id = Some("33333333-3333-4333-8333-333333333333".into());
        fs::write(meta_path(&root), serde_json::to_string(&meta).unwrap()).unwrap();
        assert!(matches!(eval(&root, &launch(Some("guid-A"))), StartupState::Mismatch { .. }));
        let foreign = scratch("mismatch-foreign");
        company(&foreign, Some("guid-A"), "another-machine", &[]); // another VM's data root copied in
        assert!(matches!(eval(&foreign, &launch(Some("guid-A"))), StartupState::Mismatch { .. }));
    }

    #[test]
    fn corrupt_when_not_sqlite_truncated_or_no_meta() {
        let root = scratch("corrupt");
        fs::create_dir_all(root.join(DATA_DIR)).unwrap();
        fs::write(database_path(&root), b"this is not a database").unwrap();
        fs::write(meta_path(&root), format!(r#"{{"data_id":"{DATA_ID}"}}"#)).unwrap();
        assert!(matches!(eval(&root, &launch(None)), StartupState::Corrupt { .. }));
        let trunc = scratch("corrupt-truncated");
        company(&trunc, None, "inst-1", &[]);
        let bytes = fs::read(database_path(&trunc)).unwrap();
        fs::write(database_path(&trunc), &bytes[..bytes.len() / 2]).unwrap();
        assert!(matches!(eval(&trunc, &launch(None)), StartupState::Corrupt { .. }));
        let no_meta = scratch("corrupt-no-meta");
        fs::create_dir_all(no_meta.join(DATA_DIR)).unwrap();
        rusqlite::Connection::open(database_path(&no_meta)).unwrap().execute_batch("CREATE TABLE x (a INTEGER);").unwrap();
        assert!(matches!(eval(&no_meta, &launch(None)), StartupState::Corrupt { .. }));
    }

    #[test]
    fn too_new_when_the_schema_is_ahead_of_the_binary() {
        let root = scratch("too-new");
        company(&root, None, "inst-1", &[]);
        rusqlite::Connection::open(database_path(&root)).unwrap().execute("UPDATE motard_meta SET schema_journal_idx = 9", []).unwrap();
        let before = snapshot(&root);
        assert!(matches!(evaluate_startup_state(&root, &launch(None), 3, || "m".into()), StartupState::TooNew { .. }));
        assert_eq!(snapshot(&root), before);
    }

    #[test]
    fn data_missing_when_evidence_exists_without_a_database() {
        let root = scratch("missing");
        company(&root, None, "inst-1", &[]);
        fs::remove_dir_all(root.join(DATA_DIR)).unwrap(); // db-meta.json remains
        assert!(matches!(eval(&root, &launch(None)), StartupState::DataMissing { .. }));
        let pg = scratch("missing-pg");
        fs::create_dir_all(pg.join("pgdata")).unwrap();
        fs::write(pg.join("pgdata").join("PG_VERSION"), "17\n").unwrap();
        assert!(matches!(eval(&pg, &launch(None)), StartupState::DataMissing { .. }));
        let manifest = scratch("missing-manifest");
        fs::write(integrity_manifest_path(&manifest), r#"{"lastKnownCounts":{"invoices":3}}"#).unwrap();
        assert!(matches!(eval(&manifest, &launch(None)), StartupState::DataMissing { .. }));
    }

    #[test]
    fn start_new_moves_everything_aside_and_deletes_nothing() {
        let root = scratch("set-aside");
        company(&root, Some("guid-A"), "inst-1", &[]);
        fs::write(root.join(BACKUP_REGISTRY_FILE), b"{\"entries\":[]}").unwrap();
        fs::write(root.join("secrets.dat"), b"keep").unwrap();
        let db_bytes = fs::read(database_path(&root)).unwrap();
        let aside = set_aside(&root).unwrap().expect("something was moved");
        assert!(!database_path(&root).exists() && !meta_path(&root).exists() && !root.join(BACKUP_REGISTRY_FILE).exists());
        assert_eq!(fs::read(aside.join(DATA_DIR).join(DATABASE_FILE)).unwrap(), db_bytes, "the old data is intact");
        assert!(aside.join(META_FILE).exists() && aside.join(BACKUP_REGISTRY_FILE).exists());
        assert!(root.join("secrets.dat").exists(), "device secrets stay");
        assert!(matches!(evaluate_startup_state(&root, &launch(Some("guid-A")), 0, || "m".into()), StartupState::Fresh { .. }));
        assert_eq!(set_aside(&root).unwrap(), None);
    }

    #[test]
    fn options_match_the_contract() {
        let d = || String::new();
        assert_eq!(StartupState::Mismatch { detail: d() }.options(), &["restore_backup", "start_new", "show_details"]);
        assert_eq!(StartupState::Corrupt { detail: d() }.options(), &["restore_backup", "start_new", "show_details"]);
        assert_eq!(StartupState::TooNew { detail: d() }.options(), &["install_newer"]);
        assert_eq!(StartupState::DataMissing { detail: d() }.options(), &["restore_backup", "locate", "start_new"]);
    }

    #[test]
    fn the_pg_era_sidecar_parses_and_minted_ids_are_v4() {
        let root = scratch("pg-era-sidecar");
        fs::write(meta_path(&root), r#"{"installation_id":"a","pg_major":17,"schema_journal_idx":99}"#).unwrap();
        assert_eq!(read_meta(&root).unwrap().unwrap().data_id, None);
        let id = new_data_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(new_data_id(), id);
    }
}
