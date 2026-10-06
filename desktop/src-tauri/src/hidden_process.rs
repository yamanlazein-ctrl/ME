// Spawns child processes with CREATE_NO_WINDOW + STARTF_USESHOWWINDOW/SW_HIDE
// via raw CreateProcessW.
//
// Why not std::process::Command::creation_flags(CREATE_NO_WINDOW): verified
// live on 2026-09-03 that it does NOT reliably suppress the console window
// for console-subsystem children (postgres.exe, pg_ctl.exe, node.exe) when
// this process has none of its own (main.rs is windows_subsystem =
// "windows") — tested with Stdio::inherit(), Stdio::null(), and file
// redirection, launched via a truly console-less parent (WMI
// Win32_Process.Create, not just a GUI-subsystem exe run from a console
// shell) — a new console window still appeared every time. Explicitly
// setting STARTUPINFOW.wShowWindow = SW_HIDE (which std::process::Command
// has no way to set) is the documented, reliable fix for this exact
// combination.
//
// This also closes a real stability bug, not just a cosmetic one: a stray
// console window is a surface a user can accidentally click into and send a
// Ctrl+C to, which Windows broadcasts to every process sharing that console
// group — including postgres.exe if it ends up in the same group — killing
// it out from under the running app (observed live: postgres's background
// worker and recovery process both died with STATUS_CONTROL_C_EXIT seconds
// apart, corrupting the running instance until the next automatic WAL
// recovery). No console at all means no such surface exists.

use std::collections::{BTreeMap, HashSet};
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, HWND, LPARAM, WAIT_OBJECT_0,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, ShowWindow, SW_HIDE,
};

fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Quote one argv element per the CommandLineToArgvW/MSVCRT rules (the same
/// ones std::process::Command uses internally on Windows).
fn quote_arg(arg: &str, cmd: &mut String) {
    let needs_quotes = arg.is_empty() || arg.chars().any(|c| c == ' ' || c == '\t' || c == '"');
    if !needs_quotes {
        cmd.push_str(arg);
        return;
    }
    cmd.push('"');
    let mut chars = arg.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut backslashes = 1;
                while chars.peek() == Some(&'\\') {
                    backslashes += 1;
                    chars.next();
                }
                if matches!(chars.peek(), Some('"') | None) {
                    cmd.push_str(&"\\".repeat(backslashes * 2));
                } else {
                    cmd.push_str(&"\\".repeat(backslashes));
                }
            }
            '"' => cmd.push_str("\\\""),
            other => cmd.push(other),
        }
    }
    cmd.push('"');
}

fn make_inheritable(file: &File) -> io::Result<HANDLE> {
    let handle = HANDLE(file.as_raw_handle() as *mut c_void);
    unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("SetHandleInformation: {e}")))?;
    }
    Ok(handle)
}

/// A process spawned hidden (no console window, not shown in the taskbar).
/// Owns the process/thread handles; closes them on drop. Keeps the stdio
/// `File`s it was given alive for as long as the child might still be
/// writing to them.
// ── Process-tree kill guarantee (PR-1) ─────────────────────────────────────
// Root cause this closes: `impl Drop for HiddenChild` only closes handles, it
// does NOT terminate the child, and the shell has no Job Object. A force-close
// (Task Manager), a hard crash, or a logoff therefore orphaned `postgres.exe`
// (launched by `pg_ctl.exe`) and `node.exe`, which kept the pgdata lock, the
// DB port and the named pipe `motard-erp`. The next launch raced that orphan
// and failed to bind — the "won't reopen after Force Close / restart" bug.
//
// Fix: ONE process-wide job object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// Every child this module spawns is assigned to it. Job membership is inherited
// by descendants, so `postgres.exe` that `pg_ctl.exe` launches is captured
// without extra work. When this process ends — for ANY reason — the OS closes
// the job's last handle and terminates every member, releasing the lock/port/
// pipe instantly. The reactive reapers in `runtime::stack` remain as a second
// line of defense (they still run), just no longer load-bearing.
pub struct KillJob(HANDLE);
// SAFETY: a Job Object HANDLE is a kernel handle. We only read its value and
// pass it to AssignProcessToJobObject, and we intentionally never close it so
// it lives for the whole process and the OS performs the kill on exit.
unsafe impl Send for KillJob {}
unsafe impl Sync for KillJob {}

/// The shared kill job, created once and held for the process lifetime. Returns
/// `None` only if the OS refused to create it — we then degrade to the previous
//  behavior (boot-time reaper) rather than refusing to spawn the app.
fn kill_job() -> Option<HANDLE> {
    static JOB: OnceLock<Option<KillJob>> = OnceLock::new();
    JOB.get_or_init(|| match create_kill_job() {
        Ok(handle) => Some(KillJob(handle)),
        Err(e) => {
            crate::runtime::log(&format!(
                "warning: kill job object unavailable ({e}) — falling back to boot-time reaper"
            ));
            None
        }
    })
    .as_ref()
    .map(|job| job.0)
}

fn create_kill_job() -> io::Result<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("CreateJobObjectW: {e}")))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("SetInformationJobObject: {e}"),
            ));
        }
        Ok(job)
    }
}

pub struct HiddenChild {
    process: HANDLE,
    thread: HANDLE,
    pid: u32,
    _stdin: Option<File>,
    _stdout: Option<File>,
    _stderr: Option<File>,
}

// SAFETY: these are plain Win32 HANDLEs (process/thread), not tied to the
// creating thread; using them from another thread is the normal Win32 usage.
unsafe impl Send for HiddenChild {}

impl HiddenChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Block until the process exits. Returns true if it exited with code 0.
    pub fn wait_success(&self) -> io::Result<bool> {
        unsafe {
            WaitForSingleObject(self.process, INFINITE);
            let mut code: u32 = 0;
            GetExitCodeProcess(self.process, &mut code)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("GetExitCodeProcess: {e}")))?;
            Ok(code == 0)
        }
    }

    /// Non-blocking: `Some(exit_code)` when the process has ended, `None` while it is still running.
    pub fn try_exit_code(&self) -> Option<u32> {
        unsafe {
            if WaitForSingleObject(self.process, 0) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code: u32 = 0;
            GetExitCodeProcess(self.process, &mut code).ok()?;
            Some(code)
        }
    }

    /// Best-effort forceful termination (mirrors std::process::Child::kill).
    pub fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.process, 1);
        }
    }

    /// DFP-022: terminate then wait up to `timeout_ms` for the process to exit.
    /// Returns true if the process handle signaled within the timeout.
    pub fn kill_and_wait(&self, timeout_ms: u32) -> bool {
        self.kill();
        unsafe {
            let r = WaitForSingleObject(self.process, timeout_ms);
            r == WAIT_OBJECT_0
        }
    }
}

/// Node.js on Windows was empirically confirmed (2026-09-03) to still open
/// its own console window even when spawned via raw CreateProcessW with
/// CREATE_NO_WINDOW + STARTUPINFOW{ wShowWindow: SW_HIDE } — both verified
/// (same test) to work correctly for postgres/pg_ctl/initdb/createdb, but
/// not for node.exe specifically. Since we cannot stop node.exe from
/// allocating the console, detect it immediately after spawn and hide it
/// instead: find the conhost.exe that is a direct child of `pid` (that's
/// what actually owns the visible console window on modern Windows) and
/// hide every top-level window it owns — AND any top-level window owned by
/// `pid` itself (some Windows builds attach the console chrome to node).
/// Runs in a background thread and retries for a few seconds, since the
/// console isn't allocated the instant CreateProcessW returns. Scoped
/// strictly to `pid` and its descendants — never touches an unrelated
/// console window elsewhere on the system (e.g. the user's own terminal).
pub fn hide_stray_console_async(pid: u32) {
    std::thread::spawn(move || {
        for _ in 0..60 {
            let mut hid_any = false;
            hide_windows_owned_by(pid);
            for conhost_pid in child_processes_named(pid, "conhost.exe") {
                hide_windows_owned_by(conhost_pid);
                hid_any = true;
            }
            // Also hide consoles owned by immediate children (pg_ctl → postgres,
            // node workers) so a flash from a grandchild never sticks.
            for child_pid in child_process_ids(pid) {
                hide_windows_owned_by(child_pid);
                for conhost_pid in child_processes_named(child_pid, "conhost.exe") {
                    hide_windows_owned_by(conhost_pid);
                    hid_any = true;
                }
            }
            if hid_any {
                std::thread::sleep(std::time::Duration::from_millis(400));
                hide_windows_owned_by(pid);
                for conhost_pid in child_processes_named(pid, "conhost.exe") {
                    hide_windows_owned_by(conhost_pid);
                }
                for child_pid in child_process_ids(pid) {
                    hide_windows_owned_by(child_pid);
                    for conhost_pid in child_processes_named(child_pid, "conhost.exe") {
                        hide_windows_owned_by(conhost_pid);
                    }
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    });
}

fn child_process_ids(parent_pid: u32) -> Vec<u32> {
    let mut result = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return result,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == parent_pid {
                    result.push(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    result
}

fn child_processes_named(parent_pid: u32, name: &str) -> Vec<u32> {
    let mut result = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return result,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == parent_pid {
                    let exe = String::from_utf16_lossy(&entry.szExeFile);
                    let exe = exe.trim_end_matches('\0');
                    if exe.eq_ignore_ascii_case(name) {
                        result.push(entry.th32ProcessID);
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    result
}

fn hide_windows_owned_by(target_pid: u32) {
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let target_pid = lparam.0 as u32;
        let mut pid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == target_pid {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        BOOL(1)
    }
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(target_pid as isize));
    }
}

impl Drop for HiddenChild {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.process);
            let _ = CloseHandle(self.thread);
        }
    }
}

/// Builder for a hidden child process. Mirrors the small slice of
/// std::process::Command's API this crate actually uses.
pub struct HiddenCommand {
    program: String,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
    env: Vec<(String, String)>,
    env_remove: Vec<String>,
    stdin: Option<File>,
    stdout: Option<File>,
    stderr: Option<File>,
}

/// OS / locale keys safe to pass to bundled sidecars (DFP-012).
const ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "SYSTEMROOT",
    "SystemDrive",
    "windir",
    "WINDIR",
    "PATH",
    "Path",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "LANG",
    "LC_ALL",
    "LANGUAGE",
];

fn allowlisted_parent_env() -> BTreeMap<String, String> {
    let allow: HashSet<String> = ENV_ALLOWLIST
        .iter()
        .map(|k| k.to_ascii_uppercase())
        .collect();
    let mut out = BTreeMap::new();
    for (k, v) in std::env::vars() {
        if allow.contains(&k.to_ascii_uppercase()) {
            out.insert(k, v);
        }
    }
    out
}

/// True when `name` would be inherited under the sidecar allowlist (unit tests).
#[cfg(test)]
pub fn env_key_is_allowlisted(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ENV_ALLOWLIST
        .iter()
        .any(|k| k.to_ascii_uppercase() == upper)
}

impl HiddenCommand {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        HiddenCommand {
            program: program.as_ref().to_string_lossy().into_owned(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            stdin: None,
            stdout: None,
            stderr: None,
        }
    }

    pub fn arg(&mut self, a: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(a.as_ref().to_string_lossy().into_owned());
        self
    }

    pub fn args<I, S>(&mut self, a: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        for x in a {
            self.arg(x);
        }
        self
    }

    pub fn current_dir(&mut self, dir: impl AsRef<Path>) -> &mut Self {
        self.current_dir = Some(dir.as_ref().to_path_buf());
        self
    }

    pub fn env(&mut self, k: impl AsRef<str>, v: impl AsRef<str>) -> &mut Self {
        self.env.push((k.as_ref().to_string(), v.as_ref().to_string()));
        self
    }

    pub fn env_remove(&mut self, k: impl AsRef<str>) -> &mut Self {
        self.env_remove.push(k.as_ref().to_string());
        self
    }

    /// Redirect stdin to the NUL device (equivalent of Stdio::null()).
    pub fn stdin_null(&mut self) -> io::Result<&mut Self> {
        self.stdin = Some(File::options().read(true).write(true).open("NUL")?);
        Ok(self)
    }

    pub fn stdout_file(&mut self, f: File) -> &mut Self {
        self.stdout = Some(f);
        self
    }

    pub fn stderr_file(&mut self, f: File) -> &mut Self {
        self.stderr = Some(f);
        self
    }

    pub fn spawn(&mut self) -> io::Result<HiddenChild> {
        let mut cmdline = String::new();
        quote_arg(&self.program, &mut cmdline);
        for a in &self.args {
            cmdline.push(' ');
            quote_arg(a, &mut cmdline);
        }
        let mut cmdline_wide = to_wide_null(&cmdline);

        let cwd_wide = self.current_dir.as_ref().map(|d| to_wide_null(&d.to_string_lossy()));

        // DFP-012: allowlisted base environment only — never inherit arbitrary
        // parent/CI secrets (AWS_*, GITHUB_*, NPM_TOKEN, etc.). Explicit
        // `.env()` / `.env_remove()` still apply on top.
        let mut env_map = allowlisted_parent_env();
        for k in &self.env_remove {
            env_map.remove(k);
            // Windows env is case-insensitive; drop case variants too.
            let upper = k.to_ascii_uppercase();
            env_map.retain(|existing, _| existing.to_ascii_uppercase() != upper);
        }
        for (k, v) in &self.env {
            env_map.insert(k.clone(), v.clone());
        }
        let mut env_block: Vec<u16> = Vec::new();
        for (k, v) in &env_map {
            env_block.extend(OsStr::new(&format!("{k}={v}")).encode_wide());
            env_block.push(0);
        }
        env_block.push(0);

        let mut startup_info = STARTUPINFOW::default();
        startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup_info.dwFlags = STARTF_USESHOWWINDOW;
        startup_info.wShowWindow = SW_HIDE.0 as u16;

        let mut inherit_handles = false;
        if let Some(f) = &self.stdin {
            startup_info.hStdInput = make_inheritable(f)?;
            startup_info.dwFlags |= STARTF_USESTDHANDLES;
            inherit_handles = true;
        }
        if let Some(f) = &self.stdout {
            startup_info.hStdOutput = make_inheritable(f)?;
            startup_info.dwFlags |= STARTF_USESTDHANDLES;
            inherit_handles = true;
        }
        if let Some(f) = &self.stderr {
            startup_info.hStdError = make_inheritable(f)?;
            startup_info.dwFlags |= STARTF_USESTDHANDLES;
            inherit_handles = true;
        }

        let mut process_info = PROCESS_INFORMATION::default();

        unsafe {
            CreateProcessW(
                None,
                Some(PWSTR(cmdline_wide.as_mut_ptr())),
                None,
                None,
                inherit_handles,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                Some(env_block.as_ptr() as *const c_void),
                cwd_wide
                    .as_ref()
                    .map(|w| windows::core::PCWSTR(w.as_ptr()))
                    .unwrap_or(windows::core::PCWSTR::null()),
                &startup_info,
                &mut process_info,
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("CreateProcessW({}): {e}", self.program)))?;
        }

        // Bind the fresh child to the kill job (see `kill_job`). Membership is
        // inherited, so descendants (postgres.exe that pg_ctl.exe launches,
        // node.exe's children) are covered automatically. Non-fatal on failure:
        // the boot-time reaper in `runtime::stack` still reaps the orphan.
        if let Some(job) = kill_job() {
            unsafe {
                if let Err(e) = AssignProcessToJobObject(job, process_info.hProcess) {
                    crate::runtime::log(&format!(
                        "warning: could not assign pid {} to kill job ({e})",
                        process_info.dwProcessId
                    ));
                }
            }
        }

        Ok(HiddenChild {
            process: process_info.hProcess,
            thread: process_info.hThread,
            pid: process_info.dwProcessId,
            _stdin: self.stdin.take(),
            _stdout: self.stdout.take(),
            _stderr: self.stderr.take(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn allowlist_keeps_path_and_rejects_secret_sentinels() {
        assert!(env_key_is_allowlisted("PATH"));
        assert!(env_key_is_allowlisted("SystemRoot"));
        assert!(!env_key_is_allowlisted("AWS_SECRET_ACCESS_KEY"));
        assert!(!env_key_is_allowlisted("GITHUB_TOKEN"));
        assert!(!env_key_is_allowlisted("NPM_TOKEN"));
        assert!(!env_key_is_allowlisted("LICENSE_SIGNING_KEY"));
        let map = allowlisted_parent_env();
        assert!(
            !map.keys().any(|k| k.to_ascii_uppercase().contains("SECRET")
                || k.to_ascii_uppercase().contains("TOKEN")
                || k.to_ascii_uppercase().contains("AWS_")),
            "allowlisted map must not contain secret-like keys: {:?}",
            map.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn kill_and_wait_terminates_long_running_child() {
        // DFP-003 / DFP-022: process-tree proof that TerminateProcess + wait
        // actually reaps a live Windows child (port reuse depends on this).
        let child = HiddenCommand::new("ping.exe")
            .args(["-t", "127.0.0.1"])
            .spawn()
            .expect("spawn ping -t");
        assert!(child.id() > 0);
        assert!(
            child.kill_and_wait(5_000),
            "child must exit within wait window after TerminateProcess"
        );
    }

    #[test]
    fn kill_job_is_created_once_and_reused() {
        // PR-1 smoke test on real Windows: the process-wide kill job must be
        // created successfully and stably. The full kill-on-close guarantee
        // (Force Close -> no orphans holding the pipe/pgdata) is verified by the
        // runtime acceptance run; this proves the OS accepted our job
        // configuration on this platform and that the shared job is created
        // exactly once (so every child lands in the SAME job).
        let h1 = kill_job().expect("kill job must be created on Windows");
        let h2 = kill_job().expect("kill job must be created on Windows");
        assert_eq!(
            h1.0 as usize,
            h2.0 as usize,
            "the kill job must be created once and reused across spawns"
        );
    }

    #[test]
    fn live_child_env_dump_omits_parent_secret_sentinels() {
        // DFP-012: spawn a real Windows child and dump its environment.
        // Parent has secret sentinels; child must not inherit them.
        let sentinel = "DFP012_LIVE_SECRET_SENTINEL";
        let sentinel_val = "must-not-appear-in-sidecar";
        // SAFETY: test-only env mutation; restored below.
        unsafe { std::env::set_var(sentinel, sentinel_val) };
        unsafe { std::env::set_var("AWS_SECRET_ACCESS_KEY", "aws-live-sentinel") };
        unsafe { std::env::set_var("GITHUB_TOKEN", "gh-live-sentinel") };

        let out_path = std::env::temp_dir().join(format!(
            "dfp012-env-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let out_file = File::create(&out_path).expect("create env dump file");

        let child = HiddenCommand::new("cmd.exe")
            .args(["/C", "set"])
            .stdout_file(out_file)
            .spawn()
            .expect("spawn cmd /C set");
        let _ = child.wait_success();
        drop(child);

        let dump = fs::read_to_string(&out_path).unwrap_or_default();
        let _ = fs::remove_file(&out_path);

        unsafe { std::env::remove_var(sentinel) };
        unsafe { std::env::remove_var("AWS_SECRET_ACCESS_KEY") };
        unsafe { std::env::remove_var("GITHUB_TOKEN") };

        assert!(
            !dump.contains(sentinel_val),
            "child must not inherit DFP012 sentinel; dump sample: {}",
            dump.chars().take(200).collect::<String>()
        );
        assert!(
            !dump.to_ascii_uppercase().contains("AWS_SECRET_ACCESS_KEY"),
            "child must not inherit AWS_SECRET_ACCESS_KEY"
        );
        assert!(
            !dump.to_ascii_uppercase().contains("GITHUB_TOKEN"),
            "child must not inherit GITHUB_TOKEN"
        );
        assert!(
            dump.to_ascii_uppercase().contains("PATH="),
            "child must still receive allowlisted PATH; dump empty? len={}",
            dump.len()
        );
    }
}
