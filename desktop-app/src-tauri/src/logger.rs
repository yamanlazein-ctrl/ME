//! Shell log (`<root>\logs\shell.log`). Codes, states and paths only — callers never pass key
//! material, tokens or request bodies (ADR-001 "Secrets never leak"). Rotates at 5 MB.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    *FILE.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(dir.join("shell.log"));
}

pub fn log(level: &str, msg: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{ts} {level} {msg}\n");
    if cfg!(debug_assertions) {
        eprint!("{line}");
    }
    let Some(lock) = FILE.get() else { return };
    let guard = lock.lock().unwrap();
    let Some(path) = guard.as_ref() else { return };
    if fs::metadata(path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn info(msg: &str) {
    log("INFO", msg)
}
pub fn warn(msg: &str) {
    log("WARN", msg)
}
pub fn error(msg: &str) {
    log("ERROR", msg)
}
