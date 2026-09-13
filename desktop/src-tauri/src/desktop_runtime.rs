// D4-3 — Desktop runtime orchestration.
//
// This module is the heart of the "self-contained Windows Desktop" build. On a
// client machine there is no PostgreSQL, no Node, and no operator. The Tauri
// sidecar (this Rust code) must, with no manual steps:
//
//   step 0  device-binding gate        (handled in main.rs before this runs)
//   step 1  provision a PostgreSQL data dir (copy baked template OR initdb+createdb)
//   step 2  start postgres.exe (bundled under resources/postgres/bin)
//   step 3  wait until the DB accepts TCP connections
//   step 4  generate/load locally-encrypted secrets (DPAPI) for the backend
//   step 5  start the Node backend (bundled node.exe + dist) with those secrets
//           injected via env (JWT_SECRET, APP_MASTER_KEY, DATABASE_URL, ...)
//   step 6  wait until /api/health/live returns 200
//   step 7  (in main.rs) point the Tauri window at 127.0.0.1:<backend_port>
//   shutdown: stop the backend child and stop postgres (pg_ctl stop -m fast)
//
// All paths are configurable via `BootConfig` so a standalone probe binary can
// exercise the exact same logic against the dev tree (system node + already
// built backend) without a GUI.
use std::fs;
use std::io::{self, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::hidden_process::{HiddenChild, HiddenCommand};
use crate::secret_store;

// Fixed identities for the bundled, single-tenant, single-machine deployment.
const DB_NAME: &str = "erp";
const DB_SUPERUSER: &str = "postgres";

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
            backend_port: 8080,
        })
    }
}

/// High, uncommon port range for the bundled PostgreSQL's default. Deliberately
/// far from 5432 (PostgreSQL's universally-known standard port) and from other
/// common service ranges.
const DB_PORT_RANGE: std::ops::Range<u16> = 40000..60000;

/// Structural fix for R-04/R-05 (see REMEDIATION_LOG.md): never default the
/// bundled postgres to 5432. That is PostgreSQL's well-known standard port, so
/// defaulting to it guarantees an eventual collision with *any* other
/// PostgreSQL on the machine — a system-installed service, another vendor's
/// bundled Postgres, a developer's local instance — on some fraction of
/// customer machines, with zero way for a non-technical customer to
/// understand or resolve a "port 5432 in use" dialog. Instead: pick a random
/// port from a high, uncommon range ONCE on first launch, persist it next to
/// pgdata/secrets.dat in the per-user app-data dir, and reuse the same value
/// on every subsequent launch (stable DATABASE_URL, no per-boot churn). The
/// dynamic busy-port fallback in `boot_desktop_stack` (`find_free_db_port`)
/// remains as a second safety net for the rare case where even this saved
/// port is occupied on a given boot.
fn resolve_db_port(app_data_root: &Path) -> u16 {
    let path = app_data_root.join("db-port.txt");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(port) = text.trim().parse::<u16>() {
            if DB_PORT_RANGE.contains(&port) {
                return port;
            }
        }
    }
    use rand::Rng;
    let port = rand::rngs::OsRng.gen_range(DB_PORT_RANGE);
    let _ = fs::create_dir_all(app_data_root);
    let _ = fs::write(&path, port.to_string());
    port
}

#[cfg(test)]
mod db_port_tests {
    use super::*;

    #[test]
    fn resolve_db_port_never_returns_5432_and_persists_across_calls() {
        let dir = std::env::temp_dir().join(format!(
            "motard-erp-dbport-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);

        let first = resolve_db_port(&dir);
        assert!(
            DB_PORT_RANGE.contains(&first),
            "port {} outside the intended high/uncommon range",
            first
        );
        assert_ne!(first, 5432, "must never default to the standard PostgreSQL port");

        // Second call must reuse the SAME persisted port, not roll a new one.
        let second = resolve_db_port(&dir);
        assert_eq!(first, second, "port must be stable across launches");

        let saved = fs::read_to_string(dir.join("db-port.txt")).unwrap();
        assert_eq!(saved.trim().parse::<u16>().unwrap(), first);

        let _ = fs::remove_dir_all(&dir);
    }
}

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

// ── Step 1: ensure a usable PostgreSQL data directory ───────────────────────
fn ensure_pgdata(resources_root: &Path, app_data_root: &Path) -> io::Result<PathBuf> {
    let pgdata = app_data_root.join("pgdata");
    if pgdata.join("PG_VERSION").exists() {
        log("pgdata already provisioned — reusing");
        // Repair any missing empty subdirs left over from an install produced
        // before the dir-creation fix (WiX strips empty dirs from the MSI).
        ensure_pg_subdirs(&pgdata)?;
        return Ok(pgdata);
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
        return Ok(pgdata);
    }

    // Fallback (never used in the final package, only for first-run safety):
    // initialize a fresh cluster and create the `erp` database.
    log("no pgdata-template — running initdb");
    let bindir = pg_bin(resources_root);
    let initdb = strip_verbatim_prefix(&bindir.join("initdb.exe"));
    let pgdata_str = pgdata.to_string_lossy().into_owned();
    fs::create_dir_all(&pgdata).ok();
    let ok = HiddenCommand::new(&initdb)
        .args([
            "-D",
            &pgdata_str,
            "-U",
            DB_SUPERUSER,
            "--auth=trust",
            "-E",
            "UTF8",
        ])
        .spawn()?
        .wait_success()?;
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "initdb failed — see pgdata/pg.log",
        ));
    }
    Ok(pgdata)
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

/// pg_ctl's `-w` readiness probe reads the port from postgresql.conf (NOT from
/// the `-o "-p ..."` we pass to postgres). If the conf's port ever disagrees
/// with the port postgres actually listens on, pg_ctl waits the full timeout
/// and reports failure even though the server is up. So after provisioning we
/// force the conf's port to the port we will pass at start time. Idempotent.
fn sync_pg_conf_port(pgdata: &Path, db_port: u16) -> io::Result<()> {
    let conf = pgdata.join("postgresql.conf");
    let text = fs::read_to_string(&conf)?;
    let wanted = format!("port = {}", db_port);
    let mut replaced = false;
    let out = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("port") && trimmed.contains('=') && !replaced {
                // Only touch the port directive, never commented lines.
                if trimmed.starts_with('#') {
                    return line.to_string();
                }
                replaced = true;
                return line.replace(trimmed, &wanted);
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    if replaced {
        fs::write(&conf, out)?;
        log(&format!("postgresql.conf port synced to {}", db_port));
    }
    Ok(())
}

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

    // Ensure the target database exists (idempotent — errors ignored).
    let createdb = strip_verbatim_prefix(&bindir.join("createdb.exe"));
    let _ = HiddenCommand::new(&createdb)
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            &db_port.to_string(),
            "-U",
            DB_SUPERUSER,
            DB_NAME,
        ])
        .spawn()
        .and_then(|c| c.wait_success());

    wait_tcp("127.0.0.1", db_port, Duration::from_secs(60));
    log("postgres is accepting connections");
    Ok(())
}

// ── Step 5: spawn the Node backend with injected secrets ────────────────────
fn spawn_backend(cfg: &BootConfig, store: &secret_store::SecretStore) -> io::Result<HiddenChild> {
    let database_url = format!(
        "postgresql://{}@127.0.0.1:{}/{}",
        DB_SUPERUSER, cfg.db_port, DB_NAME
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
/// Boot with no progress reporting (probes, tests).
pub fn boot_desktop_stack(cfg: &BootConfig) -> io::Result<DesktopStack> {
    boot_desktop_stack_with_progress(cfg, &|_| {})
}

/// Boot with a stage-reporting hook. The GUI splash screen feeds these short
/// Arabic labels to the user so a ~20s boot reads as progress, not a hang.
/// The hook must never block or fail the boot (splash may not exist yet).
pub fn boot_desktop_stack_with_progress(
    cfg: &BootConfig,
    progress: &dyn Fn(&str),
) -> io::Result<DesktopStack> {
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
    }
    let cfg = &cfg;

    progress("فحص ملفات التشغيل…");
    // Step 0: pre-flight — verify every runtime-critical bundled file exists on
    // disk. If an antivirus quarantined one of them post-install (a documented
    // pattern for unsigned postgres binaries), the user gets a clear Arabic
    // message instead of a silent crash on the first pg_ctl call.
    if let Err(missing) = preflight_check(cfg) {
        let list = missing.join("\n  • ");
        let msg = format!(
            "تعذّر تشغيل النظام: بعض ملفات التشغيل الأساسية مفقودة من مجلد التثبيت.\n\n  • {}\n\n\
             السبب الأكثر شيوعاً: برنامج الحماية (Antivirus) على هذا الجهاز حذف أو حجر أحد هذه الملفات أثناء التثبيت أو بعده.\n\n\
             الحل:\n  1) أضف مجلد تثبيت البرنامج إلى قائمة الاستثناءات في برنامج الحماية.\n  2) أعد تشغيل مثبّت البرنامج (Repair) لاستعادة الملفات المحذوفة.",
            list
        );
        show_fatal_dialog("خطأ في ملفات التشغيل — Motard ERP", &msg);
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("pre-flight: missing bundled files: {}", missing.join(", ")),
        ));
    }

    progress("تجهيز قاعدة البيانات المحلية…");
    let pgdata = match ensure_pgdata(&cfg.resources_root, &cfg.app_data_root) {        Ok(p) => p,
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
            return Err(e);
        }
    };
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
        return Err(e);
    }
    progress("تشغيل قاعدة البيانات…");
    if let Err(e) = start_postgres(&cfg.resources_root, &pgdata, cfg.db_port) {
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
        return Err(e);
    }

    let store = match secret_store::load_or_generate() {
        Ok(s) => s,
        Err(e) => {
            // Clean up postgres before showing the dialog so the user
            // does not accumulate orphaned processes on every retry.
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر إنشاء أو تحميل ملف الأسرار المحلي (secrets.dat).\n\n\
                 المسار: {}\n\n\
                 الخطأ: {}\n\n\
                 تأكد من:\n\
                 1) صلاحيات الكتابة في مجلد AppData\\Local\\motard-erp\n\
                 2) أن برنامج الحماية (Antivirus) لا يمنع التطبيق من كتابة الملفات\n\
                 3) عدم وجود ملف تالف بنفس الاسم",
                secret_store::secrets_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "<غير معروف>".to_string()),
                e
            );
            show_fatal_dialog("خطأ في ملف الأسرار — Motard ERP", &msg);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("secret_store: {}", e),
            ));
        }
    };
    progress("تشغيل محرّك النظام…");
    let backend = match spawn_backend(cfg, &store) {
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
            return Err(e);
        }
    };

    // Step 6 (parallel): start the SSR frontend server IMMEDIATELY, without
    // waiting for the backend to become healthy first. The SSR node process
    // spends ~6s importing the prebuilt nitro bundle — overlapping that with
    // the backend's own ~20s init saves the full SSR import cost off the
    // critical path. Ordering is still guaranteed: Step 7 waits for the
    // backend first, Step 8 waits for SSR after, so the first SSR paint can
    // reach a live API exactly as before.
    progress("تشغيل واجهة العرض…");
    let ssr = match spawn_ssr(cfg) {
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
            return Err(e);
        }
    };

    // Step 7: wait for the backend to report live.
    progress("انتظار محرّك النظام…");
    let live = wait_for(
        || http_get_ok("127.0.0.1", cfg.backend_port, "/api/health/live"),
        Duration::from_secs(60),
    );
    if !live {
        // Best-effort cleanup so a failed boot does not leave postgres running.
        let _ = ssr.kill();
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let msg = format!(
            "بدأ محرّك النظام لكنه لم يستجب خلال المهلة المتوقَّعة (60 ثانية).\n\n\
             المنفذ: {}\n\n\
             قد يكون الجهاز بطيئاً جداً في الإقلاع الأول، أو برنامج الحماية يفحص الملفات \
             ببطء. أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.",
            cfg.backend_port
        );
        show_fatal_dialog("خطأ: محرّك النظام لم يستجب — Motard ERP", &msg);
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "backend did not become healthy (/api/health/live)",
        ));
    }
    log("desktop stack is UP (postgres + backend)");

    // Step 8 (already running, see Step 6): wait for the SSR frontend to
    // answer on its LIGHTWEIGHT readiness probe. Polling "/" here was the
    // 5-minute-boot bug (verified live 2026-09-05): "/" forces a full SSR
    // render which takes minutes on a cold AV-scanned boot, so the 30s
    // timeout fired while the server was actually fine — then the fatal path
    // below orphaned the backend on 8080 and EVERY later boot failed too.
    // "/__health" (serve.mjs) answers from the node event loop with no render.
    progress("انتظار واجهة العرض…");
    let ssr_live = wait_for(
        || http_get_ok("127.0.0.1", SSR_PORT, "/__health"),
        Duration::from_secs(120),
    );
    if !ssr_live {
        // Kill EVERYTHING we started: leaving the backend alive on 8080 turns
        // one slow boot into a permanent failure cascade (next boot's backend
        // gets EADDRINUSE and can never become healthy).
        backend.kill();
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let _ = ssr.kill();
        let msg = "بدأت واجهة العرض لكنها لم تستجب خلال المهلة المتوقَّعة (120 ثانية).\n\n\
                     أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.";
        show_fatal_dialog("خطأ: واجهة العرض لم تستجب — Motard ERP", msg);
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "SSR frontend did not become healthy (http://127.0.0.1:4173/)",
        ));
    }
    log("SSR frontend is UP");

    Ok(DesktopStack {
        resources_root: cfg.resources_root.clone(),
        pgdata_dir: pgdata,
        db_port: cfg.db_port,
        backend_port: cfg.backend_port,
        backend: Some(backend),
        ssr: Some(ssr),
    })
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
pub fn shutdown(stack: &mut DesktopStack) {
    if let Some(b) = stack.backend.take() {
        log("stopping backend");
        b.kill();
    }
    if let Some(s) = stack.ssr.take() {
        log("stopping SSR frontend");
        s.kill();
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

/// Return `preferred` if free, otherwise an OS-assigned free port.
///
/// Root cause this closes (see REMEDIATION_LOG.md R-04): `db_port` was
/// hardcoded to 5432 with no conflict handling, so any other program already
/// bound to it (a system-installed PostgreSQL service, an orphaned instance
/// of this same app from a previous hard-kill) made `pg_ctl start` fail
/// outright. The bundled postgres is purely internal — the Node backend we
/// spawn ourselves is the only thing that ever needs `DATABASE_URL`, nothing
/// external is hardcoded to 5432 — so it is always safe to move it. (Do NOT
/// apply this same pattern to `backend_port`: the prebuilt SSR/frontend
/// bundle has that port baked in at build time and cannot discover a moved
/// one at runtime.)
///
/// Small TOCTOU race (something else could grab the port between this check
/// and postgres's own bind) is accepted: postgres/pg_ctl will simply fail
/// loudly and the existing fatal-dialog path in `boot_desktop_stack` covers
/// it, same as before this fix existed.
fn find_free_db_port(preferred: u16) -> u16 {
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l.local_addr().map(|a| a.port()).unwrap_or(preferred),
        Err(_) => preferred,
    }
}

// ── Small network helpers ───────────────────────────────────────────────────
fn wait_tcp(host: &str, port: u16, timeout: Duration) {
    let addr: std::net::SocketAddr = format!("{}:{}", host, port).parse().unwrap();
    let start = Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn http_get_ok(host: &str, port: u16, path: &str) -> bool {
    use std::net::TcpStream;
    let addr: std::net::SocketAddr = format!("{}:{}", host, port).parse().unwrap();
    let timeout = Duration::from_secs(2);
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(_) => return false,
    };
    stream
        .set_read_timeout(Some(timeout))
        .ok();
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let resp = String::from_utf8_lossy(&buf[..n]);
            resp.contains("HTTP/1.1 2")
        }
        _ => false,
    }
}

fn wait_for<F: Fn() -> bool>(pred: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn log(msg: &str) {
    eprintln!("[desktop-runtime] {}", msg);
}

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
