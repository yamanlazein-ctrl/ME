//! Data-root lock (specs/001-desktop-sqlite-engine T071, RT-6).
//!
//! `<root>\motard.lock` is opened with share mode 0 (no other open of the file can succeed while
//! it is held) and stays open for the whole process lifetime. The holder is described in the
//! readable sidecar `<root>\motard.lock.owner` (an exclusively opened file cannot be read by
//! anyone else): owner PID, process image path, boot id and installation id.
//!
//! On contention:
//!   * the holder is a live process of THIS app and installation (same image path, same
//!     installation id, another PID): wait for it to let go, then terminate it through the reaper —
//!     it is a previous instance that is still shutting down, or an orphan;
//!   * anything else (unknown image, another installation, unreadable owner): `LockedUnknown`.
//!     Nothing is deleted or replaced, ever.
//!   * The lock never terminates its own process.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const LOCK_FILE: &str = "motard.lock";
pub const OWNER_FILE: &str = "motard.lock.owner";

/// ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION.
const SHARING_VIOLATION: i32 = 32;
const LOCK_VIOLATION: i32 = 33;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockOwner {
    pub pid: u32,
    pub image: String,
    pub boot_id: String,
    pub installation_id: String,
}

/// Held for the process lifetime; dropping it releases the lock.
#[derive(Debug)]
pub struct DataLock {
    _file: File,
    pub path: PathBuf,
}

#[derive(Debug)]
pub enum LockError {
    /// Held by something that is not provably a previous instance of this installation.
    LockedUnknown(String),
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::LockedUnknown(d) => write!(f, "LOCKED_UNKNOWN: {d}"),
            LockError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// How contention is resolved; injectable so the rule is unit-testable without real processes.
pub struct Policy<'a> {
    pub is_alive: &'a dyn Fn(u32) -> bool,
    pub image_of: &'a dyn Fn(u32) -> Option<String>,
    pub terminate: &'a dyn Fn(u32) -> bool,
    /// How long a previous instance gets to exit on its own before it is terminated.
    pub grace: Duration,
}

fn try_open_exclusive(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(0);
    }
    opts.open(path)
}

fn is_contention(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(SHARING_VIOLATION) | Some(LOCK_VIOLATION))
}

fn same_image(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    !a.trim().is_empty() && norm(a) == norm(b)
}

fn read_owner(root: &Path) -> Option<LockOwner> {
    serde_json::from_str(&fs::read_to_string(root.join(OWNER_FILE)).ok()?).ok()
}

fn write_owner(root: &Path, owner: &LockOwner, file: &mut File) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(owner).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    // the lock file itself carries the same record (readable only by its holder)
    file.set_len(0)?;
    file.write_all(&body)?;
    file.sync_all()?;
    let tmp = root.join(format!("{OWNER_FILE}.tmp"));
    fs::write(&tmp, &body)?;
    fs::rename(&tmp, root.join(OWNER_FILE))
}

/// Acquire the data-root lock (see the module doc for the contention rule).
pub fn acquire_with(root: &Path, me: &LockOwner, policy: &Policy) -> Result<DataLock, LockError> {
    fs::create_dir_all(root).map_err(LockError::Io)?;
    let path = root.join(LOCK_FILE);
    let mut terminated = false;
    let started = Instant::now();
    loop {
        match try_open_exclusive(&path) {
            Ok(mut file) => {
                write_owner(root, me, &mut file).map_err(LockError::Io)?;
                return Ok(DataLock { _file: file, path });
            }
            Err(e) if is_contention(&e) => {
                let owner = read_owner(root);
                let ours = owner.as_ref().filter(|o| {
                    o.pid != me.pid
                        && o.installation_id == me.installation_id
                        && same_image(&o.image, &me.image)
                        && (policy.is_alive)(o.pid)
                        && (policy.image_of)(o.pid).map_or(false, |img| same_image(&img, &me.image))
                });
                let Some(prev) = ours else {
                    return Err(LockError::LockedUnknown(match owner {
                        Some(o) if o.pid == me.pid => "held by this process".into(),
                        Some(o) => format!("held by pid {} ({}) of installation {}", o.pid, o.image, o.installation_id),
                        None => "held by an unknown process (no readable owner record)".into(),
                    }));
                };
                if started.elapsed() < policy.grace {
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
                if terminated {
                    return Err(LockError::LockedUnknown(format!(
                        "previous instance pid {} still holds the lock after termination",
                        prev.pid
                    )));
                }
                (policy.terminate)(prev.pid);
                terminated = true;
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => return Err(LockError::Io(e)),
        }
    }
}

/// Production policy: real process table, the existing taskkill-based reaper.
pub fn acquire(root: &Path, installation_id: &str, boot_id: &str) -> Result<DataLock, LockError> {
    let me = LockOwner {
        pid: std::process::id(),
        image: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        boot_id: boot_id.to_string(),
        installation_id: installation_id.to_string(),
    };
    acquire_with(
        root,
        &me,
        &Policy {
            is_alive: &|pid| process_image(pid).is_some(),
            image_of: &process_image,
            terminate: &|pid| {
                crate::runtime::no_window_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            },
            grace: Duration::from_secs(10),
        },
    )
}

/// Image path of a live process, or None when it is gone / not inspectable.
#[cfg(windows)]
fn process_image(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == 259; // STILL_ACTIVE
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        (alive && named).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(not(windows))]
fn process_image(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("motard-lock-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = fs::remove_dir_all(&d);
        d
    }
    fn me(pid: u32) -> LockOwner {
        LockOwner { pid, image: r"C:\Program Files\Motard\motard.exe".into(), boot_id: "b".into(), installation_id: "inst-1".into() }
    }
    fn policy<'a>(alive: &'a dyn Fn(u32) -> bool, image: &'a dyn Fn(u32) -> Option<String>, kill: &'a dyn Fn(u32) -> bool) -> Policy<'a> {
        Policy { is_alive: alive, image_of: image, terminate: kill, grace: Duration::from_millis(300) }
    }

    #[test]
    fn exclusive_for_the_holders_lifetime_and_released_on_drop() {
        let r = root("excl");
        let never = |_: u32| -> bool { panic!("must not terminate anything") };
        let lock = acquire_with(&r, &me(100), &policy(&|_| true, &|_| None, &never)).expect("first acquire");
        // the lock file cannot be opened by anyone while held
        assert!(try_open_exclusive(&r.join(LOCK_FILE)).is_err());
        // the owner record names the holder
        assert_eq!(read_owner(&r).unwrap().pid, 100);
        // a second acquirer whose owner record is not provably ours → LOCKED_UNKNOWN, nothing touched
        let other = LockOwner { image: r"C:\elsewhere\tool.exe".into(), ..me(200) };
        assert!(matches!(acquire_with(&r, &other, &policy(&|_| true, &|_| Some(r"C:\elsewhere\tool.exe".into()), &never)), Err(LockError::LockedUnknown(_))));
        assert!(r.join(LOCK_FILE).exists() && read_owner(&r).unwrap().pid == 100, "nothing deleted or replaced");
        drop(lock);
        let again = acquire_with(&r, &me(300), &policy(&|_| true, &|_| None, &never)).expect("released on drop");
        drop(again);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn never_terminates_its_own_process() {
        let r = root("self");
        let never = |_: u32| -> bool { panic!("must not terminate itself") };
        let _held = acquire_with(&r, &me(100), &policy(&|_| true, &|_| None, &never)).unwrap();
        let img = me(100).image;
        let err = acquire_with(&r, &me(100), &policy(&|_| true, &|_| Some(img.clone()), &never)).unwrap_err();
        assert!(err.to_string().contains("held by this process"));
    }

    #[test]
    fn another_installation_or_a_dead_owner_is_unknown() {
        let r = root("unknown");
        let never = |_: u32| -> bool { panic!("must not terminate") };
        let _held = acquire_with(&r, &me(100), &policy(&|_| true, &|_| None, &never)).unwrap();
        let img = me(100).image;
        let other_install = LockOwner { installation_id: "inst-2".into(), ..me(200) };
        assert!(matches!(acquire_with(&r, &other_install, &policy(&|_| true, &|_| Some(img.clone()), &never)), Err(LockError::LockedUnknown(_))));
        // owner record says pid 100 but that pid is not alive (or is now another program): unknown
        assert!(matches!(acquire_with(&r, &me(200), &policy(&|_| false, &|_| None, &never)), Err(LockError::LockedUnknown(_))));
        assert!(matches!(acquire_with(&r, &me(200), &policy(&|_| true, &|_| Some(r"C:\x\other.exe".into()), &never)), Err(LockError::LockedUnknown(_))));
    }

    #[test]
    fn a_previous_instance_of_this_installation_is_waited_for_then_terminated() {
        let r = root("previous");
        let held = std::sync::Mutex::new(Some(acquire_with(&r, &me(100), &policy(&|_| true, &|_| None, &|_| panic!())).unwrap()));
        let img = me(100).image;
        let killed = Cell::new(0u32);
        let kill = |pid: u32| {
            assert_eq!(pid, 100, "only the previous instance is ever terminated");
            killed.set(killed.get() + 1);
            held.lock().unwrap().take(); // the previous instance dies → its handle closes
            true
        };
        let lock = acquire_with(&r, &me(200), &policy(&|_| true, &|_| Some(img.clone()), &kill)).expect("taken over");
        assert_eq!(killed.get(), 1);
        assert_eq!(read_owner(&r).unwrap().pid, 200);
        drop(lock);
    }
}
