//! Clean database stop when Windows shuts down, restarts or signs out.
//!
//! Windows ends a session by sending WM_QUERYENDSESSION / WM_ENDSESSION to
//! top-level windows and then terminating the process. Tauri does not turn
//! these into `RunEvent::ExitRequested`, so without this hook every Windows
//! shutdown with the app open killed postgres mid-flight: committed data is
//! safe (WAL), but the next boot paid crash recovery (fsync of the whole data
//! directory, ~40 s measured) instead of a ~3 s clean start.
//!
//! The hook asks Windows to wait (ShutdownBlockReasonCreate shows the reason
//! on the shutdown screen), runs the normal stack shutdown (server, then
//! `pg_ctl stop -m fast`, well under a second), then lets the session end.
#![cfg(windows)]

use std::sync::OnceLock;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_QUERYENDSESSION};

type Callback = Box<dyn Fn() + Send + Sync>;
static ON_SESSION_END: OnceLock<Callback> = OnceLock::new();
const SUBCLASS_ID: usize = 0x4d4f_5441; // "MOTA"

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            let _ = ShutdownBlockReasonCreate(hwnd, w!("Motard ERP — جاري حفظ قاعدة البيانات وإغلاقها بأمان…"));
            // Never veto the shutdown: we only need the few hundred ms below.
            LRESULT(1)
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                if let Some(cb) = ON_SESSION_END.get() {
                    cb();
                }
            }
            let _ = ShutdownBlockReasonDestroy(hwnd);
            LRESULT(0)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

/// Install the hook on the app's main window. `raw_hwnd` is the window handle
/// as a pointer-sized value (Tauri and this crate may use different `windows`
/// crate versions, so the handle crosses as a raw value).
pub fn install(raw_hwnd: isize, on_session_end: Callback) {
    if ON_SESSION_END.set(on_session_end).is_err() {
        return; // already installed
    }
    let hwnd = HWND(raw_hwnd as *mut core::ffi::c_void);
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
    }
}
