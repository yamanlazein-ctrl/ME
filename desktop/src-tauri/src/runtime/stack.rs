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
use std::time::{Duration, Instant};

use super::error::BootFailure;
use super::health::{check_boot_deadline, http_get_ok, wait_for, wait_tcp};
use super::ports::{
    ensure_backend_port_free, find_free_db_port, persist_db_port, resolve_db_port, sync_pg_conf_port,
    BACKEND_PORT_DEFAULT,
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

// Port the bundled SSR frontend server (resources/ssr/serve.mjs) listens on.
// MUST match `app.windows[].url` in tauri.conf.json.
const SSR_PORT: u16 = 4173;

#[derive(Clone, Debug)]
pub struct BootConfig {
    /// Directory containing the bundled `postgres/` and (optionally) `backend/`
    /// and `pgdata-template/`. For a packaged app this is the Tauri resource
    /// dir; for the probe it is `src-tauri/resources`.
    pub resources_root: PathBuf,
    /// Per-user data dir, e.g. `%LOCALAPPDATA%/motard-erp`. Holds the live
    /// `pgdata`, `secrets.dat`, `device-binding.dat`.
    pub app_data_root: PathBuf,
    /// Node runtime used to launch the backend. Packaged app: `node.exe` inside
    /// `resources_root`; probe: system `node` on PATH.
    pub node_exe: PathBuf,
    /// Working directory for the backend process (must contain `node_modules`).
    pub backend_dir: PathBuf,
    /// Compiled backend entry (ESM). `dist/backend/src/presentation/server.js`.
    pub server_js: PathBuf,
    /// The Ed25519 *public* key (PEM) for DESKTOP_DEPLOY verify-only license
    /// checks. The private key is NEVER injected (see spawn_backend).
    pub license_public_key: Option<String>,
    pub db_port: u16,
    pub backend_port: u16,
    /// Stable install identity from DPAPI `device-binding.dat`. Empty is refused.
    pub installation_id: String,
}

impl BootConfig {
    /// Resolve a config for the packaged app given Tauri's resource directory.
    pub fn for_app(resource_dir: PathBuf) -> Result<Self, String> {
        let backend_dir = resource_dir.join("backend");
        let server_js = backend_dir
            .join("dist")
            .join("backend")
            .join("src")
            .join("presentation")
            .join("server.js");
        let license_public_key =
            fs::read_to_string(resource_dir.join("license-public.pem")).ok();
        let app_data_root = crate::app_data_dir()?;
        let db_port = resolve_db_port(&app_data_root);
        Ok(BootConfig {
            resources_root: resource_dir.clone(),
            app_data_root,
            node_exe: resource_dir.join("node.exe"),
            backend_dir,
            server_js,
            license_public_key,
            db_port,
            backend_port: BACKEND_PORT_DEFAULT,
            installation_id: String::new(),
        })
    }
}

// ── Port management lives in `super::ports` (never default to 5432).

pub struct DesktopStack {
    pub resources_root: PathBuf,
    pub pgdata_dir: PathBuf,
    pub db_port: u16,
    pub backend_port: u16,
    backend: Option<HiddenChild>,
    ssr: Option<HiddenChild>,
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

fn pid_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let queried = GetExitCodeProcess(handle, &mut code).is_ok();
            let _ = CloseHandle(handle);
            queried && code == 259 // STILL_ACTIVE
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
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
    log("factory-reset requested — wiping local cluster (binding/secrets kept)");
    let pgdata = cfg.app_data_root.join("pgdata");
    if pgdata.join("PG_VERSION").exists() {
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let _ = cleanup_stale_cluster_lock(&cfg.resources_root, &pgdata);
    }
    if pgdata.exists() {
        fs::remove_dir_all(&pgdata)?;
    }
    let _ = fs::remove_file(crate::db_meta::meta_path(&cfg.app_data_root));
    let _ = fs::remove_file(cfg.app_data_root.join("hub-session.json"));
    let _ = fs::remove_file(&flag);
    Ok(())
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
    let schema_idx = bundled_schema_journal_idx(&cfg.backend_dir);

    match evaluate_existing_cluster(
        app_data_root,
        &pgdata,
        &cfg.installation_id,
        pg_major,
        schema_idx,
    )? {
        ClusterDecision::Reuse => {
            log("pgdata already provisioned — reusing after identity/pid checks");
            ensure_pg_subdirs(&pgdata)?;
            cleanup_stale_cluster_lock(resources_root, &pgdata)?;
            return Ok(pgdata);
        }
        ClusterDecision::Fresh => {}
    }

    // Preferred path: ship a baked, already-migrated+seeded data dir.
    let template = resources_root.join("postgres").join("pgdata-template");
    if template.join("PG_VERSION").exists() {
        log(&format!(
            "copying baked pgdata-template -> {}",
            pgdata.display()
        ));
        copy_dir_all(&template, &pgdata)?;
        // WiX strips EMPTY directories from the MSI (empty dirs are not
        // packaged), so the installed pgdata-template is missing PostgreSQL's
        // required empty subdirectories (pg_notify, pg_logical/snapshots, ...).
        // Recreate the full set before first start, otherwise the server aborts
        // with "could not open directory".
        ensure_pg_subdirs(&pgdata)?;
        // The baked template may carry stale live-server artifacts from the
        // build machine; remove them so pg_ctl treats the copy as fresh.
        for stale in ["postmaster.pid", "postmaster.opts", "current_logfiles"] {
            let _ = fs::remove_file(pgdata.join(stale));
        }
        stamp_fresh_cluster(app_data_root, &cfg.installation_id, pg_major, 0)?;
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
    let pgdata_str = pgdata.to_string_lossy().into_owned();
    fs::create_dir_all(&pgdata).ok();
    let pwfile = pgdata.join(".initdb-pwfile");
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
    stamp_fresh_cluster(app_data_root, &cfg.installation_id, pg_major, 0)?;
    // initdb already wrote a scram-sha-256 pg_hba.conf and set the superuser
    // password — record that so start_postgres skips the trust bootstrap.
    fs::write(pgdata.join(SCRAM_PW_SET_MARKER), b"initdb-scram")?;
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
fn preflight_check(cfg: &BootConfig) -> Result<(), Vec<String>> {
    let bin = cfg.resources_root.join("postgres").join("bin");
    let required = vec![
        bin.join("postgres.exe"),
        bin.join("pg_ctl.exe"),
        bin.join("initdb.exe"),
        bin.join("libpq.dll"),
        cfg.node_exe.clone(),
        cfg.server_js.clone(),
        cfg.resources_root.join("ssr").join("serve.mjs"),
        cfg.resources_root
            .join("ssr")
            .join("dist")
            .join("server")
            .join("server.js"),
        cfg.resources_root
            .join("postgres")
            .join("pgdata-template")
            .join("PG_VERSION"),
    ];
    let missing: Vec<String> = required
        .iter()
        .filter(|f| !f.exists())
        .map(|f| f.display().to_string())
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(missing)
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
    let opts = format!(
        "-p {} -c listen_addresses=127.0.0.1 -c unix_socket_directories=",
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
            "-t",
            "60",
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

    // Ensure the target database exists (DFP-010). createdb is idempotent when
    // `erp` already exists (non-zero exit); we still VERIFY connectivity to
    // `erp` before returning — TCP readiness alone is not enough.
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
    if created_ok {
        log(&format!("created database `{DB_NAME}`"));
    } else {
        log(&format!(
            "createdb `{DB_NAME}` returned non-success (may already exist) — verifying"
        ));
    }
    ensure_erp_database(resources_root, db_port, db_password)?;

    wait_tcp("127.0.0.1", db_port, Duration::from_secs(60))?;
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
fn spawn_backend(cfg: &BootConfig, store: &secret_store::SecretStore) -> io::Result<HiddenChild> {
    // P2-5: the password is URL-safe by construction (alphanumeric only) and
    // is never persisted in the connection string — it is injected into the
    // child's environment at spawn time only.
    let database_url = format!(
        "postgresql://{}:{}@127.0.0.1:{}/{}",
        DB_SUPERUSER, store.db_password, cfg.db_port, DB_NAME
    );
    log(&format!(
        "starting backend (node {}) on port {}",
        cfg.node_exe.display(),
        cfg.backend_port
    ));
    let mut cmd = HiddenCommand::new(strip_verbatim_prefix(&cfg.node_exe));
    cmd.arg(strip_verbatim_prefix(&cfg.server_js))
        .current_dir(strip_verbatim_prefix(&cfg.backend_dir))
        .env("NODE_ENV", "production")
        .env("DESKTOP_DEPLOY", "true")
        .env("PORT", cfg.backend_port.to_string())
        .env("HOST", "127.0.0.1")
        // The bundled Tauri webview loads the SSR server at 127.0.0.1:4173, so
        // API fetches originate there. Production CORS forbids "*", so we pin the
        // exact origin the desktop client uses.
        .env("CORS_ORIGIN", "http://127.0.0.1:4173")
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
        // Hub pairing: UI stays on 127.0.0.1:8080; CENTRAL_SYNC_URL is the
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
            cfg.backend_dir
                .join("src")
                .join("infrastructure")
                .join("orm")
                .join("migrations")
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
    let log_path = cfg.app_data_root.join("backend.log");
    let out_log = fs::File::create(&log_path)?;
    let err_log = out_log.try_clone()?;
    cmd.stdin_null()?
        .stdout_file(out_log)
        .stderr_file(err_log)
        .spawn()
}

/// Spawn the bundled SSR frontend server (resources/ssr/serve.mjs) using the
/// bundled Node runtime. It hosts the prebuilt TanStack Start nitro handler on a
/// local port so the Tauri webview simply loads an ordinary web page (no
/// client-side npm/build step). We start it ONLY after the backend is healthy:
/// the SSR pages fetch from the API on first paint, so a dead backend would
/// otherwise show error states until the API comes up.
fn spawn_ssr(cfg: &BootConfig) -> io::Result<HiddenChild> {
    let ssr_script = cfg.resources_root.join("ssr").join("serve.mjs");
    log(&format!(
        "starting SSR frontend server on http://127.0.0.1:{}",
        SSR_PORT
    ));
    let mut cmd = HiddenCommand::new(strip_verbatim_prefix(&cfg.node_exe));
    cmd.arg(strip_verbatim_prefix(&ssr_script))
        .current_dir(strip_verbatim_prefix(&cfg.resources_root))
        .env("NODE_ENV", "production")
        .env("SSR_PORT", SSR_PORT.to_string())
        .env("SSR_HOST", "127.0.0.1")
        .env_remove("LICENSE_SIGNING_KEY");
    let log_path = cfg.app_data_root.join("ssr.log");
    let out_log = fs::File::create(&log_path)?;
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
    let boot_started = Instant::now();
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
    check_boot_deadline(boot_started)
        .map_err(|e| BootFailure::new(BootStage::Preflight, "boot-deadline", e.to_string()))?;

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
                 الحل: تحقق من المساحة المتاحة وصلاحيات الكتابة، ثم أعد تشغيل مثبّت \
                 البرنامج (Repair) إن استمرت المشكلة.",
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
    check_boot_deadline(boot_started)
        .map_err(|e| BootFailure::new(BootStage::ProvisionDatabase, "boot-deadline", e.to_string()))?;
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
    check_boot_deadline(boot_started)
        .map_err(|e| BootFailure::new(BootStage::StartDatabase, "boot-deadline", e.to_string()))?;

    // The store was loaded before provisioning because PostgreSQL now needs
    // its DPAPI-backed role password. Keep the explicit stage/progress event,
    // but do not decrypt or regenerate the file a second time.
    progress(BootStage::LoadSecrets.label());
    progress(BootStage::StartBackend.label());
    // DFP-009: refuse to spawn when the baked frontend port is occupied —
    // otherwise WaitBackend hangs 60s and leaves a confusing timeout.
    if let Err(e) = ensure_backend_port_free(cfg.backend_port) {
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let msg = format!(
            "منفذ محرّك النظام ({}) مشغول حالياً — لا يمكن تشغيل البرنامج.\n\n\
             التفاصيل: {}\n\n\
             أغلق البرنامج الذي يستخدم هذا المنفذ (أو أي نسخة سابقة من Motard ERP \
             ما زالت تعمل في Task Manager)، ثم أعد فتح البرنامج.",
            cfg.backend_port, e
        );
        show_fatal_dialog("خطأ: المنفذ مشغول — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::StartBackend,
            "backend-port-occupied",
            e,
        ));
    }
    let backend = match spawn_backend(&cfg, &store) {
        Ok(b) => {
            // node.exe still opens its own console despite CREATE_NO_WINDOW +
            // SW_HIDE (verified live, unlike postgres/pg_ctl where those flags
            // work correctly) — detect and hide it instead. Best-effort,
            // background thread, never blocks boot.
            crate::hidden_process::hide_stray_console_async(b.id());
            b
        }
        Err(e) => {
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر تشغيل محرّك النظام (Node.js backend).\n\n\
                 الخطأ: {}\n\n\
                 المسار المتوقَّع: {}\n\n\
                 السبب الأكثر شيوعاً: برنامج الحماية حذف أو حجب node.exe بعد التثبيت.\n\n\
                 الحل: أضف مجلد تثبيت البرنامج لاستثناءات الحماية، ثم أعد تشغيل مثبّت \
                 البرنامج (Repair).",
                e,
                cfg.node_exe.display()
            );
            show_fatal_dialog("خطأ في تشغيل محرّك النظام — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::StartBackend,
                "spawn-backend",
                e.to_string(),
            ));
        }
    };

    // Step 6 (parallel): start the SSR frontend server IMMEDIATELY, without
    // waiting for the backend to become healthy first. The SSR node process
    // spends ~6s importing the prebuilt nitro bundle — overlapping that with
    // the backend's own ~20s init saves the full SSR import cost off the
    // critical path. Ordering is still guaranteed: Step 7 waits for the
    // backend first, Step 8 waits for SSR after, so the first SSR paint can
    // reach a live API exactly as before.
    progress(BootStage::StartFrontend.label());
    let ssr = match spawn_ssr(&cfg) {
        Ok(s) => {
            crate::hidden_process::hide_stray_console_async(s.id());
            s
        }
        Err(e) => {
            backend.kill();
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر تشغيل واجهة العرض (SSR frontend server).\n\n\
                 الخطأ: {}\n\n\
                 الحل: أضف مجلد تثبيت البرنامج لاستثناءات برنامج الحماية، ثم أعد تشغيل \
                 مثبّت البرنامج (Repair) إن استمرت المشكلة.",
                e
            );
            show_fatal_dialog("خطأ في تشغيل واجهة العرض — Motard ERP", &msg);
            return Err(BootFailure::new(
                BootStage::StartFrontend,
                "spawn-ssr",
                e.to_string(),
            ));
        }
    };

    // Step 7: wait for the backend to report live.
    progress(BootStage::WaitBackend.label());
    let live = wait_for(
        || http_get_ok("127.0.0.1", cfg.backend_port, "/api/health/live"),
        Duration::from_secs(60),
    );
    if !live {
        // DFP-003: kill EVERY child started so far — including the backend.
        // Omitting backend.kill() left node listening on 8080 → next boot
        // EADDRINUSE forever (same cascade documented on WaitFrontend below).
        abort_partial_boot(
            Some(&backend),
            Some(&ssr),
            &cfg.resources_root,
            &pgdata,
        );
        let msg = format!(
            "بدأ محرّك النظام لكنه لم يستجب خلال المهلة المتوقَّعة (60 ثانية).\n\n\
             المنفذ: {}\n\n\
             قد يكون الجهاز بطيئاً جداً في الإقلاع الأول، أو برنامج الحماية يفحص الملفات \
             ببطء. أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.",
            cfg.backend_port
        );
        show_fatal_dialog("خطأ: محرّك النظام لم يستجب — Motard ERP", &msg);
        return Err(BootFailure::new(
            BootStage::WaitBackend,
            "backend-not-live",
            "backend did not become healthy (/api/health/live)",
        ));
    }
    super::log("desktop stack is UP (postgres + backend)");

    // Step 8 (already running, see Step 6): wait for the SSR frontend to
    // answer on its LIGHTWEIGHT readiness probe. Polling "/" here was the
    // 5-minute-boot bug (verified live 2026-09-05): "/" forces a full SSR
    // render which takes minutes on a cold AV-scanned boot, so the 30s
    // timeout fired while the server was actually fine — then the fatal path
    // below orphaned the backend on 8080 and EVERY later boot failed too.
    // "/__health" (serve.mjs) answers from the node event loop with no render.
    progress(BootStage::WaitFrontend.label());
    let ssr_live = wait_for(
        || http_get_ok("127.0.0.1", SSR_PORT, "/__health"),
        Duration::from_secs(120),
    );
    if !ssr_live {
        // Kill EVERYTHING we started: leaving the backend alive on 8080 turns
        // one slow boot into a permanent failure cascade (next boot's backend
        // gets EADDRINUSE and can never become healthy).
        abort_partial_boot(
            Some(&backend),
            Some(&ssr),
            &cfg.resources_root,
            &pgdata,
        );
        let msg = "بدأت واجهة العرض لكنها لم تستجب خلال المهلة المتوقَّعة (120 ثانية).\n\n\
                     أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.";
        show_fatal_dialog("خطأ: واجهة العرض لم تستجب — Motard ERP", msg);
        return Err(BootFailure::new(
            BootStage::WaitFrontend,
            "ssr-not-ready",
            "SSR frontend did not become healthy (http://127.0.0.1:4173/)",
        ));
    }
    check_boot_deadline(boot_started)
        .map_err(|e| BootFailure::new(BootStage::WaitFrontend, "boot-deadline", e.to_string()))?;
    super::log("SSR frontend is UP");

    Ok(DesktopStack {
        resources_root: cfg.resources_root.clone(),
        pgdata_dir: pgdata,
        db_port: cfg.db_port,
        backend_port: cfg.backend_port,
        backend: Some(backend),
        ssr: Some(ssr),
    })
}

// ── Graceful / failure cleanup ───────────────────────────────────────────────

/// Tear down every child owned by a partial or failed boot (DFP-003).
/// Order: Node children first (free TCP ports), then PostgreSQL.
fn abort_partial_boot(
    backend: Option<&HiddenChild>,
    ssr: Option<&HiddenChild>,
    resources_root: &Path,
    pgdata: &Path,
) {
    // DFP-022: wait briefly after TerminateProcess so ports are released
    // before the next boot attempt (and so we can log hung children).
    const CHILD_EXIT_WAIT_MS: u32 = 5_000;
    if let Some(b) = backend {
        if !b.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("abort_partial_boot: backend did not exit within wait window");
        }
    }
    if let Some(s) = ssr {
        if !s.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("abort_partial_boot: SSR did not exit within wait window");
        }
    }
    let _ = stop_postgres(resources_root, pgdata);
}

/// Pure checklist used by unit tests — which owned children a stage must kill.
#[cfg(test)]
fn abort_targets_for_stage(stage: &str) -> &'static [&'static str] {
    match stage {
        "WaitBackend" | "WaitFrontend" => &["backend", "ssr", "postgres"],
        "StartFrontend" => &["backend", "postgres"], // SSR spawn failed — no SSR child
        _ => &[],
    }
}

pub fn shutdown(stack: &mut DesktopStack) {
    const CHILD_EXIT_WAIT_MS: u32 = 8_000;
    if let Some(b) = stack.backend.take() {
        log("stopping backend");
        if !b.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("shutdown: backend did not exit within wait window after TerminateProcess");
        }
    }
    if let Some(s) = stack.ssr.take() {
        log("stopping SSR frontend");
        if !s.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("shutdown: SSR did not exit within wait window after TerminateProcess");
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
    fn pid_is_running_sees_current_process() {
        assert!(pid_is_running(std::process::id()));
        assert!(!pid_is_running(0));
    }

    #[test]
    fn wait_backend_timeout_must_kill_backend_ssr_and_postgres() {
        // DFP-003 regression: WaitBackend used to omit backend → EADDRINUSE.
        let targets = abort_targets_for_stage("WaitBackend");
        assert!(targets.contains(&"backend"));
        assert!(targets.contains(&"ssr"));
        assert!(targets.contains(&"postgres"));
        assert_eq!(
            abort_targets_for_stage("WaitBackend"),
            abort_targets_for_stage("WaitFrontend")
        );
    }

    #[test]
    fn wait_frontend_timeout_same_cleanup_set_as_wait_backend() {
        let targets = abort_targets_for_stage("WaitFrontend");
        assert_eq!(targets, &["backend", "ssr", "postgres"]);
    }

    #[test]
    fn start_frontend_failure_kills_backend_and_postgres_not_ssr() {
        // SSR spawn failed — there is no SSR child to kill.
        let targets = abort_targets_for_stage("StartFrontend");
        assert!(targets.contains(&"backend"));
        assert!(targets.contains(&"postgres"));
        assert!(!targets.contains(&"ssr"));
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
}
