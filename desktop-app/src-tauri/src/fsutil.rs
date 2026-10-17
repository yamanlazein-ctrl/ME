//! File helpers with the guarantees the data lifecycle depends on: atomic replacement, verified
//! copies, and "move aside, never delete".

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Write `bytes` to `path` so that a crash leaves either the old file or the new one, never a torn
/// file: temp file in the same directory → flush to disk → rename over the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Copy `src` to `dst` and prove the copy is byte-identical (sha256). Returns the hash.
pub fn copy_verified(src: &Path, dst: &Path) -> std::io::Result<String> {
    if let Some(d) = dst.parent() {
        fs::create_dir_all(d)?;
    }
    let expected = sha256_file(src)?;
    fs::copy(src, dst)?;
    // FlushFileBuffers needs a handle with write access on Windows.
    fs::OpenOptions::new().write(true).open(dst)?.sync_all()?;
    let got = sha256_file(dst)?;
    if got != expected {
        return Err(std::io::Error::other(format!(
            "copy of {} is not identical (sha256 {} ≠ {})",
            src.display(),
            got,
            expected
        )));
    }
    Ok(expected)
}

pub fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("utc-{secs}")
}

/// A new, unused `<set_aside>\<stamp>-<label>\` path (not created yet).
pub fn new_aside_dir(set_aside: &Path, label: &str) -> PathBuf {
    let mut target = set_aside.join(format!("{}-{}", stamp(), label));
    while target.exists() {
        target = set_aside.join(format!("{}-{}-{}", stamp(), label, &uuid::Uuid::new_v4().to_string()[..8]));
    }
    target
}

/// Journal of an unfinished move: written before the first rename, removed after the last.
const MOVING: &str = ".moving.json";
const ROLLED_BACK: &str = ".rolled-back.json";

/// Move every existing path in `items` into `<set_aside>\<stamp>-<label>\`. Nothing is deleted.
pub fn move_aside(set_aside: &Path, label: &str, items: &[PathBuf]) -> std::io::Result<PathBuf> {
    let target = new_aside_dir(set_aside, label);
    move_into(&target, items)?;
    Ok(target)
}

/// Move `items` into `target`. A company is several files: if the process stops half way, the
/// journal lets the next start put the moved ones back (`recover_unfinished_moves`), so the data
/// is never left split between its folder and the set-aside folder.
pub fn move_into(target: &Path, items: &[PathBuf]) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    let present: Vec<&PathBuf> = items.iter().filter(|i| i.exists()).collect();
    let journal: Vec<String> = present.iter().map(|p| p.display().to_string()).collect();
    atomic_write(&target.join(MOVING), &serde_json::to_vec(&journal).map_err(std::io::Error::other)?)?;
    for item in present {
        let moved = item
            .file_name()
            .ok_or_else(|| std::io::Error::other("no file name"))
            .and_then(|name| fs::rename(item, target.join(name)));
        if let Err(e) = moved {
            rollback_move(target); // put back what already moved; the caller sees the error
            return Err(e);
        }
    }
    fs::remove_file(target.join(MOVING))
}

/// Put every item of an unfinished move in `dir` back where it came from (only where nothing took
/// its place). True when nothing was left behind.
fn rollback_move(dir: &Path) -> bool {
    let Ok(raw) = fs::read(dir.join(MOVING)) else { return false };
    let Ok(originals) = serde_json::from_slice::<Vec<String>>(&raw) else { return false };
    let mut complete = true;
    for original in originals.iter().map(PathBuf::from) {
        let Some(name) = original.file_name() else { continue };
        let moved = dir.join(name);
        if moved.exists() && (original.exists() || fs::rename(&moved, &original).is_err()) {
            complete = false;
        }
    }
    if complete {
        let _ = fs::rename(dir.join(MOVING), dir.join(ROLLED_BACK));
    }
    complete
}

/// Undo every move that a crash interrupted (run at start). Returns the folders rolled back.
pub fn recover_unfinished_moves(set_aside: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(set_aside) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|dir| dir.join(MOVING).exists() && rollback_move(dir))
        .collect()
}

/// True when `dir` holds a finished move (neither interrupted nor rolled back).
pub fn move_completed(dir: &Path) -> bool {
    dir.is_dir() && !dir.join(MOVING).exists() && !dir.join(ROLLED_BACK).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("motard-fsutil-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn atomic_write_replaces_and_copy_is_verified() {
        let d = tmpdir("aw");
        let f = d.join("a.json");
        atomic_write(&f, b"one").unwrap();
        atomic_write(&f, b"two").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"two");
        let sha = copy_verified(&f, &d.join("sub").join("b.json")).unwrap();
        assert_eq!(sha, sha256_file(&d.join("sub").join("b.json")).unwrap());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn move_aside_keeps_everything() {
        let d = tmpdir("ma");
        let a = d.join("motard.db");
        fs::write(&a, b"data").unwrap();
        let target = move_aside(&d.join("set-aside"), "start-new", &[a.clone(), d.join("absent")]).unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read(target.join("motard.db")).unwrap(), b"data");
        assert!(move_completed(&target));
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn an_interrupted_move_is_rolled_back_on_the_next_start() {
        let d = tmpdir("im");
        let (db, meta) = (d.join("motard.db"), d.join("install.json"));
        fs::write(&db, b"data").unwrap();
        fs::write(&meta, b"{}").unwrap();
        // Simulate a crash after the journal and the first rename, before the second.
        let target = new_aside_dir(&d.join("set-aside"), "start-new");
        fs::create_dir_all(&target).unwrap();
        let journal = vec![db.display().to_string(), meta.display().to_string()];
        fs::write(target.join(MOVING), serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::rename(&db, target.join("motard.db")).unwrap();

        assert!(!move_completed(&target));
        assert_eq!(recover_unfinished_moves(&d.join("set-aside")), vec![target.clone()]);
        assert_eq!(fs::read(&db).unwrap(), b"data", "database put back");
        assert!(meta.exists(), "the item never moved stays");
        assert!(!move_completed(&target), "a rolled-back folder is not a finished move");
        assert!(recover_unfinished_moves(&d.join("set-aside")).is_empty(), "idempotent");
        fs::remove_dir_all(d).ok();
    }
}
