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

use std::collections::BTreeMap;
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, HWND, LPARAM,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
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

    /// Best-effort forceful termination (mirrors std::process::Child::kill).
    pub fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.process, 1);
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
/// hide every top-level window it owns. Runs in a background thread and
/// retries for a few seconds, since the console isn't allocated the instant
/// CreateProcessW returns. Scoped strictly to descendants of `pid` — this
/// never touches an unrelated console window elsewhere on the system (e.g.
/// the user's own terminal).
pub fn hide_stray_console_async(pid: u32) {
    std::thread::spawn(move || {
        for _ in 0..40 {
            let mut hid_any = false;
            for conhost_pid in child_processes_named(pid, "conhost.exe") {
                hide_windows_owned_by(conhost_pid);
                hid_any = true;
            }
            if hid_any {
                // Keep sweeping briefly in case the window re-shows itself
                // right after creation, then stop — it's not going anywhere.
                std::thread::sleep(std::time::Duration::from_millis(500));
                for conhost_pid in child_processes_named(pid, "conhost.exe") {
                    hide_windows_owned_by(conhost_pid);
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
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

        // Inherit this process's environment, then apply overrides/removals —
        // the same semantics as std::process::Command.
        let mut env_map: BTreeMap<String, String> = std::env::vars().collect();
        for k in &self.env_remove {
            env_map.remove(k);
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
