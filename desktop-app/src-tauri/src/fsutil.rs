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

/// Move every existing path in `items` into `<set_aside>\<stamp>-<label>\`. Nothing is deleted.
pub fn move_aside(set_aside: &Path, label: &str, items: &[PathBuf]) -> std::io::Result<PathBuf> {
    let mut target = set_aside.join(format!("{}-{}", stamp(), label));
    while target.exists() {
        target = set_aside.join(format!("{}-{}-{}", stamp(), label, &uuid::Uuid::new_v4().to_string()[..8]));
    }
    fs::create_dir_all(&target)?;
    for item in items {
        if item.exists() {
            let name = item.file_name().ok_or_else(|| std::io::Error::other("no file name"))?;
            fs::rename(item, target.join(name))?;
        }
    }
    Ok(target)
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
        fs::remove_dir_all(d).ok();
    }
}
