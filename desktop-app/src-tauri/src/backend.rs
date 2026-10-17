//! The backend process: bundled `node.exe` + `server\server.mjs`, served on a named pipe unique to
//! this launch, inside a Job Object so it can never outlive the shell (crash, kill, Windows logoff).

use crate::keys::Secrets;
use crate::paths::Paths;
use crate::state::InstallInfo;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const FATAL_MARK: &str = "[FATAL] Server startup failed:";
/// Inherited from the user's environment; everything else is cleared (no stray DATABASE_URL,
/// NODE_OPTIONS or developer secrets can reach the backend).
const ENV_WHITELIST: &[&str] = &[
    "SystemRoot", "SystemDrive", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA",
    "APPDATA", "COMPUTERNAME", "USERNAME", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA",
];
const BOOT_CODES: &[&str] = &[
    "FRESH_TARGET_EXISTS", "DATABASE_MISSING", "META_MISSING", "DATA_ID_MISMATCH", "SCHEMA_TOO_NEW",
    "SCHEMA_UNVERIFIED", "INSTALLATION_ID_REQUIRED", "INSTALL_INSTANCE_MISMATCH", "INTEGRITY_FAILED",
    "MIGRATION_FAILED",
];

pub struct Spawn<'a> {
    pub resources: &'a Path,
    pub paths: &'a Paths,
    pub secrets: &'a Secrets,
    /// FRESH or REUSE (see `state::decide`).
    pub startup_state: &'a str,
    pub install: &'a InstallInfo,
    pub expected_data_id: Option<&'a str>,
    pub restore_archive: Option<&'a Path>,
    pub app_version: &'a str,
}

pub struct Backend {
    pub child: Child,
    pub pipe: String,
    pub fatal: Arc<Mutex<Option<String>>>,
}

/// Map the backend's `[FATAL] Server startup failed: <reason>` to a recovery state.
pub fn classify(reason: &str) -> &'static str {
    BOOT_CODES.iter().find(|c| reason.contains(*c)).copied().unwrap_or("BOOT_FAILED")
}

pub fn env_for(s: &Spawn, pipe: &str, boot_id: &str) -> Vec<(String, String)> {
    let p = s.paths;
    let server = s.resources.join("server");
    let path = |x: &Path| x.display().to_string();
    let mut env: Vec<(String, String)> = ENV_WHITELIST
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();
    let public_key = std::fs::read_to_string(s.resources.join("license-public.pem")).unwrap_or_default();
    let mut set = |k: &str, v: String| env.push((k.to_string(), v));
    set("NODE_ENV", "production".into());
    set("DESKTOP_DEPLOY", "true".into());
    set("DESKTOP_PIPE", pipe.into());
    set("HOST", "127.0.0.1".into());
    set("CORS_ORIGIN", "http://tauri.localhost,tauri://localhost".into());
    set("LOG_DIR", path(&p.logs));
    set("LOG_LEVEL", "info".into());
    set("DB_ENGINE", "sqlite".into());
    set("SQLITE_PATH", path(&p.db));
    set("MOTARD_STARTUP_STATE", s.startup_state.into());
    set("MOTARD_INSTALLATION_ID", s.install.installation_id.clone());
    if s.startup_state == "FRESH" {
        set("MOTARD_DATA_ID", s.install.data_id.clone());
    } else if let Some(d) = s.expected_data_id {
        set("MOTARD_DATA_ID", d.into());
    }
    set("DESKTOP_SEED_PATH", path(&server.join("desktop-seed.json")));
    set("DESKTOP_SQLITE_MIGRATIONS_FOLDER", path(&server.join("sqlite-migrations")));
    set("DESKTOP_DB_META_PATH", path(&p.db_meta));
    set("DATA_INTEGRITY_PATH", path(&p.integrity));
    set("HUB_CONFIG_PATH", path(&p.sync_dir.join("hub.json")));
    set("HUB_SESSION_PATH", path(&p.sync_dir.join("hub-session.json")));
    set("HUB_CREDENTIALS_PATH", path(&p.sync_dir.join("hub-credentials.dat")));
    set("COMPANY_LOGO_DIR", path(&p.logos));
    set("JWT_SECRET", s.secrets.jwt_secret.clone());
    set("APP_MASTER_KEY", s.secrets.app_master_key.clone());
    set("LICENSE_SIGNING_PUBLIC_KEY", public_key);
    set("MOTARD_APP_VERSION", s.app_version.into());
    set("MOTARD_BOOT_ID", boot_id.into());
    if let Some(a) = s.restore_archive {
        set("MOTARD_RESTORE_ARCHIVE", path(a));
    }
    env
}

pub fn spawn(s: &Spawn) -> Result<Backend, String> {
    let pipe = format!(r"\\.\pipe\motard-erp-{}", uuid::Uuid::new_v4());
    let boot_id = uuid::Uuid::new_v4().to_string();
    let node = s.resources.join("runtime").join("node.exe");
    let server_dir = s.resources.join("server");
    let entry = server_dir.join("server.mjs");
    for f in [&node, &entry] {
        if !f.exists() {
            return Err(format!("PROGRAM_FILES_INCOMPLETE: {} is missing", f.display()));
        }
    }
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        // The bundle folder has no .env, so dotenv in the backend finds nothing to load.
        .current_dir(&server_dir)
        .env_clear()
        .envs(env_for(s, &pipe, &boot_id))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("SPAWN_FAILED: {e}"))?;
    #[cfg(windows)]
    if let Err(e) = job::assign(&child) {
        let _ = child.kill();
        return Err(format!("JOB_OBJECT_FAILED: {e}"));
    }
    let fatal = Arc::new(Mutex::new(None));
    let log = s.paths.logs.join("server.log");
    tee(child.stdout.take().unwrap(), log.clone(), fatal.clone());
    tee(child.stderr.take().unwrap(), log, fatal.clone());
    crate::logger::info(&format!("backend started pid={} state={} boot={boot_id}", child.id(), s.startup_state));
    Ok(Backend { child, pipe, fatal })
}

/// The boot failure reason so far, updated from one stderr line. The backend's own `[FATAL]` line
/// wins; an error thrown before its handler is installed (e.g. while a migration runs at import
/// time) only leaves Node's `SomethingError: …` line and stack, so that is kept as the fallback.
fn reason_from_line(line: &str, current: Option<&str>) -> Option<String> {
    if let Some(i) = line.find(FATAL_MARK) {
        return Some(line[i + FATAL_MARK.len()..].trim().to_string());
    }
    let t = line.trim();
    if current.is_none() && t.split_once(": ").is_some_and(|(k, _)| k.ends_with("Error") && !k.contains(' ')) {
        return Some(t.to_string());
    }
    match current {
        Some(c) if t.starts_with("at applyMigration") && !c.starts_with("MIGRATION_FAILED") => {
            Some(format!("MIGRATION_FAILED: {c}"))
        }
        _ => None,
    }
}

fn tee(
    stream: impl Read + Send + 'static,
    log: PathBuf,
    fatal: Arc<Mutex<Option<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).trim_end().to_string();
            {
                // One guard: a second `fatal.lock()` while the first is alive (e.g. one taken in an
                // `if let` condition, which lives through the body) deadlocks this thread and then
                // `wait_healthy`, so a failed boot would never reach the recovery screen.
                let mut reason = fatal.lock().unwrap();
                if let Some(next) = reason_from_line(&text, reason.as_deref()) {
                    *reason = Some(next);
                }
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log) {
                let _ = writeln!(f, "{text}");
            }
        }
    })
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // The handle is never closed: the OS closes it when the shell exits, which kills the backend.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Result<HANDLE, String> {
        if let Some(h) = JOB.get() {
            return Ok(HANDLE(*h as *mut _));
        }
        unsafe {
            let h = CreateJobObjectW(None, PCWSTR::null()).map_err(|e| e.to_string())?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| e.to_string())?;
            Ok(HANDLE(*JOB.get_or_init(|| h.0 as usize) as *mut _))
        }
    }

    pub fn assign(child: &Child) -> Result<(), String> {
        let j = job()?;
        unsafe { AssignProcessToJobObject(j, HANDLE(child.as_raw_handle())).map_err(|e| e.to_string()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_failures_map_to_recovery_states() {
        assert_eq!(classify("DATA_ID_MISMATCH: database data_id a ≠ expected b"), "DATA_ID_MISMATCH");
        assert_eq!(classify("SqliteBootError SCHEMA_TOO_NEW: 40 > 39"), "SCHEMA_TOO_NEW");
        assert_eq!(classify("near \"ALTR\": syntax error"), "BOOT_FAILED");
    }

    #[test]
    fn an_import_time_migration_error_is_captured_without_a_fatal_line() {
        let mut r: Option<String> = None;
        for line in [
            r"C:xwrappers.js:9",
            "SqliteError: table \"motard_drive_folders\" already exists",
            r"    at Database.exec (C:xwrappers.js:9:14)",
            "    at applyMigration (file:///C:/x/server.mjs:64982:7)",
            "    at applyMigration (file:///C:/x/server.mjs:64982:7)",
        ] {
            if let Some(n) = reason_from_line(line, r.as_deref()) {
                r = Some(n);
            }
        }
        let r = r.unwrap();
        assert_eq!(r, "MIGRATION_FAILED: SqliteError: table \"motard_drive_folders\" already exists");
        assert_eq!(classify(&r), "MIGRATION_FAILED");
        assert_eq!(reason_from_line("[FATAL] Server startup failed: DATA_ID_MISMATCH: x", Some(&r)).as_deref(), Some("DATA_ID_MISMATCH: x"));
    }

    #[test]
    fn tee_records_a_fatal_reason_without_deadlocking() {
        let dir = std::env::temp_dir().join(format!("motard-tee-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fatal = Arc::new(Mutex::new(None));
        let input = "starting\nSqliteError: table \"x\" already exists\n    at applyMigration (s.mjs:1:1)\n\
                     [FATAL] Server startup failed: DATA_ID_MISMATCH: a ≠ b\n";
        let handle = tee(std::io::Cursor::new(input.as_bytes().to_vec()), dir.join("server.log"), fatal.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || tx.send(handle.join().is_ok()).unwrap());
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)), Ok(true), "tee thread hung");
        assert_eq!(fatal.lock().unwrap().as_deref(), Some("DATA_ID_MISMATCH: a ≠ b"));
        assert!(std::fs::read_to_string(dir.join("server.log")).unwrap().contains("already exists"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn env_is_a_closed_contract() {
        std::env::set_var("DATABASE_URL", "postgres://should-not-leak");
        std::env::set_var("NODE_OPTIONS", "--inspect");
        let root = std::env::temp_dir().join("motard-env-test");
        let paths = Paths::at(&root);
        let secrets = Secrets { version: 1, app_master_key: "k".into(), jwt_secret: "j".into() };
        let install = InstallInfo { installation_id: "i".into(), data_id: "d".into(), ..Default::default() };
        let spawn = Spawn {
            resources: &root, paths: &paths, secrets: &secrets, startup_state: "REUSE", install: &install,
            expected_data_id: Some("d"), restore_archive: None, app_version: "3.0.0",
        };
        let env = env_for(&spawn, r"\\.\pipe\x", "b");
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("DATABASE_URL"), None);
        assert_eq!(get("NODE_OPTIONS"), None);
        assert_eq!(get("DB_ENGINE"), Some("sqlite"));
        assert_eq!(get("DESKTOP_DEPLOY"), Some("true"));
        assert_eq!(get("MOTARD_STARTUP_STATE"), Some("REUSE"));
        assert_eq!(get("MOTARD_DATA_ID"), Some("d"));
        assert_eq!(get("SQLITE_PATH"), Some(paths.db.to_str().unwrap()));
        assert!(get("LICENSE_SIGNING_KEY").is_none());
    }
}
