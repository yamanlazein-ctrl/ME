// Stack — process lifecycle for the self-contained Windows Desktop build.
//
// The local database is embedded SQLite (specs/001-desktop-sqlite-engine, US2): there is no
// database server, no database port and no port file. This module owns WHAT runs (one Node
// process: API + engine) while the sibling modules own the cross-cutting rules:
//   - `stages`  — the explicit boot order + splash labels,
//   - `error`   — one failure ⟹ one originating stage + one dialog,
//   - `health`  — bounded readiness gates,
//   - `crate::db_meta`   — the FRESH / REUSE / HALT startup decision (T076),
//   - `crate::data_lock` — the data-root lock (T071, acquired in main.rs before boot).
//
// The ERP business logic itself is untouched: this layer prepares the data root, decides the
// startup state from files only, starts the server with its environment, waits for the server's
// OWN health signal, and shuts it down on exit (Plan §1.1).
//
// Boot order (mirrors `stages::ALL`; DeviceBinding and the data lock run in main.rs first):
//   step 1  preflight — every runtime-critical bundled file exists and matches its sha256
//   step 2  apply a queued factory reset (rename the data aside — never delete)
//   step 3  load/generate the DPAPI secrets (JWT_SECRET, APP_MASTER_KEY)
//   step 4  reap this app's orphaned processes from an unclean exit
//   step 5  decide FRESH / REUSE / HALT (no file is changed by the decision)
//   step 6  start the Node server on the named pipe with DB_ENGINE=sqlite and the startup env
//   step 7  wait until /api/health/live answers on the pipe
//   shutdown: stop the server child
//
// Failure rule: the FIRST failing step shows ONE dialog naming the true cause, cleans up what was
// already started, and returns a `BootFailure` carrying the originating stage (Plan §0.2).
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::error::BootFailure;
use super::health::{wait_ready, WaitOutcome};
use super::stages::BootStage;

use crate::db_meta::{self, DbMeta as DbMetaSidecar, StartupState};
use crate::hidden_process::{HiddenChild, HiddenCommand};
use crate::secret_store;

#[derive(Clone, Debug)]
pub struct BootConfig {
    /// Directory containing the bundled `server/` and `node.exe`. Packaged app: the Tauri
    /// resource dir; probes: `src-tauri/resources`.
    pub resources_root: PathBuf,
    /// Per-user data root, `%LOCALAPPDATA%\motard-erp`: `data\motard.db`, `secrets.dat`,
    /// `device-binding.dat`, `backups\`, `logs\`.
    pub app_data_root: PathBuf,
    /// Node runtime used to launch the server (`node.exe` inside `resources_root`).
    pub node_exe: PathBuf,
    /// The bundled server: `server.mjs` + `web/` + `sqlite-migrations/` + `desktop-seed.json`.
    pub server_dir: PathBuf,
    /// `server_dir/server.mjs`.
    pub server_js: PathBuf,
    /// `server_dir/web` — the built SPA (embedded by Tauri; checked in preflight).
    pub web_dir: PathBuf,
    /// `server_dir/sqlite-migrations` — forward-only SQLite migrations + committed fingerprint.
    pub sqlite_migrations_dir: PathBuf,
    /// `server_dir/desktop-seed.json` — default tenant + pre-signed licence inserted on FRESH.
    pub seed_path: PathBuf,
    /// Windows named pipe the bundled server listens on.
    pub pipe_path: String,
    /// The Ed25519 *public* key (PEM) for verify-only licence checks. The private key is never
    /// injected (see spawn_server).
    pub license_public_key: Option<String>,
    /// Stable install identity from DPAPI `device-binding.dat`. Empty is refused.
    pub installation_id: String,
}

impl BootConfig {
    /// Resolve a config for the packaged app given Tauri's resource directory.
    pub fn for_app(resource_dir: PathBuf) -> Result<Self, String> {
        let server_dir = resource_dir.join("server");
        let license_public_key = fs::read_to_string(resource_dir.join("license-public.pem")).ok();
        let app_data_root = crate::app_data_dir()?;
        Ok(BootConfig {
            resources_root: resource_dir.clone(),
            pipe_path: super::pipe::PIPE_PATH.to_string(),
            app_data_root,
            node_exe: resource_dir.join("node.exe"),
            server_js: server_dir.join("server.mjs"),
            web_dir: server_dir.join("web"),
            sqlite_migrations_dir: server_dir.join("sqlite-migrations"),
            seed_path: server_dir.join("desktop-seed.json"),
            server_dir,
            license_public_key,
            installation_id: String::new(),
        })
    }
}

/// What the server is told about the data root (contracts/data-root-and-startup-states.md).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupEnv {
    /// `FRESH` (create the database) or `REUSE` (open the existing one).
    pub state: &'static str,
    /// The company's data identity: minted for FRESH, read from the sidecar for REUSE.
    pub data_id: String,
    /// The installer's HKCU install-instance marker (T075), if present.
    pub install_instance_id: Option<String>,
    /// REUSE after an update or the user's "Open existing data": the backend records the new install
    /// instance and this device's installation id (MOTARD_ADOPT_INSTALL_INSTANCE). First spawn only.
    pub adopt: bool,
    /// "Restore a backup": FRESH, then restore this archive before serving (MOTARD_RESTORE_ARCHIVE).
    /// First spawn only.
    pub restore_archive: Option<PathBuf>,
    /// Where "Restore a backup" moved the previous data; a failed restore moves it back.
    pub set_aside: Option<PathBuf>,
}

/// How a boot attempt ended without a running stack.
#[derive(Debug)]
pub enum BootOutcome {
    /// A failure with one originating stage (a dialog was already shown).
    Failed(BootFailure),
    /// A startup state that needs the user's choice; nothing was changed.
    Choose(db_meta::StartupState),
}

/// Everything needed to RUN — and to RESTART — the local stack. A supervised restart re-spawns
/// the server with exactly these values (after a FRESH boot the state is REUSE: the database exists).
pub struct DesktopStack {
    pub resources_root: PathBuf,
    pub cfg: BootConfig,
    /// The decrypted secrets the running server was started with.
    pub secrets: secret_store::SecretStore,
    pub startup: StartupEnv,
    /// The one live server child. `pub(crate)`: the supervisor swaps it when the process dies.
    pub(crate) server: Option<HiddenChild>,
}

/// Strip the Windows extended-length path prefix (`\\?\`) that Tauri's resource_dir() returns.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

/// CREATE_NO_WINDOW (winbase.h, 0x08000000). Only for short one-shot commands (`no_window_command`);
/// the long-running server goes through `crate::hidden_process` (SW_HIDE), which is reliable.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command::new` wrapper for short one-shot commands (fingerprint helpers, taskkill, listing).
pub fn no_window_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

const FACTORY_RESET_FLAG: &str = "factory-reset.requested";

/// The confirmed factory reset (typed phrase in the UI): the live data is RENAMED aside (same
/// volume, atomic) together with its identity sidecar and integrity manifest, and the next step
/// starts FRESH. Nothing is deleted.
fn apply_requested_factory_reset(cfg: &BootConfig) -> io::Result<()> {
    let flag = cfg.app_data_root.join(FACTORY_RESET_FLAG);
    if !flag.exists() {
        return Ok(());
    }
    log("factory-reset requested — moving data aside (kept as data.reset-*)");
    let archived = move_data_aside(&cfg.app_data_root)?;
    let _ = fs::remove_file(cfg.app_data_root.join("hub-session.json"));
    fs::remove_file(&flag)?;
    let mut details = serde_json::Map::new();
    details.insert(
        "archivedTo".into(),
        serde_json::Value::String(archived.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
    );
    super::boot_log::event("FACTORY_RESET", "factory_reset", details);
    Ok(())
}

/// Hub pairing state written by the server next to the data (hubConfig.ts).
const HUB_PAIRING_FILES: [&str; 3] = ["hub.json", "hub-session.json", "hub-credentials.dat"];

/// How many reset archives (`data.reset-*`) to keep; older ones are removed.
const RESET_ARCHIVES_KEPT: usize = 3;

/// Rename `data` to `data.reset-<utc>` (same volume → atomic) and move the company's identity
/// sidecar, integrity manifest and hub pairing into it. Returns the archive, or None when there
/// was nothing to move.
pub(crate) fn move_data_aside(app_data_root: &Path) -> io::Result<Option<PathBuf>> {
    let data = app_data_root.join(db_meta::DATA_DIR);
    let meta = db_meta::meta_path(app_data_root);
    if !data.exists() && !meta.exists() {
        return Ok(None);
    }
    let mut target = app_data_root.join(format!("data.reset-{}", chrono_like_utc_stamp()));
    let mut n = 1;
    while target.exists() {
        target = app_data_root.join(format!("data.reset-{}-{n}", chrono_like_utc_stamp()));
        n += 1;
    }
    if data.exists() {
        fs::rename(&data, &target)?;
    } else {
        fs::create_dir_all(&target)?;
    }
    // The identity and integrity records describe the archived company, not the fresh one: kept
    // WITH the archive. Left in place they would make the next boot refuse ("data missing").
    // The manifest rename is mandatory: a manifest left in place is read as a LIVE manifest by
    // the next boot (prior_data_evidence) and escalates a successful reset to DATA_MISSING.
    if meta.exists() {
        fs::rename(&meta, target.join("db-meta.before-reset.json"))?;
    }
    let manifest = db_meta::integrity_manifest_path(app_data_root);
    if manifest.exists() {
        fs::rename(&manifest, target.join("data-integrity.before-reset.json"))?;
    }
    // The retired PostgreSQL-era cluster is prior-data evidence too (db_meta::prior_data_evidence):
    // left in place it makes the next boot refuse to start fresh even though the SQLite company
    // data is fully archived. It belongs to the archived era, so it moves into the archive.
    let pgdata = app_data_root.join("pgdata");
    if pgdata.exists() {
        fs::rename(&pgdata, target.join("pgdata"))?;
    }
    // The hub pairing belongs to the archived company too: a fresh company left paired to the
    // OLD hub would pull the old company's documents. Kept with the archive, never deleted.
    for name in HUB_PAIRING_FILES {
        let p = app_data_root.join(name);
        if p.exists() {
            let _ = fs::rename(&p, target.join(format!("{name}.before-reset")));
        }
    }
    let mut archives: Vec<PathBuf> = fs::read_dir(app_data_root)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("data.reset-")))
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
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("utc-{secs}")
}

pub fn request_factory_reset(app_data_root: &Path) -> io::Result<()> {
    fs::create_dir_all(app_data_root)?;
    fs::write(app_data_root.join(FACTORY_RESET_FLAG), b"1")
}

// ── Step 4: reap our own orphans ─────────────────────────────────────────────
//
// A hard kill (power cut, Task Manager, an antivirus) can leave this app's OWN server child
// behind, holding the database file and the named pipe; the next boot then races a half-dead
// server. The match is anchored on our own per-user data directory, which the server receives on
// its command line (`--data-root=<root>`) and which no unrelated program references.

/// Would a process whose command line contains our data directory be one of ours?
pub(crate) fn is_our_orphan_command(command_line: &str, app_data_root: &str, own_pid: u32) -> bool {
    if command_line.is_empty() || app_data_root.is_empty() {
        return false;
    }
    let cmd = command_line.to_lowercase();
    // Only the server this app spawns: a node.exe image started with `--data-root=<root>`. A tool or
    // script that merely names the data root (a backup script, a test runner, robocopy) is not ours.
    let trimmed = cmd.trim_start();
    let image = match trimmed.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(""),
        None => trimmed.split(' ').next().unwrap_or(""),
    };
    if !(image == "node.exe" || image.ends_with("\\node.exe") || image.ends_with("/node.exe")) {
        return false;
    }
    let root = format!("--data-root={}", app_data_root.trim_end_matches(['\\', '/']).to_lowercase());
    // Not a bare substring test: sibling installs (`motard-erp-spike`, `motard-erp.SAFE-COPY-…`)
    // share the prefix. The match must end on a path boundary or a quote / the argument end.
    let matched = cmd.match_indices(root.as_str()).any(|(at, _)| {
        let rest = &cmd[at + root.len()..];
        rest.is_empty() || rest.starts_with('\\') || rest.starts_with('/') || rest.starts_with('"') || rest.starts_with(' ')
    });
    if !matched {
        return false;
    }
    !cmd.contains("powershell") && !cmd.contains(&format!("pid {own_pid}")) && !cmd.contains(&format!("-pid {own_pid}"))
}

/// Kill every live process that belongs to a previous run of THIS app. Best-effort.
pub(crate) fn reap_orphaned_processes(app_data_root: &Path) -> usize {
    let root = app_data_root.to_string_lossy().into_owned();
    let own_pid = std::process::id();
    let listed = no_window_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();
    let stdout = match listed {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(_) => {
            log("orphan reap: process listing failed");
            return 0;
        }
        Err(e) => {
            log(&format!("orphan reap: process table unavailable ({e})"));
            return 0;
        }
    };
    let mut reaped = 0usize;
    for line in stdout.lines() {
        let Some((pid_text, command_line)) = line.split_once('\t') else { continue };
        let Ok(pid) = pid_text.trim().parse::<u32>() else { continue };
        if pid == own_pid || !is_our_orphan_command(command_line, &root, own_pid) {
            continue;
        }
        log(&format!("orphan reap: killing pid {pid} — {}", truncate(command_line, 120)));
        if kill_pid(pid) {
            reaped += 1;
        }
    }
    reaped
}

fn kill_pid(pid: u32) -> bool {
    no_window_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

// ── Step 1: preflight ────────────────────────────────────────────────────────

/// The runtime-critical bundled files (an antivirus may quarantine one after install), plus the
/// sha256 of every manifest entry that carries one (`resources/resource-manifest.json`).
#[hotpath::measure]
fn preflight_check(cfg: &BootConfig) -> Result<(), Vec<String>> {
    let addon = cfg.server_dir.join("node_modules").join("better-sqlite3").join("prebuilds").join("win32-x64.node");
    let required = vec![
        cfg.node_exe.clone(),
        cfg.server_js.clone(),
        cfg.web_dir.join("_shell.html"),
        cfg.sqlite_migrations_dir.join("meta").join("_journal.json"),
        cfg.sqlite_migrations_dir.join("meta").join("schema-fingerprint.json"),
        cfg.seed_path.clone(),
        addon,
    ];
    let mut problems: Vec<String> = required.iter().filter(|f| !f.exists()).map(|f| f.display().to_string()).collect();
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

#[hotpath::measure]
fn verify_resource_sha256s(resources_root: &Path) -> Result<(), Vec<String>> {
    use sha2::{Digest, Sha256};
    let manifest_path = resources_root.join("resource-manifest.json");
    if !manifest_path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&manifest_path).map_err(|e| vec![format!("resource-manifest.json unreadable: {e}")])?;
    let manifest: ResourceManifestFile =
        serde_json::from_str(&text).map_err(|e| vec![format!("resource-manifest.json invalid JSON: {e}")])?;
    let mut mismatches = Vec::new();
    for entry in manifest.required {
        let Some(expected) = entry.sha256.filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())) else {
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
            mismatches.push(format!("{}: sha256 mismatch (expected {}, got {})", entry.path, expected, actual));
        }
    }
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(mismatches)
    }
}

/// Native Win32 MessageBox used ONLY for fatal boot errors before the Tauri window exists.
/// Automated probes set ME_HEADLESS=1 to assert the error without a blocking dialog.
#[cfg(windows)]
pub fn show_fatal_dialog(title: &str, message: &str) {
    if std::env::var("ME_HEADLESS").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[fatal-dialog] {} :: {}", title, message);
        return;
    }
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST};
    unsafe {
        let _ = MessageBoxW(None, &HSTRING::from(message), &HSTRING::from(title), MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
    }
}

#[cfg(not(windows))]
pub fn show_fatal_dialog(_title: &str, _message: &str) {}

// ── Step 6: spawn the Node server ────────────────────────────────────────────

/// Spawn the ONE bundled Node server (API + SQLite engine) with the injected secrets and the
/// startup environment. Shared with `supervisor`, which re-spawns exactly this command when the
/// child dies — a restart must be byte-identical to a boot (with `startup.state` = REUSE).
pub(crate) fn spawn_server(cfg: &BootConfig, store: &secret_store::SecretStore, startup: &StartupEnv) -> io::Result<HiddenChild> {
    let root = |p: &str| cfg.app_data_root.join(p).to_string_lossy().into_owned();
    log(&format!(
        "starting server (node {}) on pipe {} — DB_ENGINE=sqlite, state {}",
        cfg.node_exe.display(),
        cfg.pipe_path,
        startup.state
    ));
    let mut cmd = HiddenCommand::new(strip_verbatim_prefix(&cfg.node_exe));
    cmd.arg(strip_verbatim_prefix(&cfg.server_js))
        // Ties the process to this data root for the orphan reaper (the argument is ignored by the server).
        .arg(format!("--data-root={}", cfg.app_data_root.to_string_lossy()))
        .current_dir(strip_verbatim_prefix(&cfg.server_dir))
        .env("NODE_ENV", "production")
        .env("DESKTOP_DEPLOY", "true")
        .env("DESKTOP_PIPE", &cfg.pipe_path)
        .env("HOST", "127.0.0.1")
        .env_remove("SERVE_STATIC_DIR")
        .env_remove("DESKTOP_PORT_FILE")
        .env_remove("PORT")
        .env("CORS_ORIGIN", "http://127.0.0.1")
        // Writable per-user paths (Program Files is not writable for a standard user).
        .env("LOG_DIR", root("logs"))
        .env("COMPANY_LOGO_DIR", root("logos"))
        // The engine: embedded SQLite, no database server, no DATABASE_URL.
        .env("DB_ENGINE", "sqlite")
        .env("SQLITE_PATH", db_meta::database_path(&cfg.app_data_root).to_string_lossy().into_owned())
        .env("MOTARD_STARTUP_STATE", startup.state)
        .env("MOTARD_DATA_ID", &startup.data_id)
        .env("MOTARD_INSTALLATION_ID", &cfg.installation_id)
        .env("MOTARD_INSTALL_INSTANCE_ID", startup.install_instance_id.as_deref().unwrap_or(""))
        .env("MOTARD_INSTALL_INSTANCE_CHECK", "1")
        .env("MOTARD_ADOPT_INSTALL_INSTANCE", if startup.adopt { "1" } else { "0" })
        .env("DESKTOP_SEED_PATH", strip_verbatim_prefix(&cfg.seed_path).to_string_lossy().into_owned())
        .env(
            "DESKTOP_SQLITE_MIGRATIONS_FOLDER",
            strip_verbatim_prefix(&cfg.sqlite_migrations_dir).to_string_lossy().into_owned(),
        )
        .env_remove("DATABASE_URL")
        .env_remove("TEST_DB_URL")
        .env_remove("PGPASSWORD")
        .env_remove("POSTGRES_BIN")
        .env_remove("DESKTOP_MIGRATIONS_FOLDER")
        .env("JWT_SECRET", &store.jwt_secret)
        .env("APP_MASTER_KEY", &store.app_master_key)
        .env("HUB_CONFIG_PATH", root("hub.json"))
        .env("HUB_SESSION_PATH", root("hub-session.json"))
        .env("DESKTOP_DB_META_PATH", db_meta::meta_path(&cfg.app_data_root).to_string_lossy().into_owned())
        .env("MOTARD_BOOT_ID", super::boot_log::boot_id())
        .env("MOTARD_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("DATA_INTEGRITY_PATH", root("data-integrity.json"))
        // Defense: never let a stray private key reach the desktop client.
        .env_remove("LICENSE_SIGNING_KEY");
    match &startup.restore_archive {
        Some(archive) => {
            cmd.env("MOTARD_RESTORE_ARCHIVE", archive.to_string_lossy().into_owned());
        }
        None => {
            cmd.env_remove("MOTARD_RESTORE_ARCHIVE");
        }
    }
    if let Some(url) = read_hub_url(&cfg.app_data_root) {
        cmd.env("CENTRAL_SYNC_URL", url);
    }
    if let Some(pk) = &cfg.license_public_key {
        cmd.env("LICENSE_SIGNING_PUBLIC_KEY", pk);
    }
    let log_path = cfg.app_data_root.join("server.log");
    let out_log = super::boot_log::rotate_server_log(&log_path)?;
    let err_log = out_log.try_clone()?;
    cmd.stdin_null()?.stdout_file(out_log).stderr_file(err_log).spawn()
}

/// The ONE definition of "the bundled server is ready": the named pipe answers the liveness
/// probe. Boot and `supervisor` both go through here.
pub(crate) fn server_ready_probe() -> impl FnMut() -> Option<()> {
    move || super::pipe::probe_live().then_some(())
}

/// What the server itself said went wrong (its last `[FATAL]` line + a log tail).
pub(crate) fn server_failure_detail(app_data_root: &Path) -> String {
    let log_text = fs::read_to_string(app_data_root.join("server.log")).unwrap_or_default();
    let cause = last_fatal_reason(&log_text).unwrap_or_else(|| "no [FATAL] line in server.log".into());
    format!("{cause}\n\n{}", log_tail_for_dialog(&log_text))
}

// ── Step 5: the startup decision ─────────────────────────────────────────────

/// FRESH / REUSE from files only; HALT for anything else (never changes a file).
pub(crate) fn decide_startup(cfg: &BootConfig, launch: &db_meta::LaunchFacts) -> Result<StartupEnv, StartupState> {
    let idx = db_meta::bundled_schema_journal_idx(&cfg.sqlite_migrations_dir);
    let marker = launch.install_instance_marker.clone();
    match db_meta::evaluate_startup_state(&cfg.app_data_root, launch, idx, db_meta::new_data_id) {
        StartupState::Fresh { data_id } => {
            Ok(StartupEnv { state: "FRESH", data_id, install_instance_id: marker, adopt: false, restore_archive: None, set_aside: None })
        }
        StartupState::Reuse { data_id, adopt } => {
            Ok(StartupEnv { state: "REUSE", data_id, install_instance_id: marker, adopt, restore_archive: None, set_aside: None })
        }
        other => Err(other),
    }
}

/// Apply the user's choice for a startup state (T085). Returns the startup to boot with, or None
/// when the data root must simply be evaluated again ("locate"). No choice deletes data (C-13).
#[hotpath::measure]
pub fn apply_startup_choice(
    cfg: &BootConfig,
    launch: &db_meta::LaunchFacts,
    state: &StartupState,
    action: &str,
    archive: Option<PathBuf>,
) -> Result<Option<StartupEnv>, String> {
    if !state.options().contains(&action) {
        return Err(format!("option {action} is not offered for {}", state.code()));
    }
    let marker = launch.install_instance_marker.clone();
    let fresh = |restore: Option<PathBuf>, set_aside: Option<PathBuf>| StartupEnv {
        state: "FRESH",
        data_id: db_meta::new_data_id(),
        install_instance_id: marker.clone(),
        adopt: false,
        restore_archive: restore,
        set_aside,
    };
    let log_aside = |r: io::Result<Option<PathBuf>>| -> Result<Option<PathBuf>, String> {
        let aside = r.map_err(|e| format!("could not move the current data aside: {e}"))?;
        log(&format!("startup choice: previous data moved aside to {aside:?}"));
        Ok(aside)
    };
    match action {
        "open_existing" => {
            // The database itself says which company it is; the backend records this installation.
            let facts = db_meta::inspect_database(&db_meta::database_path(&cfg.app_data_root))?;
            Ok(Some(StartupEnv { state: "REUSE", data_id: facts.data_id, install_instance_id: marker, adopt: true, restore_archive: None, set_aside: None }))
        }
        "start_new" => {
            log_aside(db_meta::set_aside(&cfg.app_data_root))?;
            Ok(Some(fresh(None, None)))
        }
        "restore_backup" => {
            let file = archive.ok_or("no backup file was chosen")?;
            if !file.is_file() {
                return Err(format!("{} is not a file", file.display()));
            }
            // The archive is verified (and rejected with its own code) by the server before anything
            // is swapped; the current data is only moved aside, never deleted.
            let aside = log_aside(db_meta::set_aside(&cfg.app_data_root))?;
            Ok(Some(fresh(Some(file), aside)))
        }
        "locate" => {
            // The user points at a motard.db kept elsewhere: it is COPIED in (the original stays
            // untouched) and the copy goes through the normal evaluation again.
            let file = archive.ok_or("no database file was chosen")?;
            let target = db_meta::database_path(&cfg.app_data_root);
            if target.exists() {
                return Err("a database already exists in the data folder".into());
            }
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(&file, &target).map_err(|e| format!("could not copy {}: {e}", file.display()))?;
            let wal = PathBuf::from(format!("{}-wal", file.display()));
            if wal.exists() {
                let _ = fs::copy(&wal, format!("{}-wal", target.display()));
            }
            Ok(None)
        }
        other => Err(format!("{other} is handled by the window layer, not the data layer")),
    }
}

// ── Public entry point ───────────────────────────────────────────────────────

/// The launch facts the runtime gathers itself (marker from HKCU; the binding is assumed known).
pub fn default_launch_facts(cfg: &BootConfig) -> db_meta::LaunchFacts {
    db_meta::LaunchFacts {
        install_instance_marker: db_meta::read_install_instance_marker(),
        installation_id: cfg.installation_id.clone(),
        binding_new: false,
        running_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Boot with no progress reporting (probes, tests). A state that needs a choice is a failure here.
pub fn boot_desktop_stack(cfg: &BootConfig) -> Result<DesktopStack, BootFailure> {
    boot_desktop_stack_with_progress(cfg, &|_| {})
}

/// Boot with a stage-reporting hook. A state that needs the user's choice is reported as a failure
/// (callers that can prompt use `boot_desktop_stack_decided`).
pub fn boot_desktop_stack_with_progress(cfg: &BootConfig, progress: &dyn Fn(&str)) -> Result<DesktopStack, BootFailure> {
    match boot_desktop_stack_decided(cfg, progress, &default_launch_facts(cfg), None) {
        Ok(stack) => Ok(stack),
        Err(BootOutcome::Failed(f)) => Err(f),
        Err(BootOutcome::Choose(state)) => Err(BootFailure::new(BootStage::EvaluateData, state.code(), state.detail().to_string())),
    }
}

/// Boot with a stage-reporting hook (the splash screen's short Arabic labels; never blocks or
/// fails the boot). `decided`: the startup the user already chose (US3 actions); None = evaluate.
#[hotpath::measure]
pub fn boot_desktop_stack_decided(
    cfg: &BootConfig,
    progress: &dyn Fn(&str),
    launch: &db_meta::LaunchFacts,
    decided: Option<StartupEnv>,
) -> Result<DesktopStack, BootOutcome> {
    let fail = |f: BootFailure| BootOutcome::Failed(f);
    super::boot_log::init(cfg.app_data_root.join("logs"));
    let cfg = cfg.clone();

    progress(BootStage::Preflight.label());
    if let Err(missing) = preflight_check(&cfg) {
        let list = missing.join("\n  • ");
        let msg = format!(
            "تعذّر تشغيل النظام: بعض ملفات التشغيل الأساسية مفقودة أو معدّلة في مجلد التثبيت.\n\n  • {}\n\n\
             السبب الأكثر شيوعاً: برنامج الحماية (Antivirus) على هذا الجهاز حذف أو حجر أحد هذه الملفات أثناء التثبيت أو بعده.\n\n\
             الحل:\n  1) أضف مجلد تثبيت البرنامج إلى قائمة الاستثناءات في برنامج الحماية.\n  2) أعد تشغيل مثبّت البرنامج (Repair) لاستعادة الملفات.",
            list
        );
        show_fatal_dialog("خطأ في ملفات التشغيل — Motard ERP", &msg);
        return Err(fail(BootFailure::new(BootStage::Preflight, "preflight-missing-files", format!("pre-flight: {}", missing.join(", ")))));
    }

    progress(BootStage::FactoryReset.label());
    if let Err(e) = apply_requested_factory_reset(&cfg) {
        let msg = format!(
            "تعذّر تنفيذ إعادة الضبط المصنعي لمجلد البيانات المحلية.\n\nالخطأ: {}\n\nأغلق أي نسخة من البرنامج ثم أعد المحاولة.",
            e
        );
        show_fatal_dialog("خطأ في إعادة الضبط المصنعي — Motard ERP", &msg);
        return Err(fail(BootFailure::new(BootStage::FactoryReset, "factory-reset", e.to_string())));
    }

    progress(BootStage::LoadSecrets.label());
    let store = match secret_store::load_or_generate() {
        Ok(s) => s,
        Err(e) => {
            let msg = format!(
                "تعذّر إنشاء أو تحميل ملف الأسرار المحلي (secrets.dat).\n\nالمسار: {}\n\nالخطأ: {}",
                secret_store::secrets_path().map(|p| p.display().to_string()).unwrap_or_else(|_| "<غير معروف>".to_string()),
                e
            );
            show_fatal_dialog("خطأ في ملف الأسرار — Motard ERP", &msg);
            return Err(fail(BootFailure::new(BootStage::LoadSecrets, "load-secrets", format!("secret_store: {}", e))));
        }
    };

    let reaped = reap_orphaned_processes(&cfg.app_data_root);
    if reaped > 0 {
        log(&format!("boot: reaped {reaped} orphaned process(es) from a previous run"));
    }

    progress(BootStage::EvaluateData.label());
    let mut startup = match decided {
        Some(chosen) => chosen,
        None => match decide_startup(&cfg, launch) {
            Ok(s) => s,
            Err(state) => {
                let mut details = serde_json::Map::new();
                details.insert("state".into(), serde_json::Value::String(state.code().into()));
                details.insert("detail".into(), serde_json::Value::String(state.detail().into()));
                super::boot_log::event("STARTUP_CHOICE_NEEDED", "evaluate_data", details);
                return Err(BootOutcome::Choose(state));
            }
        },
    };
    let mut details = serde_json::Map::new();
    details.insert("state".into(), serde_json::Value::String(startup.state.into()));
    details.insert("dataId".into(), serde_json::Value::String(startup.data_id.clone()));
    super::boot_log::event("STARTUP_STATE", "evaluate_data", details);

    progress(BootStage::StartServer.label());
    let server = match spawn_server(&cfg, &store, &startup) {
        Ok(b) => {
            crate::hidden_process::hide_stray_console_async(b.id());
            b
        }
        Err(e) => {
            let msg = format!(
                "تعذّر تشغيل محرّك النظام.\n\nالخطأ: {}\n\nالمسار المتوقَّع: {}\n\n\
                 السبب الأكثر شيوعاً: برنامج الحماية حذف أو حجب node.exe بعد التثبيت.\n\n\
                 الحل: أعد تثبيت البرنامج، أو أضف مجلد التثبيت لاستثناءات برنامج الحماية.",
                e,
                cfg.node_exe.display()
            );
            show_fatal_dialog("خطأ في تشغيل محرّك النظام — Motard ERP", &msg);
            return Err(fail(BootFailure::new(BootStage::StartServer, "spawn-server", e.to_string())));
        }
    };

    // Readiness = the named pipe answers /api/health/live. Process gone → fail at once with its
    // exit code and log tail; alive but slow (first-run creation, a migration) → keep waiting.
    progress(BootStage::WaitServer.label());
    let outcome = wait_ready(
        server_ready_probe(),
        || server.try_exit_code(),
        |elapsed| {
            let secs = elapsed.as_secs();
            if secs >= 10 {
                progress(&format!("{} ({} ث) — التشغيل الأول قد يستغرق وقتاً أطول…", BootStage::WaitServer.label(), secs));
            }
        },
        Duration::from_secs(20 * 60),
    );
    match outcome {
        WaitOutcome::Ready(()) => {}
        failure => {
            abort_partial_boot(Some(&server));
            let log_text = fs::read_to_string(cfg.app_data_root.join("server.log")).unwrap_or_default();
            let log_tail = log_tail_for_dialog(&log_text);
            let cause = match failure {
                WaitOutcome::ChildExited(code) => format!("توقف محرّك النظام فجأة (رمز الخروج {code})."),
                _ => "بدأ محرّك النظام لكنه لم يصبح جاهزاً خلال 20 دقيقة.".to_string(),
            };
            let reason = last_fatal_reason(&log_text).map(|r| format!("\n\nالسبب: {r}")).unwrap_or_default();
            if let Some(fatal) = last_fatal_reason(&log_text) {
                let mut details = serde_json::Map::new();
                details.insert("reason".into(), serde_json::Value::String(fatal));
                super::boot_log::event("SERVER_START_FAILED", "wait_server", details);
            }
            let msg = format!(
                "{}{}\n\nآخر سطور السجل ({}):\n{}\n\nأعد فتح البرنامج، وإن تكررت المشكلة أرسل هذا الملف للدعم الفني.",
                cause,
                reason,
                cfg.app_data_root.join("server.log").display(),
                log_tail
            );
            // A rejected "Restore a backup" is not fatal: the caller puts the previous data back and
            // re-asks with this reason (main.rs), so no blocking dialog here.
            if startup.restore_archive.is_none() {
                show_fatal_dialog("خطأ: محرّك النظام لم يبدأ — Motard ERP", &msg);
            }
            return Err(fail(BootFailure::new(BootStage::WaitServer, "server-not-ready", reason.trim().trim_start_matches("السبب: ").to_string() + " (server did not become healthy)")));
        }
    };

    // The database now exists and carries this installation: every later spawn of this session
    // simply reopens it (FRESH, adoption and a startup restore are one-shot).
    if startup.adopt {
        // T084: the update hand-off token has served its purpose after the first successful open.
        let _ = fs::remove_file(db_meta::update_token_path(&cfg.app_data_root));
    }
    let restored = startup.restore_archive.is_some();
    startup.state = "REUSE";
    startup.adopt = false;
    startup.restore_archive = None;
    match db_meta::read_meta(&cfg.app_data_root) {
        // a restore brings the archive's data identity
        Ok(Some(DbMetaSidecar { data_id: Some(id), .. })) => {
            if id != startup.data_id && !restored {
                log(&format!("boot: sidecar data_id {id} differs from the one passed ({})", startup.data_id));
            }
            startup.data_id = id;
        }
        other => log(&format!("boot: no usable sidecar after open ({other:?})")),
    }
    log(&format!("desktop stack is UP (SQLite, server on pipe {})", cfg.pipe_path));

    Ok(DesktopStack { resources_root: cfg.resources_root.clone(), cfg, secrets: store, startup, server: Some(server) })
}

// ── Graceful / failure cleanup ───────────────────────────────────────────────

/// Tear down the child owned by a partial or failed boot (DFP-003).
fn abort_partial_boot(server: Option<&HiddenChild>) {
    const CHILD_EXIT_WAIT_MS: u32 = 5_000;
    if let Some(sv) = server {
        if !sv.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("abort_partial_boot: server did not exit within wait window");
        }
    }
}

/// The server writes `[FATAL] <reason>` to stderr (= server.log) when start-up is refused. The
/// LAST such line is the real cause.
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

/// Stop the server child. Committed data is durable without a clean stop (WAL, synchronous=FULL);
/// the next open replays the WAL.
#[hotpath::measure]
pub fn shutdown(stack: &mut DesktopStack) {
    const CHILD_EXIT_WAIT_MS: u32 = 8_000;
    if let Some(sv) = stack.server.take() {
        log("stopping server");
        if !sv.kill_and_wait(CHILD_EXIT_WAIT_MS) {
            log("shutdown: server did not exit within wait window after TerminateProcess");
        }
    }
}

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
mod fatal_reason_tests {
    use super::*;

    #[test]
    fn picks_the_last_fatal_line_not_the_unrelated_warning() {
        let log = "(node:1) DeprecationWarning: something\n\
                   [FATAL] Server startup failed: old reason\n\
                   [FATAL] Server startup failed: INSTALL_INSTANCE_MISMATCH: new installation detected\n";
        assert_eq!(
            last_fatal_reason(log).as_deref(),
            Some("Server startup failed: INSTALL_INSTANCE_MISMATCH: new installation detected")
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
mod hub_url_tests {
    use super::*;

    #[test]
    fn write_then_read_hub_url_and_backend_would_see_it() {
        let dir = std::env::temp_dir().join(format!(
            "motard-erp-hub-test-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        let written = write_hub_url(&dir, "https://erp.example.com/").unwrap();
        assert_eq!(written, "https://erp.example.com");
        assert_eq!(read_hub_url(&dir).as_deref(), Some("https://erp.example.com"));
        assert!(write_hub_url(&dir, "not-a-url").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod boot_lifecycle_tests {
    use super::*;

    const ROOT: &str = r"C:\Users\someone\AppData\Local\motard-erp";

    fn cfg_for(dir: &Path) -> BootConfig {
        BootConfig {
            resources_root: dir.join("resources"),
            app_data_root: dir.to_path_buf(),
            node_exe: dir.join("node.exe"),
            server_js: dir.join("server.mjs"),
            server_dir: dir.to_path_buf(),
            web_dir: dir.join("web"),
            sqlite_migrations_dir: dir.join("sqlite-migrations"),
            seed_path: dir.join("desktop-seed.json"),
            pipe_path: crate::runtime::pipe::PIPE_PATH.to_string(),
            installation_id: "id-a".into(),
            license_public_key: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("motard-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_orphaned_node_server_of_this_data_root_is_ours() {
        let cmd = r#""C:\Program Files\Motard\node.exe" "C:\Program Files\Motard\server\server.mjs" --data-root=C:\Users\someone\AppData\Local\motard-erp"#;
        assert!(is_our_orphan_command(cmd, ROOT, 4242));
        let quoted = r#"node.exe server.mjs "--data-root=C:\Users\someone\AppData\Local\motard-erp""#;
        assert!(is_our_orphan_command(quoted, ROOT, 4242));
    }

    #[test]
    fn the_match_ignores_path_casing() {
        let cmd = r#"node.exe server.mjs --data-root=c:\users\SOMEONE\appdata\local\MOTARD-ERP"#;
        assert!(is_our_orphan_command(cmd, ROOT, 4242));
    }

    #[test]
    fn an_unrelated_process_is_never_touched() {
        for cmd in [
            r#"C:\Program Files\PostgreSQL\17\bin\postgres.exe -D C:\pgdata"#,
            r#"C:\Windows\System32\svchost.exe -k netsvcs"#,
            r#"C:\Users\someone\AppData\Local\OtherApp\server.mjs"#,
            r#"node.exe server.mjs --data-root=C:\Users\someone\AppData\Local\motard-erp-spike"#,
            r#"node.exe server.mjs --data-root=C:\Users\someone\AppData\Local\motard-erp.SAFE-COPY-1"#,
            // names the data root but is not our server (a test runner / support script / wrapper)
            r#""C:\Program Files\nodejs\node.exe" scripts\lifecycle\e2e.mjs --root C:\Users\someone\AppData\Local\motard-erp"#,
            r#""C:\Program Files\Git\usr\bin\timeout.exe" 900 node.exe server.mjs --data-root=C:\Users\someone\AppData\Local\motard-erp"#,
            r#"robocopy C:\Users\someone\AppData\Local\motard-erp D:\copy /MIR"#,
        ] {
            assert!(!is_our_orphan_command(cmd, ROOT, 4242), "must not match: {cmd}");
        }
    }

    #[test]
    fn the_listing_shell_and_our_own_pid_are_excluded() {
        let powershell = r#"powershell -NoProfile -Command Get-CimInstance Win32_Process"#;
        assert!(!is_our_orphan_command(&format!("{powershell} {ROOT}"), ROOT, 4242));
        assert!(!is_our_orphan_command(&format!(r#"node.exe --data-root={ROOT} -pid 4242"#), ROOT, 4242));
    }

    #[test]
    fn empty_inputs_never_match() {
        assert!(!is_our_orphan_command("", ROOT, 4242));
        assert!(!is_our_orphan_command(r#"node.exe C:\x\server.mjs"#, "", 4242));
    }

    #[test]
    fn truncate_clips_without_splitting_a_char() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdefghij", 4), "abcd…");
    }

    #[test]
    fn queued_factory_reset_archives_the_data_instead_of_deleting_it() {
        let dir = scratch("reset-archive");
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("data").join("motard.db"), b"SQLite format 3\0invoice data").unwrap();
        fs::write(dir.join(FACTORY_RESET_FLAG), b"1").unwrap();
        fs::write(db_meta::meta_path(&dir), r#"{"data_id":"x"}"#).unwrap();
        for name in HUB_PAIRING_FILES {
            fs::write(dir.join(name), b"{\"url\":\"https://old-hub\"}").unwrap();
        }
        apply_requested_factory_reset(&cfg_for(&dir)).expect("a confirmed reset must not brick boot");
        assert!(!dir.join("data").exists(), "live data moved aside");
        assert!(!dir.join(FACTORY_RESET_FLAG).exists(), "flag consumed");
        assert!(!db_meta::meta_path(&dir).exists(), "next boot is FRESH");
        let archive = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).find(|e| e.file_name().to_string_lossy().starts_with("data.reset-")).expect("archive exists");
        assert!(archive.path().join("motard.db").exists(), "old data kept intact");
        assert!(archive.path().join("db-meta.before-reset.json").exists(), "identity kept with the archive");
        for name in HUB_PAIRING_FILES {
            assert!(!dir.join(name).exists(), "{name}: the fresh company must not stay paired to the old hub");
            assert!(archive.path().join(format!("{name}.before-reset")).exists(), "{name} kept with the archive");
        }
        // and the next decision is FRESH
        let launch = db_meta::LaunchFacts { installation_id: "id-a".into(), running_version: "1".into(), ..Default::default() };
        assert!(matches!(decide_startup(&cfg_for(&dir), &launch), Ok(StartupEnv { state: "FRESH", .. })));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_on_a_root_with_leftover_pgdata_and_manifest_boots_fresh() {
        // The field report: after a factory reset the app reopened into the dead "restore
        // session" prompt because `pgdata` (the retired PostgreSQL cluster) and an unmoveable
        // manifest counted as prior-data evidence (DATA_MISSING) on the very next boot.
        let dir = scratch("reset-pgdata");
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("data").join("motard.db"), b"SQLite format 3\0company").unwrap();
        fs::create_dir_all(dir.join("pgdata")).unwrap();
        fs::write(dir.join("pgdata").join("PG_VERSION"), "17\n").unwrap();
        fs::write(db_meta::integrity_manifest_path(&dir), r#"{"lastKnownCounts":{"invoices":5,"parties":2,"rolls":1}}"#).unwrap();
        fs::write(dir.join(FACTORY_RESET_FLAG), b"1").unwrap();
        apply_requested_factory_reset(&cfg_for(&dir)).expect("a confirmed reset must not brick boot");
        assert!(!dir.join("pgdata").exists(), "the PostgreSQL-era cluster must move into the archive");
        assert!(!db_meta::integrity_manifest_path(&dir).exists(), "no live manifest may remain");
        let launch = db_meta::LaunchFacts { installation_id: "id-a".into(), running_version: "1".into(), ..Default::default() };
        assert!(matches!(decide_startup(&cfg_for(&dir), &launch), Ok(StartupEnv { state: "FRESH", .. })), "the reported dead-end");
        let archive = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).find(|e| e.file_name().to_string_lossy().starts_with("data.reset-")).expect("archive exists");
        assert!(archive.path().join("pgdata").join("PG_VERSION").exists(), "the old cluster is kept, not deleted");
        assert!(archive.path().join("data-integrity.before-reset.json").exists(), "manifest kept with the archive");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn boot_without_the_flag_never_touches_the_data() {
        let dir = scratch("no-reset");
        fs::create_dir_all(dir.join("data")).unwrap();
        let db = dir.join("data").join("motard.db");
        fs::write(&db, b"490.00 paid 120.00").unwrap();
        for name in HUB_PAIRING_FILES {
            fs::write(dir.join(name), b"{\"url\":\"https://erp.example.com\"}").unwrap();
        }
        fs::write(db_meta::meta_path(&dir), "{}").unwrap();
        apply_requested_factory_reset(&cfg_for(&dir)).expect("an ordinary boot must not fail here");
        assert!(db.exists(), "committed data must survive an ordinary boot");
        assert!(db_meta::meta_path(&dir).exists(), "identity kept");
        for name in HUB_PAIRING_FILES {
            assert!(dir.join(name).exists(), "{name}: an ordinary boot must not unpair the device");
        }
        assert!(fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).all(|e| !e.file_name().to_string_lossy().starts_with("data.reset-")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn factory_reset_keeps_only_newest_archives() {
        let dir = scratch("reset-keep");
        for old in ["data.reset-utc-1", "data.reset-utc-2", "data.reset-utc-3"] {
            fs::create_dir_all(dir.join(old)).unwrap();
        }
        fs::create_dir_all(dir.join("data")).unwrap();
        fs::write(dir.join("data").join("motard.db"), b"x").unwrap();
        move_data_aside(&dir).unwrap();
        let left = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("data.reset-")).count();
        assert_eq!(left, RESET_ARCHIVES_KEPT);
        assert!(!dir.join("data.reset-utc-1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_names_every_missing_runtime_file() {
        let dir = scratch("preflight");
        let missing = preflight_check(&cfg_for(&dir)).expect_err("nothing staged");
        for needle in ["node.exe", "server.mjs", "_shell.html", "_journal.json", "schema-fingerprint.json", "desktop-seed.json", "win32-x64.node"] {
            assert!(missing.iter().any(|m| m.contains(needle)), "{needle} must be checked: {missing:?}");
        }
        assert!(!missing.iter().any(|m| m.to_lowercase().contains("postgres")), "no PostgreSQL file is required any more");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_resource_sha256s_detects_corruption() {
        use sha2::{Digest, Sha256};
        let dir = scratch("integrity");
        let payload = b"integrity-payload-v1";
        let good = format!("{:x}", Sha256::digest(payload));
        fs::write(dir.join("sealed.txt"), payload).unwrap();
        fs::write(dir.join("resource-manifest.json"), format!(r#"{{"required":[{{"path":"sealed.txt","kind":"file","sha256":"{good}"}}]}}"#)).unwrap();
        assert!(verify_resource_sha256s(&dir).is_ok());
        fs::write(dir.join("sealed.txt"), b"integrity-payload-v2").unwrap();
        let err = verify_resource_sha256s(&dir).expect_err("corrupted file must fail");
        assert!(err.iter().any(|e| e.contains("sha256 mismatch")));
        let _ = fs::remove_dir_all(&dir);
    }
}
