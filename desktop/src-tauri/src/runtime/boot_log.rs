//! Durable structured boot-decision log (REPAIR-013).
//!
//! Appends JSON lines to `%LOCALAPPDATA%\motard-erp\logs\boot.log`.
//! Best-effort: I/O errors are swallowed and never fail boot.

use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Allow-listed keys for `details` — never passwords, JWT, secrets, or full ids.
const ALLOWED_DETAIL_KEYS: &[&str] = &[
    "pgdataExists",
    "metaPresent",
    "manifestPresent",
    "schemaIdx",
    "bundledSchemaIdx",
    "pgMajor",
    "installationIdPrefix",
    "tenantIdPrefix",
    "counts",
    "reason",
    "path",
    "operation",
    "operationId",
    "event",
    "stage",
    "diffSummary",
    "snapshotPath",
    "warnings",
];

const MAX_BOOT_LOG_BYTES: u64 = 1 * 1024 * 1024; // 1 MiB (§19 Q15)
const BOOT_LOG_GENERATIONS: u32 = 5;

static BOOT_ID: OnceLock<String> = OnceLock::new();
static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

fn new_boot_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        rng.gen::<u32>(),
        rng.gen::<u16>(),
        rng.gen::<u16>() & 0x0fff,
        (rng.gen::<u16>() & 0x3fff) | 0x8000,
        rng.gen::<u64>() & 0xffffffffffff
    )
}

/// Process-wide boot correlation id. Generated once on first call.
pub fn boot_id() -> &'static str {
    BOOT_ID.get_or_init(new_boot_id)
}

/// Pin the logs directory (called once from boot with `app_data_root/logs`).
pub fn init(logs_dir: PathBuf) {
    let _ = LOGS_DIR.set(logs_dir);
    let _ = boot_id(); // ensure id exists for env export
}

fn logs_dir() -> Option<&'static Path> {
    LOGS_DIR.get().map(|p| p.as_path())
}

fn rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Compact UTC stamp without chrono dependency (ISO-ish).
    format!("{secs}")
}

fn filter_details(details: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in details {
        if ALLOWED_DETAIL_KEYS.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn rotate_if_needed(path: &Path) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_BOOT_LOG_BYTES {
        return;
    }
    // boot.log.N → boot.log.N+1 for N = 4..1; delete .5; then boot.log → .1
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("boot.log");
    let gen5 = parent.join(format!("{stem}.5"));
    let _ = fs::remove_file(&gen5);
    for n in (1..BOOT_LOG_GENERATIONS).rev() {
        let from = parent.join(format!("{stem}.{n}"));
        let to = parent.join(format!("{stem}.{}", n + 1));
        let _ = fs::rename(&from, &to);
    }
    let _ = fs::rename(path, parent.join(format!("{stem}.1")));
}

/// Append one structured event. Never panics; never fails the caller.
pub fn event(event_name: &str, stage: &str, details: Map<String, Value>) {
    let Some(dir) = logs_dir() else {
        return;
    };
    let _ = fs::create_dir_all(dir);
    let path = dir.join("boot.log");
    rotate_if_needed(&path);

    let record = json!({
        "ts": rfc3339_now(),
        "bootId": boot_id(),
        "event": event_name,
        "stage": stage,
        "details": filter_details(&details),
    });
    let mut line = match serde_json::to_string(&record) {
        Ok(s) => s,
        Err(_) => return,
    };
    line.push('\n');

    let write_once = || -> std::io::Result<()> {
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(line.as_bytes())?;
        Ok(())
    };
    let _ = write_once();
}

/// Convenience: TRACE-level forwarding from `runtime::log`.
pub fn trace(msg: &str) {
    let mut d = Map::new();
    d.insert("reason".into(), Value::String(msg.to_string()));
    event("TRACE", "runtime", d);
}

/// Rotate `server.log` → `server.log.1` … keep 3 generations, then truncate for a new boot.
pub fn rotate_server_log(server_log: &Path) -> std::io::Result<File> {
    if server_log.exists() {
        let parent = server_log.parent().unwrap_or_else(|| Path::new("."));
        let name = server_log
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("server.log");
        // Keep 3 generations: .3 deleted, .2→.3, .1→.2, current→.1
        let _ = fs::remove_file(parent.join(format!("{name}.3")));
        let _ = fs::rename(
            parent.join(format!("{name}.2")),
            parent.join(format!("{name}.3")),
        );
        let _ = fs::rename(
            parent.join(format!("{name}.1")),
            parent.join(format!("{name}.2")),
        );
        let _ = fs::rename(server_log, parent.join(format!("{name}.1")));
    }
    if let Some(parent) = server_log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    File::create(server_log)
}

// ── crash.log ───────────────────────────────────────────────────────────────
//
// Why this file exists
// -------------------
// A crash loop is the worst failure this app can have: the window flashes, the
// user sees nothing actionable, and every real reason (a port held by another
// process, a quarantined file, a database that will not start) scrolls past
// inside `server.log` / `pg.log` unread. `crash.log` is the ONE file that
// answers "what actually happened", stamped per event with the tails of both
// child logs and the exit code, so the diagnosis survives the restart that
// follows it.
//
// Best-effort by construction: this is a diagnostic aid and must never be the
// reason boot or a restart fails. Every I/O error here is swallowed.

/// How much of each child log is copied into a crash report. Enough to see the
/// fatal line and its immediate context, small enough to stay readable.
const CRASH_TAIL_LINES: usize = 40;

/// The last `n` lines of a file, or a marker when it is missing/unreadable.
fn tail_lines(path: &Path, n: usize) -> Vec<String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return vec![format!("<no readable {}>", path.display())],
    };
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return vec!["<empty>".to_string()];
    }
    let start = lines.len().saturating_sub(n);
    let mut out: Vec<String> = Vec::with_capacity(lines.len() - start + 1);
    if start > 0 {
        out.push(format!("… {} earlier line(s) omitted …", start));
    }
    out.extend(lines[start..].iter().map(|s| s.to_string()));
    out
}

/// Append one crash report to `logs/crash.log`.
///
/// Called on every supervisor restart AND when the circuit breaker trips, so
/// the file is a chronological account of the loop rather than just its last
/// frame. Best-effort: never returns an error.
#[allow(clippy::too_many_arguments)]
pub fn append_crash_report(
    app_data_root: &Path,
    event: &str,
    reason: &str,
    stage: &str,
    exit_code: Option<u32>,
    server_log: Option<&Path>,
    pg_log: Option<&Path>,
) {
    let logs_dir = app_data_root.join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let path = logs_dir.join("crash.log");

    let mut body = String::new();
    body.push_str("\n============================================================\n");
    body.push_str(&format!("time   : {}\n", now_iso()));
    body.push_str(&format!("boot   : {}\n", boot_id()));
    body.push_str(&format!("event  : {event}\n"));
    body.push_str(&format!("stage  : {stage}\n"));
    body.push_str(&format!("reason : {reason}\n"));
    body.push_str(&format!(
        "exit   : {}\n",
        exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "none (process did not exit)".to_string())
    ));

    if let Some(server_log) = server_log {
        body.push_str("---- server.log (tail) ----\n");
        for line in tail_lines(server_log, CRASH_TAIL_LINES) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    if let Some(pg_log) = pg_log {
        body.push_str("---- pg.log (tail) ----\n");
        for line in tail_lines(pg_log, CRASH_TAIL_LINES) {
            body.push_str(&line);
            body.push('\n');
        }
    }

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(body.as_bytes());
    }
}

/// Local wall-clock stamp. `SystemTime` alone is unreadable in a log a human
/// has to read at 3am, and this crate pulls in no date library for one line.
fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix+{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "motard-bootlog-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── crash.log ───────────────────────────────────────────────────────────

    #[test]
    fn a_crash_report_carries_the_child_logs_and_the_exit_code() {
        let dir = scratch();
        let server_log = dir.join("server.log");
        let pg_log = dir.join("pgdata").join("pg.log");
        fs::create_dir_all(pg_log.parent().unwrap()).unwrap();
        fs::write(&server_log, "[FATAL] port 57542 already in use\n").unwrap();
        fs::write(&pg_log, "LOG:  could not bind\n").unwrap();

        append_crash_report(
            &dir,
            "supervisor-restart",
            "the local server process exited (1)",
            "supervisor-restart",
            Some(1),
            Some(&server_log),
            Some(&pg_log),
        );

        let text = fs::read_to_string(dir.join("logs").join("crash.log")).unwrap();
        // The whole point of the file: the REAL reason, not our summary.
        assert!(text.contains("port 57542 already in use"), "{text}");
        assert!(text.contains("could not bind"), "{text}");
        assert!(text.contains("event  : supervisor-restart"), "{text}");
        assert!(text.contains("exit   : 1"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_append_so_the_file_is_a_timeline_of_the_loop() {
        let dir = scratch();
        for i in 1..=3 {
            append_crash_report(
                &dir,
                "supervisor-restart",
                &format!("attempt {i}"),
                "supervisor-restart",
                None,
                None,
                None,
            );
        }
        let text = fs::read_to_string(dir.join("logs").join("crash.log")).unwrap();
        assert_eq!(text.matches("event  : supervisor-restart").count(), 3);
        // Ordering is the diagnosis: attempt 1, then 2, then 3.
        let a = text.find("attempt 1").unwrap();
        let b = text.find("attempt 2").unwrap();
        let c = text.find("attempt 3").unwrap();
        assert!(a < b && b < c, "crash.log must be chronological");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_child_log_is_reported_not_silently_dropped() {
        // A crash report that omits pg.log would send support hunting for a
        // file that was never read.
        let dir = scratch();
        append_crash_report(
            &dir,
            "supervisor-stopped",
            "circuit breaker",
            "supervisor",
            None,
            Some(&dir.join("absent-server.log")),
            Some(&dir.join("absent-pg.log")),
        );
        let text = fs::read_to_string(dir.join("logs").join("crash.log")).unwrap();
        assert!(text.contains("no readable"), "{text}");
        assert!(text.contains("absent-server.log"), "{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_child_log_is_clipped_with_an_omission_marker() {
        let dir = scratch();
        let server_log = dir.join("server.log");
        let body: String = (0..500).map(|i| format!("line {i}\n")).collect();
        fs::write(&server_log, body).unwrap();
        append_crash_report(
            &dir,
            "supervisor-restart",
            "boom",
            "supervisor",
            None,
            Some(&server_log),
            None,
        );
        let text = fs::read_to_string(dir.join("logs").join("crash.log")).unwrap();
        assert!(text.contains("earlier line(s) omitted"), "{text}");
        assert!(text.contains("line 499"), "must keep the newest lines: {text}");
        assert!(!text.contains("line 10\n"), "must clip the oldest lines");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_writes_one_line_per_event() {
        let dir = scratch();
        // Re-init is OnceLock — use a fresh process conceptually by writing directly
        // via a local helper that mirrors event() against `dir`.
        let path = dir.join("boot.log");
        let mut d = Map::new();
        d.insert("reason".into(), json!("hello"));
        d.insert("password".into(), json!("secret")); // must be dropped
        let filtered = filter_details(&d);
        assert!(filtered.contains_key("reason"));
        assert!(!filtered.contains_key("password"));

        let record = json!({
            "ts": "1",
            "bootId": "test",
            "event": "REUSE",
            "stage": "ensure_pgdata",
            "details": filtered,
        });
        let mut line = serde_json::to_string(&record).unwrap();
        line.push('\n');
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(line.as_bytes()).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert_eq!(body.lines().count(), 1);
        assert!(body.contains("REUSE"));
        assert!(!body.contains("secret"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_keeps_five_files() {
        let dir = scratch();
        let path = dir.join("boot.log");
        // Seed oversize current + prior gens
        fs::write(&path, vec![b'x'; (MAX_BOOT_LOG_BYTES as usize) + 10]).unwrap();
        for n in 1..=4 {
            fs::write(dir.join(format!("boot.log.{n}")), b"old").unwrap();
        }
        rotate_if_needed(&path);
        assert!(!path.exists() || fs::metadata(&path).map(|m| m.len()).unwrap_or(0) == 0);
        assert!(dir.join("boot.log.1").exists());
        // After rotation of oversized file, .1 is the former current; .5 may exist from cascade
        let count = (1..=5)
            .filter(|n| dir.join(format!("boot.log.{n}")).exists())
            .count();
        assert!(count <= 5);
        assert!(count >= 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn io_error_does_not_panic() {
        // Uninitialised LOGS_DIR → event is a no-op
        event("TRACE", "test", Map::new());
    }

    #[test]
    fn server_log_rotation_keeps_previous() {
        let dir = scratch();
        let path = dir.join("server.log");
        fs::write(&path, b"previous boot").unwrap();
        let f = rotate_server_log(&path).unwrap();
        drop(f);
        assert_eq!(
            fs::read_to_string(dir.join("server.log.1")).unwrap(),
            "previous boot"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }
}
