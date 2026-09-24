// Stack — process lifecycle for the self-contained Windows Desktop build.
//
// This module owns WHAT runs (PostgreSQL + Node backend + SSR frontend,
// in that order) while the sibling modules own the cross-cutting rules:
//   - `stages`  — the explicit boot order + splash labels,
//   - `error`   — one failure ⟹ one originating stage + one dialog,
//   - `ports`   — dynamic DB-port management (never 5432 by default),
//   - `health`  — bounded readiness gates with hard deadlines.
//
// The ERP business logic itself is untouched: this layer only prepares the
// database directory, starts processes, injects env, waits for the backend's
// OWN health signal, and shuts everything down on exit. No business logic
// is forked, reimplemented, or duplicated here (Plan §1.1).
//
// Boot order (mirrors `stages::ALL`; DeviceBinding runs in main.rs first):
//   step 1  provision a PostgreSQL data dir (copy baked template OR initdb+createdb)
//   step 2  start postgres.exe (bundled under resources/postgres/bin)
//   step 3  wait until the DB accepts TCP connections
//   step 4  generate/load locally-encrypted secrets (DPAPI) for the backend
//   step 5  start the Node backend (bundled node.exe + dist) with those secrets
//           injected via env (JWT_SECRET, APP_MASTER_KEY, DATABASE_URL, ...)
//   step 6  start the SSR frontend server (parallel with backend init)
//   step 7  wait until /api/health/live returns 200
//   step 8  wait until /__health returns 200, then show the main window
//   shutdown: stop the backend child and stop postgres (pg_ctl stop -m fast)
//
// Failure rule: the FIRST failing step shows ONE dialog naming the true
// cause, cleans up everything already started, and returns a `BootFailure`
// carrying the originating stage — downstream layers never get to report
// their own noise (Plan §0.2).
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::error::BootFailure;
use super::health::{http_get_ok, wait_ready, wait_tcp, WaitOutcome};
use super::ports::{
    find_free_db_port, find_free_server_port, persist_db_port, persist_server_port, resolve_db_port,
    resolve_server_port, sync_pg_conf_port,
};
use super::stages::BootStage;

use crate::db_meta::{
    bundled_pg_major, bundled_schema_journal_idx, evaluate_existing_cluster, stamp_fresh_cluster,
    ClusterDecision,
};
use crate::hidden_process::{HiddenChild, HiddenCommand};
use crate::secret_store;

// Fixed identities for the bundled, single-tenant, single-machine deployment.
const DB_NAME: &str = "erp";
const DB_SUPERUSER: &str = "postgres";

/// P2-5: present once the bundled cluster's superuser password has been set
/// from the DPAPI store and pg_hba.conf flipped to scram-sha-256. Absent on a
/// freshly copied template (which still trusts localhost) — the boot then
/// performs the one-time password establishment described in
/// `establish_scram_auth`, and never trusts again.
const SCRAM_PW_SET_MARKER: &str = ".motard-scram-pw-set";

#[derive(Clone, Debug)]
pub struct BootConfig {
    /// Directory containing the bundled `postgres/`, `server/` and `node.exe`. For a packaged app this is the
    /// Tauri resource dir; for the probe it is `src-tauri/resources`.
    pub resources_root: PathBuf,
    /// Per-user data dir, e.g. `%LOCALAPPDATA%/motard-erp`. Holds the live `pgdata`, `secrets.dat`,
    /// `device-binding.dat`.
    pub app_data_root: PathBuf,
    /// Node runtime used to launch the server. Packaged app: `node.exe` inside `resources_root`.
    pub node_exe: PathBuf,
    /// The bundled server: `server.mjs` (whole backend, esbuild bundle) + `web/` (built SPA) + `migrations/`.
    pub server_dir: PathBuf,
    /// `server_dir/server.mjs`.
    pub server_js: PathBuf,
    /// `server_dir/web` — served by the server on the same origin as the API.
    pub web_dir: PathBuf,
    /// `server_dir/migrations` — drizzle SQL read at boot.
    pub migrations_dir: PathBuf,
    /// File the server writes its OS-assigned port to once it is really accepting connections.
    pub port_file: PathBuf,
    /// The Ed25519 *public* key (PEM) for DESKTOP_DEPLOY verify-only license checks. The private key is NEVER
    /// injected (see spawn_server).
    pub license_public_key: Option<String>,
    pub db_port: u16,
    /// Preferred port for the server (API + UI). Stable across launches so the browser origin — and everything
    /// the UI stores under it — survives restarts; replaced only when it is actually taken.
    pub server_port: u16,
    /// Stable install identity from DPAPI `device-binding.dat`. Empty is refused.
    pub installation_id: String,
}

impl BootConfig {
    /// Resolve a config for the packaged app given Tauri's resource directory.
    pub fn for_app(resource_dir: PathBuf) -> Result<Self, String> {
        let server_dir = resource_dir.join("server");
        let license_public_key = fs::read_to_string(resource_dir.join("license-public.pem")).ok();
        let app_data_root = crate::app_data_dir()?;
        let db_port = resolve_db_port(&app_data_root);
        let server_port = resolve_server_port(&app_data_root);
        Ok(BootConfig {
            resources_root: resource_dir.clone(),
            port_file: app_data_root.join("server-port.json"),
            app_data_root,
            node_exe: resource_dir.join("node.exe"),
            server_js: server_dir.join("server.mjs"),
            web_dir: server_dir.join("web"),
            migrations_dir: server_dir.join("migrations"),
            server_dir,
            license_public_key,
            db_port,
            server_port,
            installation_id: String::new(),
        })
    }
}

// ── Port management lives in `super::ports` (never default to 5432).

pub struct DesktopStack {
    pub resources_root: PathBuf,
    pub pgdata_dir: PathBuf,
    pub db_port: u16,
    /// The OS-assigned port the single server (API + UI) is listening on.
    pub server_port: u16,
    server: Option<HiddenChild>,
}

impl DesktopStack {
    /// URL of the application (same origin for the UI and the API).
    pub fn app_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server_port)
    }
}

// ── Recursive copy (used to clone a baked pgdata-template) ──────────────────
fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn pg_bin(resources_root: &Path) -> PathBuf {
    resources_root.join("postgres").join("bin")
}

/// Strip Windows extended-length path prefix (`\\?\`) from a path.
/// pg_ctl and other bundled tools cannot resolve sibling executables when
/// the path uses the `\\?\` verbatim prefix that Tauri's resource_dir()
/// returns on Windows.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

/// CREATE_NO_WINDOW (winbase.h, 0x08000000).
///
/// NOTE: this alone was verified (live testing, 2026-09-03) to NOT reliably
/// suppress the console window for the long-running postgres/node children —
/// see `crate::hidden_process`, which those now go through instead via raw
/// CreateProcessW + STARTUPINFOW.wShowWindow = SW_HIDE. This flag is kept
/// only for `no_window_command` below, used by main.rs's short one-shot
/// fingerprint commands (getmac/reg/wmic), where an occasional brief flash
/// is a materially smaller problem than for a process that runs the whole
/// session — not yet migrated to hidden_process to keep this change scoped.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command::new` wrapper for short one-shot commands (main.rs's fingerprint
/// helpers). See the note on `CREATE_NO_WINDOW` above for why the
/// long-running subprocess spawns in this file use `hidden_process` instead.
pub fn no_window_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// (Boot deadline accounting lives in `super::health`.)

const FACTORY_RESET_FLAG: &str = "factory-reset.requested";
/// First-launch staging dir; renamed to `pgdata` only once fully provisioned.
const PROVISIONING_DIR: &str = "pgdata.provisioning";
/// Written only by the initdb path; consumed by the one `createdb` it needs.
const NEEDS_CREATEDB_MARKER: &str = ".motard-needs-createdb";

#[derive(Debug, PartialEq, Eq)]
enum PidLock {
    Stale { pid: u32 },
    Live { pid: u32 },
}

fn classify_postmaster_pid(contents: &str, is_running: impl Fn(u32) -> bool) -> PidLock {
    let pid = contents
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    if pid == 0 {
        return PidLock::Stale { pid: 0 };
    }
    if is_running(pid) {
        PidLock::Live { pid }
    } else {
        PidLock::Stale { pid }
    }
}

/// True only when `pid` is a live `postgres.exe`. After a power cut the
/// stale postmaster.pid can name a PID Windows has since handed to an
/// unrelated process; treating that as "postgres still running" used to
/// block startup with a bogus "close the old PostgreSQL" error.
fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == 259; // STILL_ACTIVE
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let named = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !alive {
                return false;
            }
            if !named {
                // Cannot tell what it is: stay on the safe side (treat as live).
                return true;
            }
            is_postgres_image(&String::from_utf16_lossy(&buf[..len as usize]))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

fn is_postgres_image(path: &str) -> bool {
    path.rsplit(['\\', '/'])
        .next()
        .map_or(false, |name| name.eq_ignore_ascii_case("postgres.exe"))
}

fn remove_stale_lock_files(pgdata: &Path) {
    for stale in ["postmaster.pid", "postmaster.opts", "current_logfiles"] {
        let _ = fs::remove_file(pgdata.join(stale));
    }
}

/// P0-3: on reuse, a crash leaves postmaster.pid. Clear it if the PID is dead;
/// if an orphan postgres is still alive, stop it via pg_ctl before we start.
fn cleanup_stale_cluster_lock(resources_root: &Path, pgdata: &Path) -> io::Result<()> {
    let pid_file = pgdata.join("postmaster.pid");
    if !pid_file.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(&pid_file).unwrap_or_default();
    match classify_postmaster_pid(&contents, pid_is_running) {
        PidLock::Stale { pid } => {
            log(&format!("removing stale postmaster.pid (pid {pid} not running)"));
            remove_stale_lock_files(pgdata);
            Ok(())
        }
        PidLock::Live { pid } => {
            log(&format!("orphan postgres pid {pid} still running — requesting stop"));
            let _ = stop_postgres(resources_root, pgdata);
            if pid_is_running(pid) {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!(
                        "عملية PostgreSQL قديمة ما زالت تعمل (PID {pid}) وتشغل مجلد البيانات.\n\
                         أغلق البرنامج من مدير المهام ثم أعد المحاولة."
                    ),
                ));
            }
            remove_stale_lock_files(pgdata);
            Ok(())
        }
    }
}

fn apply_requested_factory_reset(cfg: &BootConfig) -> io::Result<()> {
    let flag = cfg.app_data_root.join(FACTORY_RESET_FLAG);
    if !flag.exists() {
        return Ok(());
    }
    // The operator confirmed a reset in the UI (typed phrase). Nothing is
    // deleted: the live cluster is RENAMED aside (same volume, atomic) and the
    // next step provisions a fresh one. Refusing here instead would leave the
    // app unable to start until someone deleted the flag by hand.
    log("factory-reset requested — moving pgdata aside (kept as pgdata.reset-*)");
    let pgdata = cfg.app_data_root.join("pgdata");
    if pgdata.join("postmaster.pid").exists() {
        cleanup_stale_cluster_lock(&cfg.resources_root, &pgdata)?;
    }
    let archived = move_pgdata_aside(&cfg.app_data_root)?;
    let _ = fs::remove_file(crate::db_meta::meta_path(&cfg.app_data_root));
    let _ = fs::remove_file(cfg.app_data_root.join("hub-session.json"));
    fs::remove_file(&flag)?;
    let mut details = serde_json::Map::new();
    details.insert(
        "archivedTo".into(),
        serde_json::Value::String(
            archived.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        ),
    );
    super::boot_log::event("FACTORY_RESET", "factory_reset", details);
    Ok(())
}

/// Hub pairing state written by the server next to pgdata (hubConfig.ts).
const HUB_PAIRING_FILES: [&str; 3] = ["hub.json", "hub-session.json", "hub-credentials.dat"];

/// How many reset archives (`pgdata.reset-*`) to keep; older ones are removed.
const RESET_ARCHIVES_KEPT: usize = 3;

/// Rename `pgdata` to `pgdata.reset-<utc>` (same volume → atomic, instant).
/// Returns the archive path, or None when there was no pgdata.
pub(crate) fn move_pgdata_aside(app_data_root: &Path) -> io::Result<Option<PathBuf>> {
    let pgdata = app_data_root.join("pgdata");
    if !pgdata.exists() {
        return Ok(None);
    }
    let mut target = app_data_root.join(format!("pgdata.reset-{}", chrono_like_utc_stamp()));
    let mut n = 1;
    while target.exists() {
        target = app_data_root.join(format!("pgdata.reset-{}-{n}", chrono_like_utc_stamp()));
        n += 1;
    }
    fs::rename(&pgdata, &target)?;
    // The integrity manifest describes the archived cluster, not the fresh one
    // about to be created — keep it WITH the archive. Left in place it would
    // make the next boot refuse ("data missing") and the app would never start.
    let manifest = crate::db_meta::integrity_manifest_path(app_data_root);
    if manifest.exists() {
        let _ = fs::rename(&manifest, target.join("data-integrity.before-reset.json"));
    }
    // The hub pairing belongs to the archived company too. Left in place, the
    // fresh company would come up paired to the OLD hub — pulling the old
    // company's documents into the new database and pushing new ones into the
    // old hub. Kept with the archive (recoverable), never deleted.
    for name in HUB_PAIRING_FILES {
        let p = app_data_root.join(name);
        if p.exists() {
            let _ = fs::rename(&p, target.join(format!("{name}.before-reset")));
        }
    }
    // Retention: keep the newest few archives (names sort by utc stamp).
    let mut archives: Vec<PathBuf> = fs::read_dir(app_data_root)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n.starts_with("pgdata.reset-"))
        })
        .collect();
    archives.sort();
    while archives.len() > RESET_ARCHIVES_KEPT {
        let oldest = archives.remove(0);
        let _ = fs::remove_dir_all(&oldest);
    }
    Ok(Some(target))
}

fn chrono_like_utc_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("utc-{secs}")
}

pub fn request_factory_reset(app_data_root: &Path) -> io::Result<()> {
    fs::create_dir_all(app_data_root)?;
    fs::write(app_data_root.join(FACTORY_RESET_FLAG), b"1")
}

// ── Step 1: ensure a usable PostgreSQL data directory ───────────────────────
fn ensure_pgdata(cfg: &BootConfig, db_password: &str) -> io::Result<PathBuf> {
    let resources_root = &cfg.resources_root;
    let app_data_root = &cfg.app_data_root;
    let pgdata = app_data_root.join("pgdata");
    if cfg.installation_id.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "هوية التثبيت فارغة — تعذّر تجهيز قاعدة البيانات",
        ));
    }
    let pg_major = bundled_pg_major(resources_root).or_else(|_| {
        if pgdata.join("PG_VERSION").exists() {
            crate::db_meta::read_pg_major(&pgdata.join("PG_VERSION"))
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "تعذّر قراءة إصدار PostgreSQL المرفق",
            ))
        }
    })?;
    let schema_idx = bundled_schema_journal_idx(&cfg.migrations_dir);

    match evaluate_existing_cluster(
        app_data_root,
        &pgdata,
        &cfg.installation_id,
        pg_major,
        schema_idx,
    )? {
        ClusterDecision::Reuse => {
            log("pgdata already provisioned — reusing after identity/pid checks");
            let mut details = serde_json::Map::new();
            details.insert("pgdataExists".into(), serde_json::Value::Bool(true));
            details.insert(
                "metaPresent".into(),
                serde_json::Value::Bool(crate::db_meta::meta_path(app_data_root).exists()),
            );
            details.insert("schemaIdx".into(), serde_json::json!(schema_idx));
            details.insert("bundledSchemaIdx".into(), serde_json::json!(schema_idx));
            details.insert("pgMajor".into(), serde_json::json!(pg_major));
            details.insert(
                "installationIdPrefix".into(),
                serde_json::Value::String(cfg.installation_id.chars().take(8).collect()),
            );
            super::boot_log::event("REUSE", "ensure_pgdata", details);
            ensure_pg_subdirs(&pgdata)?;
            cleanup_stale_cluster_lock(resources_root, &pgdata)?;
            return Ok(pgdata);
        }
        ClusterDecision::Fresh => {}
    }

    // `evaluate_existing_cluster` already refused any existing pgdata that is
    // not a valid cluster, so reaching here means: no pgdata, no evidence of a
    // prior cluster. Provision into a staging dir and rename it into place only
    // when complete — an interrupted first launch (power cut mid-copy) then
    // leaves `pgdata.provisioning` (our own partial copy, safe to discard)
    // instead of a half-copied `pgdata` that every later boot would refuse.
    let staging = app_data_root.join(PROVISIONING_DIR);
    if staging.exists() {
        log("discarding an interrupted first-launch copy (pgdata.provisioning)");
        fs::remove_dir_all(&staging)?;
    }

    // Preferred path for a genuinely fresh install only: ship a baked,
    // already-migrated+seeded data dir.
    let template = resources_root.join("postgres").join("pgdata-template");
    if template.join("PG_VERSION").exists() {
        log(&format!(
            "copying baked pgdata-template -> {}",
            pgdata.display()
        ));
        copy_dir_all(&template, &staging)?;
        // WiX strips EMPTY directories from the MSI (empty dirs are not
        // packaged), so the installed pgdata-template is missing PostgreSQL's
        // required empty subdirectories (pg_notify, pg_logical/snapshots, ...).
        // Recreate the full set before first start, otherwise the server aborts
        // with "could not open directory".
        ensure_pg_subdirs(&staging)?;
        // The baked template may carry stale live-server artifacts from the
        // build machine; remove them so pg_ctl treats the copy as fresh.
        for stale in ["postmaster.pid", "postmaster.opts", "current_logfiles"] {
            let _ = fs::remove_file(staging.join(stale));
        }
        fs::rename(&staging, &pgdata)?;
        stamp_fresh_cluster(app_data_root, &cfg.installation_id, pg_major, 0)?;
        let mut details = serde_json::Map::new();
        details.insert("pgdataExists".into(), serde_json::Value::Bool(false));
        details.insert(
            "reason".into(),
            serde_json::Value::String("baked-template".into()),
        );
        details.insert("pgMajor".into(), serde_json::json!(pg_major));
        details.insert(
            "installationIdPrefix".into(),
            serde_json::Value::String(cfg.installation_id.chars().take(8).collect()),
        );
        super::boot_log::event("FRESH_TEMPLATE", "ensure_pgdata", details);
        return Ok(pgdata);
    }

    // Fallback (never used in the final package, only for first-run safety):
    // initialize a fresh cluster and create the `erp` database.
    // P2-5: scram-sha-256 from the very first initdb — the bundled cluster
    // never trusts any connection, and the superuser password lives only in
    // the DPAPI-encrypted secrets store (never in the installer payload).
    log("no pgdata-template — running initdb");
    let bindir = pg_bin(resources_root);
    let initdb = strip_verbatim_prefix(&bindir.join("initdb.exe"));
    let pgdata_str = staging.to_string_lossy().into_owned();
    fs::create_dir_all(&staging).ok();
    let pwfile = app_data_root.join(".initdb-pwfile");
    fs::write(&pwfile, db_password)?;
    let pwfile_str = pwfile.to_string_lossy().into_owned();
    let ok = HiddenCommand::new(&initdb)
        .args([
            "-D",
            &pgdata_str,
            "-U",
            DB_SUPERUSER,
            "--pwfile",
            &pwfile_str,
            "--auth=scram-sha-256",
            "-E",
            "UTF8",
        ])
        .spawn()?
        .wait_success()?;
    let _ = fs::remove_file(&pwfile);
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "initdb failed — see pgdata/pg.log",
        ));
    }
    // initdb already wrote a scram-sha-256 pg_hba.conf and set the superuser
    // password — record that so start_postgres skips the trust bootstrap.
    fs::write(staging.join(SCRAM_PW_SET_MARKER), b"initdb-scram")?;
    // One-shot: only a cluster initdb just created may get a new `erp` db.
    fs::write(staging.join(NEEDS_CREATEDB_MARKER), b"1")?;
    fs::rename(&staging, &pgdata)?;
    stamp_fresh_cluster(app_data_root, &cfg.installation_id, pg_major, 0)?;
    let mut details = serde_json::Map::new();
    details.insert(
        "reason".into(),
        serde_json::Value::String("initdb".into()),
    );
    details.insert("pgMajor".into(), serde_json::json!(pg_major));
    details.insert(
        "installationIdPrefix".into(),
        serde_json::Value::String(cfg.installation_id.chars().take(8).collect()),
    );
    super::boot_log::event("FRESH_INITDB", "ensure_pgdata", details);
    Ok(pgdata)
}

/// P2-5: rewrite pg_hba.conf so every TCP connection requires scram-sha-256.
///
/// The bundled PostgreSQL binds to 127.0.0.1 only, but `trust` still let any
/// local process (including unrelated software running on the customer's
/// machine) connect as the superuser and read every tenant's rows. This
/// converts active `host` lines whose auth method is not already
/// `scram-sha-256`. `local` lines are left alone: unix sockets are disabled
/// (`unix_socket_directories=`) on Windows, so they are unreachable.
///
/// Returns true when the file changed, so the caller can `pg_ctl reload`
/// before relying on the new policy.
fn harden_pg_hba(pgdata: &Path) -> io::Result<bool> {
    let path = pgdata.join("pg_hba.conf");
    if !path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("pg_hba.conf missing at {}", path.display()),
        ));
    }
    let original = fs::read_to_string(&path)?;
    let mut changed = false;
    let mut out = String::with_capacity(original.len());
    for line in original.lines() {
        // Preserve comments and blank lines verbatim.
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let mut fields: Vec<&str> = line.split_whitespace().collect();
        // Only TCP entries: local/replication socket lines are inert here.
        let is_tcp = matches!(fields.first(), Some(&"host" | &"hostssl" | &"hostnossl"));
        if is_tcp && fields.len() >= 4 {
            let method = fields.last_mut().unwrap();
            if *method != "scram-sha-256" {
                *method = "scram-sha-256";
                changed = true;
            }
        }
        out.push_str(&fields.join(" "));
        out.push('\n');
    }
    if changed {
        fs::write(&path, out)?;
    }
    Ok(changed)
}

/// PostgreSQL requires these subdirectories to exist inside a data dir.
/// WiX does not package empty directories, so they never make it into the
/// installed pgdata-template; create them defensively after the copy.
fn ensure_pg_subdirs(pgdata: &Path) -> io::Result<()> {
    for rel in [
        "base",
        "global",
        "log",
        "pg_commit_ts",
        "pg_dynshmem",
        "pg_logical/mappings",
        "pg_logical/snapshots",
        "pg_multixact/members",
        "pg_multixact/offsets",
        "pg_notify",
        "pg_replslot",
        "pg_serial",
        "pg_snapshots",
        "pg_stat",
        "pg_stat_tmp",
        "pg_subtrans",
        "pg_tblspc",
        "pg_twophase",
        "pg_wal/archive_status",
        "pg_wal/summaries",
        "pg_xact",
    ] {
        fs::create_dir_all(pgdata.join(rel))?;
    }
    Ok(())
}

// (postgresql.conf port sync lives in `super::ports::sync_pg_conf_port`.)

/// Runtime-critical bundled files. If any of these is missing at boot the stack
/// cannot start. The check is cheap (a handful of stat()s) and turns a silent,
/// baffling crash into an actionable message for the user.
///
/// Phase 7: when `resources/resource-manifest.json` is present, also verify
/// any entry that carries a 64-hex `sha256` (tamper / AV-quarantine detection).
fn preflight_check(cfg: &BootConfig) -> Result<(), Vec<String>> {
    let bin = cfg.resources_root.join("postgres").join("bin");
    let required = vec![
        bin.join("postgres.exe"),
        bin.join("pg_ctl.exe"),
        bin.join("initdb.exe"),
        bin.join("pg_dump.exe"),
        bin.join("pg_restore.exe"),
        bin.join("libpq.dll"),
        cfg.node_exe.clone(),
        cfg.server_js.clone(),
        cfg.web_dir.join("_shell.html"),
        cfg.migrations_dir.join("meta").join("_journal.json"),
        cfg.resources_root
            .join("postgres")
            .join("pgdata-template")
            .join("PG_VERSION"),
    ];
    let mut problems: Vec<String> = required
        .iter()
        .filter(|f| !f.exists())
        .map(|f| f.display().to_string())
        .collect();
    if let Err(integrity) = verify_resource_sha256s(&cfg.resources_root) {
        problems.extend(integrity);
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

#[derive(serde::Deserialize)]
struct ResourceManifestFile {
    required: Vec<ResourceManifestEntry>,
}

#[derive(serde::Deserialize)]
struct ResourceManifestEntry {
    path: String,
    kind: String,
    #[serde(default)]
    sha256: Option<String>,
}

fn verify_resource_sha256s(resources_root: &Path) -> Result<(), Vec<String>> {
    use sha2::{Digest, Sha256};
    let manifest_path = resources_root.join("resource-manifest.json");
    if !manifest_path.exists() {
        return Ok(());
    }
    let text = match fs::read_to_string(&manifest_path) {
        Ok(t) => t,
        Err(e) => {
            return Err(vec![format!(
                "resource-manifest.json unreadable: {e}"
            )]);
        }
    };
    let manifest: ResourceManifestFile = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            return Err(vec![format!("resource-manifest.json invalid JSON: {e}")]);
        }
    };
    let mut mismatches = Vec::new();
    for entry in manifest.required {
        let Some(expected) = entry.sha256.filter(|h| {
            h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())
        }) else {
            continue;
        };
        if entry.kind != "file" {
            continue;
        }
        let full = resources_root.join(&entry.path);
        let bytes = match fs::read(&full) {
            Ok(b) => b,
            Err(e) => {
                mismatches.push(format!("{}: cannot read for sha256 ({e})", entry.path));
                continue;
            }
        };
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(&expected) {
            mismatches.push(format!(
                "{}: sha256 mismatch (expected {}, got {})",
                entry.path, expected, actual
            ));
        }
    }
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(mismatches)
    }
}

/// Native Win32 MessageBox used ONLY for fatal boot errors before the Tauri
/// window exists. Prevents the "app opens and instantly closes" failure mode
/// from leaving the user with zero information. Automated probes set
/// ME_HEADLESS=1 to assert the error without a blocking dialog.
#[cfg(windows)]
pub fn show_fatal_dialog(title: &str, message: &str) {
    if std::env::var("ME_HEADLESS").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[fatal-dialog] {} :: {}", title, message);
        return;
    }
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    use windows::core::HSTRING;
    let flags = MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST;
    unsafe {
        let _ = MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from(title),
            flags,
        );
    }
}

#[cfg(not(windows))]
pub fn show_fatal_dialog(_title: &str, _message: &str) {}

// ── Step 2/3: start postgres and make sure the `erp` db exists ───────────────
fn start_postgres(
    resources_root: &Path,
    pgdata: &Path,
    db_port: u16,
    db_password: &str,
) -> io::Result<()> {
    let bindir = pg_bin(resources_root);
    let pg_ctl = strip_verbatim_prefix(&bindir.join("pg_ctl.exe"));
    let pgdata_str = pgdata.to_string_lossy().into_owned();
    let log_path = pgdata.join("pg.log");
    let log_str = log_path.to_string_lossy().into_owned();
    // Durability is pinned on the command line so no edited/restored
    // postgresql.conf can weaken it: a committed invoice or cashbox movement
    // must survive a power cut. On Windows `wal_sync_method=fsync` is
    // FlushFileBuffers, which also flushes the drive's own write cache on
    // every WAL commit (open_datasync, the default, relies on write-through
    // that some drives acknowledge from volatile cache). This PG build does
    // not offer fsync_writethrough — an unknown value stops postgres.
    let opts = format!(
        "-p {} -c listen_addresses=127.0.0.1 -c unix_socket_directories= \
         -c fsync=on -c synchronous_commit=on -c full_page_writes=on \
         -c wal_sync_method=fsync",
        db_port
    );
    log(&format!("starting postgres on port {}", db_port));
    let ok = HiddenCommand::new(&pg_ctl)
        .args([
            "start",
            "-D",
            &pgdata_str,
            "-o",
            &opts,
            "-l",
            &log_str,
            "-w",
            // Wedge guard only. pg_ctl returns as soon as postgres accepts
            // connections or exits; crash recovery after a power cut, or a cold
            // start under real-time antivirus, legitimately takes longer than
            // a minute and must not be reported as a failure.
            "-t",
            "900",
        ])
        .spawn()?
        .wait_success()?;
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "pg_ctl start failed — see pgdata/pg.log",
        ));
    }

    // P2-5: on the first launch of a copied template the cluster still trusts
    // localhost. Set the superuser password from the DPAPI store NOW, over
    // that trust connection, then flip pg_hba.conf to scram-sha-256 and reload
    // it — after this the cluster never trusts a connection again.
    if !pgdata.join(SCRAM_PW_SET_MARKER).exists() {
        establish_scram_auth(resources_root, pgdata, db_port, db_password)?;
    } else if harden_pg_hba(pgdata)? {
        // A hand-edited or restored pg_hba.conf regressed to trust: re-harden.
        reload_pg_hba(resources_root, pgdata)?;
        log("pg_hba.conf re-hardened to scram-sha-256");
    }

    // `erp` ships inside the template. It is created here ONLY for a cluster
    // initdb just made. On an existing cluster a missing `erp` is data loss and
    // must fail visibly — the old unconditional `createdb` turned it into an
    // empty database that migrations then filled, i.e. a silent blank system.
    if pgdata.join(NEEDS_CREATEDB_MARKER).exists() {
        let createdb = strip_verbatim_prefix(&bindir.join("createdb.exe"));
        let created_ok = HiddenCommand::new(&createdb)
            .args([
                "-h",
                "127.0.0.1",
                "-p",
                &db_port.to_string(),
                "-U",
                DB_SUPERUSER,
                DB_NAME,
            ])
            .env("PGPASSWORD", db_password)
            .spawn()
            .and_then(|c| c.wait_success())
            .unwrap_or(false);
        log(&format!("createdb `{DB_NAME}` on fresh initdb cluster: ok={created_ok}"));
    }
    if let Err(first) = ensure_erp_database(resources_root, db_port, db_password) {
        // The usual cause on an existing cluster is a role password that no
        // longer matches secrets.dat (secrets restored/regenerated). postgres
        // listens on 127.0.0.1 only and we own pg_hba.conf, so re-apply the
        // current secret the same way the first launch does, then re-verify.
        // If `erp` itself is missing this still fails — never recreated.
        log(&format!("{first} — re-applying the role password from secrets.dat"));
        establish_scram_auth(resources_root, pgdata, db_port, db_password)?;
        ensure_erp_database(resources_root, db_port, db_password)?;
    }
    let _ = fs::remove_file(pgdata.join(NEEDS_CREATEDB_MARKER));

    wait_tcp("127.0.0.1", db_port, Duration::from_secs(300))?;
    log("postgres is accepting connections");
    Ok(())
}

/// P2-5 one-time bootstrap: set the superuser password, then retire `trust`.
///
/// The baked template is produced on the build machine, where its `postgres`
/// role has no password and pg_hba.conf trusts localhost. Both are fixed here
/// on the customer's first launch:
///   1. pg_hba.conf is written in *bootstrap* form (localhost trust) — this is
///      the ONLY moment trust is ever active on the installed cluster.
///   2. `ALTER ROLE postgres PASSWORD` stores the DPAPI-generated secret.
///   3. pg_hba.conf is flipped to scram-sha-256 and reloaded (pg_ctl reload
///      signals the postmaster; it needs no database connection).
///   4. The marker is written, so every later boot starts already hardened.
fn establish_scram_auth(
    resources_root: &Path,
    pgdata: &Path,
    db_port: u16,
    db_password: &str,
) -> io::Result<()> {
    log("first launch: establishing scram-sha-256 auth for the bundled cluster");
    write_bootstrap_pg_hba(pgdata)?;
    reload_pg_hba(resources_root, pgdata)?;

    let bindir = pg_bin(resources_root);
    let psql = strip_verbatim_prefix(&bindir.join("psql.exe"));
    let stmt = format!(
        "ALTER ROLE {} PASSWORD '{}'",
        DB_SUPERUSER,
        db_password.replace('\'', "''")
    );
    let ok = HiddenCommand::new(&psql)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            &db_port.to_string(),
            "-U",
            DB_SUPERUSER,
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-tAc",
            &stmt,
        ])
        .spawn()?
        .wait_success()?;
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "ALTER ROLE postgres PASSWORD failed — cannot retire trust auth",
        ));
    }

    // Flip to the hardened policy and make postgres re-read it before we
    // connect again — the createdb/psql probes below rely on the password.
    harden_pg_hba(pgdata)?;
    reload_pg_hba(resources_root, pgdata)?;
    fs::write(pgdata.join(SCRAM_PW_SET_MARKER), b"scram-sha-256")?;
    log("bundled cluster now requires scram-sha-256 (trust retired)");
    Ok(())
}

/// Bootstrap pg_hba.conf: trust localhost for the single ALTER ROLE statement.
/// Overwritten by `harden_pg_hba` within the same boot.
fn write_bootstrap_pg_hba(pgdata: &Path) -> io::Result<()> {
    let path = pgdata.join("pg_hba.conf");
    let original = fs::read_to_string(&path)?;
    let mut out = String::with_capacity(original.len() + 128);
    out.push_str("# MOTARD BOOTSTRAP (P2-5) — temporary localhost trust for ALTER ROLE only.\n");
    out.push_str("# Replaced by scram-sha-256 in the same boot; never persisted as final policy.\n");
    for line in original.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let mut fields: Vec<&str> = line.split_whitespace().collect();
        let is_tcp = matches!(fields.first(), Some(&"host" | &"hostssl" | &"hostnossl"));
        if is_tcp && fields.len() >= 4 {
            *fields.last_mut().unwrap() = "trust";
            out.push_str(&fields.join(" "));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    fs::write(path, out)
}

/// Ask the postmaster to re-read pg_hba.conf. `pg_ctl reload` signals the
/// postmaster directly (no database connection, so no auth is involved).
fn reload_pg_hba(resources_root: &Path, pgdata: &Path) -> io::Result<()> {
    let bindir = pg_bin(resources_root);
    let pg_ctl = strip_verbatim_prefix(&bindir.join("pg_ctl.exe"));
    let pgdata_str = pgdata.to_string_lossy().into_owned();
    let ok = HiddenCommand::new(&pg_ctl)
        .args(["reload", "-D", &pgdata_str])
        .spawn()?
        .wait_success()?;
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "pg_ctl reload failed — pg_hba.conf not applied",
        ));
    }
    Ok(())
}

/// DFP-010: prove the `erp` database exists and accepts a simple query.
pub(crate) fn ensure_erp_database(
    resources_root: &Path,
    db_port: u16,
    db_password: &str,
) -> io::Result<()> {
    let bindir = pg_bin(resources_root);
    let psql = strip_verbatim_prefix(&bindir.join("psql.exe"));
    if !psql.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("psql.exe missing at {}", psql.display()),
        ));
    }
    let ok = HiddenCommand::new(&psql)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            &db_port.to_string(),
            "-U",
            DB_SUPERUSER,
            "-d",
            DB_NAME,
            "-v",
            "ON_ERROR_STOP=1",
            "-tAc",
            "SELECT 1",
        ])
        .env("PGPASSWORD", db_password)
        .spawn()?
        .wait_success()?;
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!(
                "database `{DB_NAME}` is missing or not connectable on 127.0.0.1:{db_port}"
            ),
        ));
    }
    log(&format!("database `{DB_NAME}` verified"));
    Ok(())
}

// ── Step 5: spawn the Node backend with injected secrets ────────────────────
fn spawn_server(cfg: &BootConfig, store: &secret_store::SecretStore) -> io::Result<HiddenChild> {
    // P2-5: the password is URL-safe by construction (alphanumeric only) and
    // is never persisted in the connection string — it is injected into the
    // child's environment at spawn time only.
    let database_url = format!(
        "postgresql://{}:{}@127.0.0.1:{}/{}",
        DB_SUPERUSER, store.db_password, cfg.db_port, DB_NAME
    );
    // A port file left by a previous run must never be mistaken for "ready".
    let _ = fs::remove_file(&cfg.port_file);
    log(&format!(
        "starting server (node {}) — port assigned by the OS",
        cfg.node_exe.display()
    ));
    let mut cmd = HiddenCommand::new(strip_verbatim_prefix(&cfg.node_exe));
    cmd.arg(strip_verbatim_prefix(&cfg.server_js))
        .current_dir(strip_verbatim_prefix(&cfg.server_dir))
        .env("NODE_ENV", "production")
        .env("DESKTOP_DEPLOY", "true")
        // The port is a persisted random port (see ports::resolve_server_port), never a well-known one like
        // 8080/4173, and it is re-picked if something is holding it. The server still publishes what it really
        // bound in DESKTOP_PORT_FILE once it is accepting connections.
        .env("PORT", cfg.server_port.to_string())
        .env("HOST", "127.0.0.1")
        .env(
            "DESKTOP_PORT_FILE",
            cfg.port_file.to_string_lossy().into_owned(),
        )
        // The built single-page frontend is served by this same process on the same origin as the API
        // (no SSR server, no proxy, no CORS). CORS_ORIGIN is only a non-wildcard placeholder for the
        // production guard: same-origin requests never need it.
        .env(
            "SERVE_STATIC_DIR",
            strip_verbatim_prefix(&cfg.web_dir)
                .to_string_lossy()
                .into_owned(),
        )
        .env("CORS_ORIGIN", "http://127.0.0.1")
        // pino-roll's default LOG_DIR resolves relative to the compiled
        // logger.js location, which under the packaged app is inside
        // `Program Files\...\backend\dist\logs` — not writable by a
        // non-admin user. That EPERM on log rotation is an unhandled
        // 'error' event that crashes the whole backend process (verified
        // live 2026-09-04: backend.log showed exactly this crash, leaving
        // postgres+SSR running with no API — the actual cause of "login
        // doesn't work", nothing to do with credentials). Point logs at the
        // per-user writable app-data root instead, alongside pgdata/secrets.
        .env(
            "LOG_DIR",
            cfg.app_data_root.join("logs").to_string_lossy().into_owned(),
        )
        // Company logo uploads default to Linux `/var/lib/erp/logos` in the
        // backend — unusable on a Windows desktop install. Point at a writable
        // per-user path next to logs/pgdata (same pattern as LOG_DIR).
        .env(
            "COMPANY_LOGO_DIR",
            cfg.app_data_root.join("logos").to_string_lossy().into_owned(),
        )
        .env("DATABASE_URL", &database_url)
        .env("JWT_SECRET", &store.jwt_secret)
        .env("APP_MASTER_KEY", &store.app_master_key)
        // Hub pairing: UI stays on the local SSR origin; CENTRAL_SYNC_URL is the
        // outbox target. Paths let the Node process persist hub.json / session
        // without copying JWT_SECRET between machines.
        .env(
            "HUB_CONFIG_PATH",
            cfg.app_data_root.join("hub.json").to_string_lossy().into_owned(),
        )
        .env(
            "HUB_SESSION_PATH",
            cfg.app_data_root
                .join("hub-session.json")
                .to_string_lossy()
                .into_owned(),
        )
        .env(
            "DESKTOP_DB_META_PATH",
            crate::db_meta::meta_path(&cfg.app_data_root)
                .to_string_lossy()
                .into_owned(),
        )
        .env(
            "DESKTOP_MIGRATIONS_FOLDER",
            strip_verbatim_prefix(&cfg.migrations_dir)
                .to_string_lossy()
                .into_owned(),
        )
        .env("MOTARD_BOOT_ID", super::boot_log::boot_id())
        // Recorded in every backup manifest (compatibility reporting).
        .env("MOTARD_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env(
            "DATA_INTEGRITY_PATH",
            cfg.app_data_root
                .join("data-integrity.json")
                .to_string_lossy()
                .into_owned(),
        )
        .env(
            "POSTGRES_BIN",
            cfg.resources_root
                .join("postgres")
                .join("bin")
                .to_string_lossy()
                .into_owned(),
        )
        // Defense: never let a stray private key reach the desktop client.
        .env_remove("LICENSE_SIGNING_KEY");

    if let Some(url) = read_hub_url(&cfg.app_data_root) {
        cmd.env("CENTRAL_SYNC_URL", url);
    }

    if let Some(pk) = &cfg.license_public_key {
        cmd.env("LICENSE_SIGNING_PUBLIC_KEY", pk);
    }

    // Keep backend crash output available for support instead of discarding
    // it — same file redirection as before, now via hidden_process so the
    // window suppression is actually reliable (see the CREATE_NO_WINDOW note
    // above spawn_backend's old Command-based version).
    // REPAIR-013: rotate previous server.log generations before truncating.
    let log_path = cfg.app_data_root.join("server.log");
    let out_log = super::boot_log::rotate_server_log(&log_path)?;
    let err_log = out_log.try_clone()?;
    cmd.stdin_null()?
        .stdout_file(out_log)
        .stderr_file(err_log)
        .spawn()
}

// ── Public entry point ──────────────────────────────────────────────────────
// Order is `stages::ALL` made executable: each step reports its stage label,
// and each failure returns a `BootFailure` naming the originating stage, so a
// failure can never surface as downstream noise (Plan §0.2).
/// Boot with no progress reporting (probes, tests).
pub fn boot_desktop_stack(cfg: &BootConfig) -> Result<DesktopStack, BootFailure> {
    boot_desktop_stack_with_progress(cfg, &|_| {})
}

/// Boot with a stage-reporting hook. The GUI splash screen feeds these short
/// Arabic labels to the user so a ~20s boot reads as progress, not a hang.
/// The hook must never block or fail the boot (splash may not exist yet).
pub fn boot_desktop_stack_with_progress(
    cfg: &BootConfig,
    progress: &dyn Fn(&str),
) -> Result<DesktopStack, BootFailure> {
    // REPAIR-013: durable boot log under AppData/logs (correlation id + decisions).
    super::boot_log::init(cfg.app_data_root.join("logs"));

    // Never fail to boot merely because something else already holds the
    // default DB port (a system-installed PostgreSQL service, an orphaned
    // instance of this app) — pick a free one instead. See R-04.
    let mut cfg = cfg.clone();
    let resolved_db_port = find_free_db_port(cfg.db_port);
    if resolved_db_port != cfg.db_port {
        log(&format!(
            "db port {} busy — falling back to {}",
            cfg.db_port, resolved_db_port
        ));
        cfg.db_port = resolved_db_port;
        persist_db_port(&cfg.app_data_root, cfg.db_port);
    }

    progress(BootStage::Preflight.label());
    // Step 0: pre-flight — verify every runtime-critical bundled file exists on
    // disk. If an antivirus quarantined one of them post-install (a documented
    // pattern for unsigned postgres binaries), the user gets a clear Arabic
    // message instead of a silent crash on the first pg_ctl call.
    if let Err(missing) = preflight_check(&cfg) {
        let list = missing.join("\n  • ");
        let msg = format!(
            "تعذّر تشغيل النظام: بعض ملفات التشغيل الأساسية مفقودة من مجلد التثبيت.\n\n  • {}\n\n\
             السبب الأكثر شيوعاً: برنامج الحماية (Antivirus) على هذا الجهاز حذف أو حجر أحد هذه الملفات أثناء التثبيت أو بعده.\n\n\
             الحل:\n  1) أضف مجلد تثبيت البرنامج إلى قائمة الاستثناءات في برنامج الحماية.\n  2) أعد تشغيل مثبّت البرنامج (Repair) لاستعادة الملفات المحذوفة.",
            list
        );
        show_fatal_dialog("خطأ في ملفات التشغيل — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::Preflight,
            "preflight-missing-files",
            format!("pre-flight: missing bundled files: {}", missing.join(", ")),
        ));
    }

    progress(BootStage::FactoryReset.label());
    if let Err(e) = apply_requested_factory_reset(&cfg) {
        let msg = format!(
            "تعذّر تنفيذ إعادة الضبط المصنعي لمجلد البيانات المحلية.\n\n\
             الخطأ: {}\n\n\
             أغلق أي نسخة من البرنامج ثم أعد المحاولة.",
            e
        );
        show_fatal_dialog("خطأ في إعادة الضبط المصنعي — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::FactoryReset,
            "factory-reset",
            e.to_string(),
        ));
    }
    // Load the DPAPI store before PostgreSQL starts. The bundled cluster now
    // requires its generated role password, so secrets must exist before the
    // ProvisionDatabase/StartDatabase stages (the progress enum keeps the
    // historical LoadSecrets label for UI compatibility).
    let store = match secret_store::load_or_generate() {
        Ok(s) => s,
        Err(e) => {
            let msg = format!(
                "تعذّر إنشاء أو تحميل ملف الأسرار المحلي (secrets.dat).\\n\\nالمسار: {}\\n\\nالخطأ: {}",
                secret_store::secrets_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "<غير معروف>".to_string()),
                e
            );
            show_fatal_dialog("خطأ في ملف الأسرار — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::LoadSecrets,
                "load-secrets",
                format!("secret_store: {}", e),
            ));
        }
    };

    progress(BootStage::ProvisionDatabase.label());
    let pgdata = match ensure_pgdata(&cfg, &store.db_password) {        Ok(p) => p,
        Err(e) => {
            let msg = format!(
                "تعذّر تجهيز مجلد قاعدة البيانات المحلية (pgdata).\n\n\
                 الخطأ: {}\n\n\
                 الأسباب المحتملة:\n\
                 1) مساحة القرص ممتلئة\n\
                 2) برنامج الحماية يمنع الكتابة في مجلد AppData\\Local\\motard-erp\\pgdata\n\
                 3) قالب قاعدة البيانات المرفق (postgres\\pgdata-template) تالف أو ناقص\n\n\
                 الحل: لا تحذف مجلد pgdata ولا توافق على إعادة ضبط مصنعي. خذ نسخة من AppData ثم أرسل pg.log للدعم الفني.",
                e
            );
            show_fatal_dialog("خطأ في تجهيز قاعدة البيانات — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::ProvisionDatabase,
                "provision-db",
                e.to_string(),
            ));
        }
    };
    // P2-6: re-check immediately before bind to shrink the TOCTOU window.
    let resolved_again = find_free_db_port(cfg.db_port);
    if resolved_again != cfg.db_port {
        log(&format!(
            "db port {} became busy before start — falling back to {}",
            cfg.db_port, resolved_again
        ));
        cfg.db_port = resolved_again;
        persist_db_port(&cfg.app_data_root, cfg.db_port);
    }
    // Keep postgresql.conf's port in lock-step with the port we pass to
    // postgres below, so pg_ctl -w's readiness check targets the real port.
    if let Err(e) = sync_pg_conf_port(&pgdata, cfg.db_port) {
        let msg = format!(
            "تعذّر تحديث إعدادات منفذ قاعدة البيانات (postgresql.conf).\n\n\
             الخطأ: {}\n\n\
             قد يكون ملف الإعداد داخل مجلد بيانات القاعدة تالفاً. جرّب حذف مجلد \
             AppData\\Local\\motard-erp\\pgdata بالكامل (بعد أخذ نسخة احتياطية إن وُجدت \
             بيانات) ثم أعد تشغيل البرنامج ليعيد تجهيزه من جديد.",
            e
        );
        show_fatal_dialog("خطأ في إعدادات قاعدة البيانات — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::SyncDbPort,
            "sync-db-port",
            e.to_string(),
        ));
    }
    progress(BootStage::StartDatabase.label());
    if let Err(e) = start_postgres(&cfg.resources_root, &pgdata, cfg.db_port, &store.db_password) {
        let msg = format!(
            "تعذّر تشغيل قاعدة البيانات المحلية (PostgreSQL).\n\n\
             الخطأ: {}\n\n\
             الأسباب المحتملة:\n\
             1) برنامج آخر يستخدم المنفذ {} حالياً (مثل نسخة PostgreSQL أخرى مثبَّتة على \
                الجهاز)\n\
             2) برنامج الحماية (Antivirus) يمنع تشغيل postgres.exe\n\
             3) مجلد بيانات القاعدة تالف\n\n\
             راجع ملف السجل لمزيد من التفاصيل: {}\\pg.log\n\n\
             الحل: أغلق أي برنامج PostgreSQL آخر يعمل على الجهاز، أضف مجلد التثبيت \
             لاستثناءات الحماية، ثم أعد فتح البرنامج.",
            e,
            cfg.db_port,
            pgdata.display()
        );
        show_fatal_dialog("خطأ في تشغيل قاعدة البيانات — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::StartDatabase,
            "pg_ctl-start",
            e.to_string(),
        ));
    }

    // The store was loaded before provisioning because PostgreSQL now needs
    // its DPAPI-backed role password. Keep the explicit stage/progress event,
    // but do not decrypt or regenerate the file a second time.
    progress(BootStage::LoadSecrets.label());
    progress(BootStage::StartServer.label());
    let chosen = find_free_server_port(cfg.server_port, cfg.db_port);
    if chosen != cfg.server_port {
        log(&format!(
            "server port {} is taken — falling back to {}",
            cfg.server_port, chosen
        ));
        cfg.server_port = chosen;
        persist_server_port(&cfg.app_data_root, chosen);
    }
    let server = match spawn_server(&cfg, &store) {
        Ok(b) => {
            // node.exe still opens its own console despite CREATE_NO_WINDOW + SW_HIDE (verified live) —
            // detect and hide it instead. Best-effort, background thread, never blocks boot.
            crate::hidden_process::hide_stray_console_async(b.id());
            b
        }
        Err(e) => {
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر تشغيل محرّك النظام.\n\n\
                 الخطأ: {}\n\n\
                 المسار المتوقَّع: {}\n\n\
                 السبب الأكثر شيوعاً: برنامج الحماية حذف أو حجب node.exe بعد التثبيت.\n\n\
                 الحل: أعد تثبيت البرنامج، أو أضف مجلد التثبيت لاستثناءات برنامج الحماية.",
                e,
                cfg.node_exe.display()
            );
            show_fatal_dialog("خطأ في تشغيل محرّك النظام — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::StartServer,
                "spawn-server",
                e.to_string(),
            ));
        }
    };

    // Wait for the server. The server writes its port file only once it is REALLY accepting connections, so
    // "port file present" is the readiness signal — and it also tells us the OS-assigned port. The wait is
    // decided by the process, not by a clock: ready -> go; process gone -> fail at once with its exit code
    // and log tail; process alive but slow (cold start, antivirus scan) -> keep waiting and keep reporting.
    progress(BootStage::WaitServer.label());
    let outcome = wait_ready(
        || {
            let text = fs::read_to_string(&cfg.port_file).ok()?;
            let v: serde_json::Value = serde_json::from_str(&text).ok()?;
            let port = v.get("port")?.as_u64()? as u16;
            http_get_ok("127.0.0.1", port, "/api/health/live").then_some(port)
        },
        || server.try_exit_code(),
        |elapsed| {
            let secs = elapsed.as_secs();
            if secs >= 10 {
                progress(&format!(
                    "{} ({} ث) — التشغيل الأول قد يستغرق وقتاً أطول…",
                    BootStage::WaitServer.label(),
                    secs
                ));
            }
        },
        // Safety ceiling for a genuinely wedged (alive but never ready)
        // process. A crashed server fails immediately (ChildExited); a slow
        // one (migrations on a large database) keeps going.
        Duration::from_secs(20 * 60),
    );
    let server_port = match outcome {
        WaitOutcome::Ready(port) => port,
        failure => {
            abort_partial_boot(Some(&server), &cfg.resources_root, &pgdata);
            let log_text = fs::read_to_string(cfg.app_data_root.join("server.log")).unwrap_or_default();
            let log_tail = log_tail_for_dialog(&log_text);
            let cause = match failure {
                WaitOutcome::ChildExited(code) => format!("توقف محرّك النظام فجأة (رمز الخروج {code})."),
                _ => "بدأ محرّك النظام لكنه لم يصبح جاهزاً خلال 20 دقيقة.".to_string(),
            };
            let reason = last_fatal_reason(&log_text)
                .map(|r| format!("\n\nالسبب: {r}"))
                .unwrap_or_default();
            if let Some(fatal) = last_fatal_reason(&log_text) {
                let mut details = serde_json::Map::new();
                details.insert("reason".into(), serde_json::Value::String(fatal));
                super::boot_log::event("MIGRATION_FAILED", "wait_server", details);
            }
            let msg = format!(
                "{}{}\n\nآخر سطور السجل ({}):\n{}\n\n\
                 أعد فتح البرنامج، وإن تكررت المشكلة أرسل هذا الملف للدعم الفني.",
                cause,
                reason,
                cfg.app_data_root.join("server.log").display(),
                log_tail
            );
            show_fatal_dialog("خطأ: محرّك النظام لم يبدأ — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::WaitServer,
                "server-not-ready",
                "server did not become healthy (/api/health/live)",
            ));
        }
    };
    super::log(&format!("desktop stack is UP (postgres + server on 127.0.0.1:{server_port})"));

    Ok(DesktopStack {
        resources_root: cfg.resources_root.clone(),
        pgdata_dir: pgdata,
        db_port: cfg.db_port,
        server_port,
        server: Some(server),
    })
}

// ── Graceful / failure cleanup ───────────────────────────────────────────────

/// Tear down every child owned by a partial or failed boot (DFP-003).
/// Order: Node children first (free TCP ports), then PostgreSQL.
fn abort_partial_boot(server: Option<&HiddenChild>, resources_root: &Path, pgdata: &Path) {
    // DFP-022: wait briefly after TerminateProcess so the child is really gone before the next boot attempt
    // (and so a hung child is logged).
    const CHILD_EXIT_WAIT_MS: u32 = 5_000;
    if let Some(sv) = server {
        if !sv.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("abort_partial_boot: server did not exit within wait window");
        }
    }
    let _ = stop_postgres(resources_root, pgdata);
}

/// Pure checklist used by unit tests — which owned children a stage must kill.
/// The server writes `[FATAL] <reason>` synchronously to stderr (= server.log) when start-up is refused. The LAST
/// such line is the real cause — surface it instead of leaving the user to guess from unrelated warnings above it.
fn last_fatal_reason(log: &str) -> Option<String> {
    log.lines()
        .rev()
        .find_map(|l| l.find("[FATAL]").map(|i| l[i + "[FATAL]".len()..].trim().to_string()))
        .filter(|r| !r.is_empty())
}

/// Last 12 log lines for the failure dialog.
fn log_tail_for_dialog(log: &str) -> String {
    let lines: Vec<&str> = log.lines().collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

#[cfg(test)]
mod fatal_reason_tests {
    use super::*;

    #[test]
    fn picks_the_last_fatal_line_not_the_unrelated_warning() {
        let log = "(node:1) DeprecationWarning: Calling client.query() when the client is already executing a query\n\
                   [FATAL] Server startup failed: old reason\n\
                   [FATAL] Server startup failed: device_registrations has license rows with NULL tenant_id\n";
        assert_eq!(
            last_fatal_reason(log).as_deref(),
            Some("Server startup failed: device_registrations has license rows with NULL tenant_id")
        );
    }

    #[test]
    fn no_fatal_line_means_no_reason() {
        assert_eq!(last_fatal_reason("just a warning\n"), None);
        assert_eq!(last_fatal_reason("[FATAL]   \n"), None);
    }

    #[test]
    fn tail_keeps_only_the_last_twelve_lines() {
        let log: String = (1..=20).map(|i| format!("l{i}\n")).collect();
        let tail = log_tail_for_dialog(&log);
        assert_eq!(tail.lines().count(), 12);
        assert!(tail.starts_with("l9") && tail.ends_with("l20"));
    }
}

#[cfg(test)]
fn abort_targets_for_stage(stage: &str) -> &'static [&'static str] {
    match stage {
        "WaitServer" => &["server", "postgres"],
        _ => &[],
    }
}

pub fn shutdown(stack: &mut DesktopStack) {
    const CHILD_EXIT_WAIT_MS: u32 = 8_000;
    if let Some(sv) = stack.server.take() {
        log("stopping server");
        if !sv.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("shutdown: server did not exit within wait window after TerminateProcess");
        }
    }
    let _ = stop_postgres(&stack.resources_root, &stack.pgdata_dir);
}

fn stop_postgres(resources_root: &Path, pgdata: &Path) -> io::Result<()> {
    let pg_ctl = strip_verbatim_prefix(&pg_bin(resources_root).join("pg_ctl.exe"));
    let pgdata_str = pgdata.to_string_lossy().into_owned();
    log("stopping postgres");
    HiddenCommand::new(&pg_ctl)
        .args(["stop", "-D", &pgdata_str, "-m", "fast", "-w"])
        .spawn()?
        .wait_success()
        .map(|_| ())
}

// Port fallback lives in `super::ports::find_free_db_port` (Plan §9.2).

// ── Small network helpers ───────────────────────────────────────────────────
// (TCP/HTTP readiness gates live in `super::health`.)

// (HTTP readiness probe lives in `super::health::http_get_ok`.)

// (Bounded readiness wait lives in `super::health::wait_for`.)

use super::log;

pub fn hub_json_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join("hub.json")
}

pub fn read_hub_url(app_data_root: &Path) -> Option<String> {
    let raw = fs::read_to_string(hub_json_path(app_data_root)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let url = parsed.get("url")?.as_str()?.trim();
    if url.is_empty() {
        return None;
    }
    let trimmed = url.trim_end_matches('/').to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }
    Some(trimmed)
}

pub fn write_hub_url(app_data_root: &Path, url: &str) -> Result<String, String> {
    fs::create_dir_all(app_data_root).map_err(|e| e.to_string())?;
    let trimmed = url.trim().trim_end_matches('/');
    let path = hub_json_path(app_data_root);
    if trimmed.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(String::new());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("رابط المركز يجب أن يبدأ بـ http:// أو https://".into());
    }
    let body = serde_json::json!({ "url": trimmed });
    fs::write(&path, body.to_string()).map_err(|e| e.to_string())?;
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod hub_url_tests {
    use super::*;

    #[test]
    fn write_then_read_hub_url_and_backend_would_see_it() {
        let dir = std::env::temp_dir().join(format!(
            "motard-erp-hub-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        let written = write_hub_url(&dir, "https://erp.example.com/").unwrap();
        assert_eq!(written, "https://erp.example.com");
        assert_eq!(
            read_hub_url(&dir).as_deref(),
            Some("https://erp.example.com")
        );
        assert!(write_hub_url(&dir, "not-a-url").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod boot_lifecycle_tests {
    use super::*;

    #[test]
    fn queued_factory_reset_archives_pgdata_instead_of_deleting_it() {
        let dir = std::env::temp_dir().join(format!("motard-reset-archive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pgdata").join("base")).unwrap();
        fs::write(dir.join("pgdata").join("PG_VERSION"), "17\n").unwrap();
        fs::write(dir.join("pgdata").join("base").join("row"), "invoice data").unwrap();
        fs::write(dir.join(FACTORY_RESET_FLAG), b"1").unwrap();
        for name in HUB_PAIRING_FILES {
            fs::write(dir.join(name), b"{\"url\":\"https://old-hub\"}").unwrap();
        }
        let cfg = BootConfig {
            resources_root: dir.join("resources"),
            app_data_root: dir.clone(),
            migrations_dir: dir.join("migrations"),
            node_exe: dir.join("node.exe"),
            server_js: dir.join("server.js"),
            server_dir: dir.clone(),
            web_dir: dir.join("web"),
            port_file: dir.join("port.json"),
            db_port: 5432,
            server_port: 4173,
            installation_id: "id-a".into(),
            license_public_key: None,
        };
        fs::write(crate::db_meta::meta_path(&dir), "{}").unwrap();
        apply_requested_factory_reset(&cfg).expect("a confirmed reset must not brick boot");
        assert!(!dir.join("pgdata").exists(), "live pgdata moved aside");
        assert!(!dir.join(FACTORY_RESET_FLAG).exists(), "flag consumed");
        assert!(!crate::db_meta::meta_path(&dir).exists(), "next boot provisions fresh");
        let archive = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("pgdata.reset-"))
            .expect("archive exists");
        assert!(archive.path().join("base").join("row").exists(), "old data kept intact");
        for name in HUB_PAIRING_FILES {
            assert!(!dir.join(name).exists(), "{name}: the fresh company must not stay paired to the old hub");
            assert!(archive.path().join(format!("{name}.before-reset")).exists(), "{name} kept with the archive");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_postgres_image_counts_as_a_live_postmaster() {
        assert!(is_postgres_image(r"C:\Program Files\Motard\postgres\bin\postgres.exe"));
        assert!(is_postgres_image("C:/x/POSTGRES.EXE"));
        assert!(!is_postgres_image(r"C:\Program Files\Google\Chrome\chrome.exe"));
        assert!(!is_postgres_image(r"C:\x\postgres.exe.bak"));
    }

    #[test]
    fn factory_reset_keeps_only_newest_archives() {
        let dir = std::env::temp_dir().join(format!("motard-reset-keep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for old in ["pgdata.reset-utc-1", "pgdata.reset-utc-2", "pgdata.reset-utc-3"] {
            fs::create_dir_all(dir.join(old)).unwrap();
        }
        fs::create_dir_all(dir.join("pgdata")).unwrap();
        fs::write(dir.join("pgdata").join("PG_VERSION"), "17
").unwrap();
        move_pgdata_aside(&dir).unwrap();
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("pgdata.reset-"))
            .collect();
        assert_eq!(left.len(), RESET_ARCHIVES_KEPT);
        assert!(!dir.join("pgdata.reset-utc-1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_stale_pid_when_process_dead() {
        let lock = classify_postmaster_pid("4242\n/pgdata\n", |_| false);
        assert_eq!(lock, PidLock::Stale { pid: 4242 });
    }

    #[test]
    fn classify_live_pid_when_process_running() {
        let lock = classify_postmaster_pid("4242\n/pgdata\n", |_| true);
        assert_eq!(lock, PidLock::Live { pid: 4242 });
    }

    #[test]
    fn classify_garbage_pid_as_stale() {
        let lock = classify_postmaster_pid("not-a-pid", |_| true);
        assert_eq!(lock, PidLock::Stale { pid: 0 });
    }

    #[test]
    fn a_live_pid_that_is_not_postgres_is_a_stale_lock() {
        // The test binary is alive but is not postgres.exe — exactly the
        // "Windows reused the PID after a power cut" case. It must not block boot.
        assert!(!pid_is_running(std::process::id()));
        assert!(!pid_is_running(0));
    }

    #[test]
    fn a_failed_server_wait_must_kill_the_server_and_postgres() {
        // DFP-003 regression: a failed wait used to leave a child alive holding its port -> the next boot failed forever.
        let targets = abort_targets_for_stage("WaitServer");
        assert!(targets.contains(&"server"));
        assert!(targets.contains(&"postgres"));
    }

    #[test]
    fn unknown_stage_has_empty_abort_checklist() {
        assert!(abort_targets_for_stage("StartPostgres").is_empty());
        assert!(abort_targets_for_stage("").is_empty());
    }

    #[test]
    fn ensure_erp_database_fails_when_postgres_unreachable() {
        // DFP-010: missing/unreachable `erp` must hard-fail before backend spawn.
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let psql = resources.join("postgres").join("bin").join("psql.exe");
        if !psql.exists() {
            return; // resources not staged in this checkout
        }
        let err = ensure_erp_database(&resources, 1, "test-password").expect_err("port 1 must be unreachable");
        let msg = err.to_string();
        assert!(
            msg.contains("erp") || msg.contains("missing") || msg.contains("connect"),
            "unexpected message: {msg}"
        );
    }

    #[test]
    fn verify_resource_sha256s_detects_corruption() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!(
            "motard-integrity-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let payload = b"integrity-payload-v1";
        let good = format!("{:x}", Sha256::digest(payload));
        fs::write(dir.join("sealed.txt"), payload).unwrap();
        let manifest = format!(
            r#"{{"required":[{{"path":"sealed.txt","kind":"file","sha256":"{good}"}}]}}"#
        );
        fs::write(dir.join("resource-manifest.json"), &manifest).unwrap();
        assert!(verify_resource_sha256s(&dir).is_ok());

        fs::write(dir.join("sealed.txt"), b"integrity-payload-v2").unwrap();
        let err = verify_resource_sha256s(&dir).expect_err("corrupted file must fail");
        assert!(err.iter().any(|e| e.contains("sha256 mismatch")));
        let _ = fs::remove_dir_all(&dir);
    }
}
