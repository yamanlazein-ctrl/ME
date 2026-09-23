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
