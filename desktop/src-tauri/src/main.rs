// Packaged AND local desktop builds are a GUI app: a console window must never
// flash at the operator on launch. Debug logs go to server.log / boot log, not
// a cmd.exe surface. (Previously `not(debug_assertions)` left `dev-fast` as a
// console subsystem — every test launch opened a black CMD window.)
#![windows_subsystem = "windows"]

use motard_fabrics_erp::runtime::{
    apply_startup_choice, boot_desktop_stack_decided, no_window_command, BootConfig, BootOutcome, RecoveryReport,
    StackState, SupervisorHandle,
};
use motard_fabrics_erp::db_meta::{LaunchFacts, StartupState};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_updater::UpdaterExt;
use std::sync::OnceLock;

// No-op pass-through unless the `hotpath-alloc` feature is on.
#[global_allocator]
static GLOBAL: hotpath::CountingAllocator = hotpath::CountingAllocator::new();

static UPDATE_COORDINATOR: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// T071: the data-root lock, held for the whole process lifetime once acquired (released only by the
/// update path, right before the installer replaces the program).
static DATA_LOCK: OnceLock<std::sync::Mutex<Option<motard_fabrics_erp::data_lock::DataLock>>> = OnceLock::new();

// ── US3 startup choices (T085/T086) ──────────────────────────────────────────
// When the data root needs a decision (PRIOR_DATA_FOUND, MISMATCH, CORRUPT, TOO_NEW, DATA_MISSING,
// LOCKED_UNKNOWN) the boot thread publishes a prompt, shows the recovery window in "startup" mode and
// waits; the window answers through `startup_choose`. Nothing has been changed while it waits.

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupPrompt {
    state: String,
    detail: String,
    options: Vec<String>,
    /// The last choice failed (e.g. no file picked); shown above the options.
    error: Option<String>,
}

struct StartupChoice {
    action: String,
    file: Option<std::path::PathBuf>,
}

static STARTUP_PROMPT: OnceLock<std::sync::Mutex<Option<StartupPrompt>>> = OnceLock::new();
static STARTUP_CHOICE: OnceLock<(std::sync::Mutex<Option<StartupChoice>>, std::sync::Condvar)> = OnceLock::new();

fn prompt_slot() -> &'static std::sync::Mutex<Option<StartupPrompt>> {
    STARTUP_PROMPT.get_or_init(|| std::sync::Mutex::new(None))
}
fn choice_slot() -> &'static (std::sync::Mutex<Option<StartupChoice>>, std::sync::Condvar) {
    STARTUP_CHOICE.get_or_init(|| (std::sync::Mutex::new(None), std::sync::Condvar::new()))
}

/// Publish a prompt, show it, and block (boot thread) until the user chooses.
fn ask_user(app: &tauri::AppHandle, prompt: StartupPrompt) -> StartupChoice {
    eprintln!("[desktop-runtime] startup needs a choice: {} — {}", prompt.state, prompt.detail);
    // Release builds have no console: the state is also appended to logs\startup.log (support +
    // scripts/lifecycle/negative-cases.ps1 read it). Logging never blocks the prompt.
    if let Ok(root) = motard_fabrics_erp::app_data_dir() {
        use std::io::Write;
        let logs = root.join("logs");
        let _ = std::fs::create_dir_all(&logs);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(logs.join("startup.log")) {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "{secs} STARTUP_STATE={} options={}", prompt.state, prompt.options.join(","));
        }
    }
    let json = serde_json::to_string(&prompt).unwrap_or_default();
    *prompt_slot().lock().expect("startup prompt") = Some(prompt);
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        show_recovery_window(&a, &StackState::Failed { reason: String::new() });
        if let Some(w) = a.get_webview_window(RECOVERY_WINDOW) {
            let _ = w.eval(format!("window.setStartup && window.setStartup({json})"));
        }
    });
    let (lock, cv) = choice_slot();
    let mut slot = lock.lock().expect("startup choice");
    loop {
        if let Some(choice) = slot.take() {
            return choice;
        }
        slot = cv.wait(slot).expect("startup choice");
    }
}

fn prompt_for(state: &StartupState) -> StartupPrompt {
    StartupPrompt {
        state: state.code().to_string(),
        detail: state.detail().to_string(),
        options: state.options().iter().map(|o| o.to_string()).collect(),
        error: None,
    }
}

/// Close the startup screen once boot can continue.
fn close_startup_screen(app: &tauri::AppHandle) {
    *prompt_slot().lock().expect("startup prompt") = None;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window(RECOVERY_WINDOW) {
            let _ = w.destroy();
        }
    });
}

/// sha256(APP_MASTER_KEY): authenticates the runtime's own calls to /api/desktop/runtime/* (T083).
fn runtime_token() -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let store = motard_fabrics_erp::secret_store::load_or_generate().map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(store.app_master_key.as_bytes())))
}

fn runtime_call(path: &str, token: &str) -> motard_fabrics_erp::runtime::PipeResponse {
    let mut headers = std::collections::HashMap::new();
    headers.insert("x-motard-runtime-token".to_string(), token.to_string());
    headers.insert("content-type".to_string(), "application/json".to_string());
    motard_fabrics_erp::runtime::pipe_request(&motard_fabrics_erp::runtime::PipeRequest {
        method: "POST".into(),
        path: path.into(),
        body: Some("{}".into()),
        headers: Some(headers),
    })
}
/// Window label of the in-app recovery dialog (the application-level
/// replacement for WebView2's built-in navigation-failure page).
const RECOVERY_WINDOW: &str = "recovery";

/// The single page the main window ever loads. Phase 1 moved the SPA into the
/// binary: Tauri serves it over its own asset protocol, so the application is
/// no longer a web page fetched from a local port.
const APP_PAGE: &str = "_shell.html";

/// The only navigation the main window may ever perform.
///
/// The desktop build is fully offline by construction: the UI is embedded in
/// the binary and the API is reached through Rust over a named pipe, so there
/// is no remote origin to lose. Refusing anything else is what makes WebView2's
/// built-in "can't reach this page" screen unreachable by construction — it can
/// only ever appear for a navigation to a URL that is not in this list, and
/// there is none.
fn main_navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        // The app's own asset protocol, and Tauri's IPC channel on Windows.
        "tauri" | "asset" | "ipc" | "http" => {
            url.host_str().is_some_and(|h| {
                h == "tauri.localhost"
                    || h == "asset.localhost"
                    || h == "ipc.localhost"
                    || h == "localhost"
            })
        }
        // In-page schemes the UI itself renders (print preview, blob export).
        "blob" | "data" | "about" => true,
        _ => false,
    }
}

/// Drive the window layer from a supervisor state transition. Runs on the
/// monitor thread; every WebView2 call has to happen on the UI thread.
fn apply_stack_state(app: &tauri::AppHandle, state: &StackState) {
    // The closure must be 'static, so it takes an OWNED handle, not the
    // borrowed parameter; `run_on_main_thread` consumes a second clone.
    let app = app.clone();
    let state = state.clone();
    let _ = app.clone().run_on_main_thread(move || match &state {
        StackState::Healthy => {
            // The window never left the app: it is embedded, so "recovering"
            // is just the API coming back. Reloading is what re-runs the
            // queries that failed while it was down; a client-side navigation
            // to the same asset page is all that is needed.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.eval("window.location.reload()");
                let _ = main.show();
                let _ = main.set_focus();
            }
            if let Some(recovery) = app.get_webview_window(RECOVERY_WINDOW) {
                let _ = recovery.close();
            }
        }
        StackState::Recovering { .. } | StackState::Failed { .. } => {
            // Take the window away from the user. A page whose API is gone
            // cannot come back on its own.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            show_recovery_window(&app, &state);
        }
    });
}

/// Create (once) and show the in-app recovery dialog, then push the state it
/// should render. The page also fetches the state on load, so a dialog opened
/// mid-transition is never blank.
fn show_recovery_window(app: &tauri::AppHandle, state: &StackState) {
    let Ok(report) = serde_json::to_string(&RecoveryReport::of(state)) else {
        return;
    };
    if app.get_webview_window(RECOVERY_WINDOW).is_none() {
        // Built hidden and revealed on `Finished`, exactly like the main
        // window: showing a window whose webview has not painted yet is how a
        // dialog ends up a 159x27 sliver or, worse, with no content at all.
        let first_report = report.clone();
        match tauri::WebviewWindowBuilder::new(
            app,
            RECOVERY_WINDOW,
            tauri::WebviewUrl::App("recovery.html".into()),
        )
        // Sized in PHYSICAL px. `min` is deliberately BELOW the requested size
        // and `max` is left open: pinning min == max suppresses the resize the
        // webview needs to re-lay-out, and a hidden window that never re-lays
        // out keeps the document sized to the default 800x600 the builder
        // started from — the page then renders wider than the window and its
        // right-hand side is cut off.
        .inner_size(660.0, 560.0)
        .min_inner_size(560.0, 470.0)
        .visible(false)
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.eval(format!(
                "window.setRecovery && window.setRecovery({first_report})"
            ));
        })
        .build()
        {
            Ok(window) => {
                // The recovery dialog is a blocking error state, not a
                // dismissible one: closing it while the app is still broken
                // leaves a running process with no window at all. Once the
                // supervisor is Healthy the shell closes this window ITSELF —
                // and `close()` emits the same event, so the guard is scoped to
                // the broken state rather than to the source of the request.
                let for_event = app.clone();
                window.on_window_event(move |event| {
                    if !matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        return;
                    }
                    let healthy = for_event
                        .try_state::<Arc<SupervisorHandle>>()
                        .is_some_and(|s| matches!(s.state(), StackState::Healthy { .. }));
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if !healthy {
                            api.prevent_close();
                        }
                    }
                });
            }
            Err(e) => {
                eprintln!("[desktop-runtime] could not create the recovery window: {e}");
                return;
            }
        }
    }
    if let Some(recovery) = app.get_webview_window(RECOVERY_WINDOW) {
        let _ = recovery.show();
        let _ = recovery.set_focus();
        let _ = recovery.eval(format!(
            "window.setRecovery && window.setRecovery({report})"
        ));
    }
}

/// Issue 19: defensively (re)write HKCU Run so Windows starts the app after reboot.
/// The tauri-plugin-autostart Run key is known to vanish after one boot on some builds.
fn ensure_windows_autostart_run_key() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe_s = exe.to_string_lossy();
    // REG_SZ value must be a quoted path when it contains spaces.
    let value = format!("\"{exe_s}\"");
    let status = no_window_command("reg.exe")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "MotardFabricsErp",
            "/t",
            "REG_SZ",
            "/d",
            &value,
            "/f",
        ])
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!("autostart reg add exited {:?}", s.code()),
        Err(e) => eprintln!("autostart reg add failed: {e}"),
    }
}

fn main() {
    // Profiling guard (no-op unless built with `--features hotpath`). Not `#[hotpath::main]`: this process
    // ends via `std::process::exit(0)` in the run loop, which skips drops, so the guard is dropped there
    // explicitly. No console (windows subsystem) — set HOTPATH_OUTPUT_PATH to get the report as a file.
    let mut hotpath_guard = Some(hotpath::HotpathGuardBuilder::new("main").build());
    // Step 0 (Plan §2 — License ≠ Company ≠ Installation ≠ User): refuse to
    // boot unless this machine+user can decrypt the device-binding blob. A
    // copied/tampered install (different Windows user or PC) cannot decrypt
    // it and must NOT start the bundled stack. Fresh installs mint a new
    // installation identity here; company/user setup happens later in the ERP.
    // US3: a device binding created by THIS launch means a new installation for the data root.
    let binding_new = !motard_fabrics_erp::app_data_dir()
        .map(|r| r.join("device-binding.dat").exists())
        .unwrap_or(true);
    let installation_id = match motard_fabrics_erp::identity::ensure_fresh_installation() {
        Ok(id) => id,
        Err(e) => {
            eprintln!("FATAL: device binding failed ({:?}) — refusing to start.", e);
            let msg = match &e {
                motard_fabrics_erp::identity::DeviceBindError::Tampered => {
                    "تعذّر التحقق من ربط هذا الجهاز بالتثبيت.\n\n\
                     السبب الأكثر شيوعاً: تم نسخ مجلد البرنامج إلى جهاز أو حساب مستخدم مختلف \
                     عن الجهاز الذي جرى التثبيت عليه أصلاً.\n\n\
                     الحل: أعد تثبيت البرنامج على هذا الجهاز بحساب المستخدم الحالي، أو تواصل \
                     مع الدعم الفني."
                        .to_string()
                }
                motard_fabrics_erp::identity::DeviceBindError::Io(detail) => format!(
                    "تعذّر إنشاء أو قراءة ملف ربط الجهاز (device-binding.dat).\n\n\
                     الخطأ: {}\n\n\
                     تأكد من:\n\
                     1) صلاحيات الكتابة في مجلد AppData\\Local\\motard-erp\n\
                     2) أن برنامج الحماية (Antivirus) لا يمنع الكتابة",
                    detail
                ),
            };
            motard_fabrics_erp::runtime::show_fatal_dialog(
                "خطأ في ربط الجهاز — Motard ERP",
                &msg,
            );
            std::process::exit(2);
        }
    };

    let app = match tauri::Builder::default()
        // Must be the FIRST plugin. A second launch just brings the running window to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Option::<Vec<&str>>::None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Product requirement: open with Windows. Self-heal every launch
            // because HKCU\...\Run can be cleared after one reboot (upstream bug).
            use tauri_plugin_autostart::ManagerExt;
            let launcher = app.autolaunch();
            if let Err(e) = launcher.enable() {
                eprintln!("autostart enable failed: {}", e);
            } else if matches!(launcher.is_enabled(), Ok(false)) {
                let _ = launcher.enable();
            }
            // Issue 19 belt: also write HKCU Run directly — plugin alone can lose
            // the key after a reboot on some Windows builds.
            ensure_windows_autostart_run_key();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_fingerprint,
            validate_license,
            ensure_document_folders,
            archive_document_pdf,
            get_hub_url,
            set_hub_url,
            request_factory_reset,
            apply_factory_reset_now,
            get_app_version,
            get_data_root,
            save_backup_file,
            pick_backup_file,
            check_desktop_update,
            install_desktop_update,
            recovery_status,
            recovery_retry,
            recovery_log_tail,
            recovery_exit,
            startup_status,
            startup_choose,
            api,
        ])
        .build(tauri::generate_context!())
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("FATAL: tauri builder failed: {}", e);
            motard_fabrics_erp::runtime::show_fatal_dialog(
                "خطأ في تشغيل التطبيق — Motard ERP",
                &format!(
                    "تعذّر تهيئة إطار التطبيق.\n\n\
                     الخطأ: {}\n\n\
                     السبب الأكثر شيوعاً: مكوّن WebView2 Runtime غير مثبَّت أو تالف على هذا \
                     الجهاز.\n\n\
                     الحل: نزّل وثبّت \"WebView2 Runtime\" من موقع مايكروسوفت الرسمي ثم أعد \
                     فتح البرنامج.",
                    e
                ),
            );
            std::process::exit(4);
        }
    };

    // D4-3: boot the self-contained stack (Node backend + embedded SQLite) BEFORE the
    // window appears, so the frontend loads against a live local backend+DB.
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("FATAL: resource dir unavailable: {}", e);
            motard_fabrics_erp::runtime::show_fatal_dialog(
                "خطأ في ملفات التثبيت — Motard ERP",
                &format!(
                    "تعذّر تحديد مجلد موارد التطبيق.\n\n\
                     الخطأ: {}\n\n\
                     قد يكون التثبيت غير مكتمل أو تالف. أعد تشغيل مثبّت البرنامج (Repair) \
                     لإصلاح الملفات.",
                    e
                ),
            );
            std::process::exit(5);
        }
    };
    // A root with prior company data is never replaced by a fresh database: the
    // FRESH / REUSE / HALT decision (db_meta::evaluate_startup, T076) refuses it
    // inside boot, before anything is created.
    let cfg = match BootConfig::for_app(resource_dir) {
        Ok(mut c) => {
            c.installation_id = installation_id;
            c
        }
        Err(e) => {
            eprintln!("FATAL: BootConfig::for_app failed: {}", e);
            motard_fabrics_erp::runtime::show_fatal_dialog(
                "خطأ في إعداد بيانات التطبيق — Motard ERP",
                &format!(
                    "تعذّر تحديد مجلد بيانات المستخدم (AppData\\Local\\motard-erp).\n\n\
                     الخطأ: {}",
                    e
                ),
            );
            std::process::exit(6);
        }
    };
    // Boot the stack on a background thread so the event loop (and the splash
    // window) starts painting immediately — a ~20s synchronous boot would
    // otherwise leave the user staring at nothing. Progress goes to the
    // splash page via window.eval(); the main window stays hidden until the
    // stack is up then is shown and the splash closed, all through the
    // thread-safe AppHandle. Fatal errors keep the old behavior (blocking
    // Arabic dialog, then a real process exit).
    //
    // Once booted, the stack is owned by the supervisor for the rest of the
    // session: it is the only thing that watches the local server, and its
    // `stop()` is the only teardown path (Windows session end, ExitRequested
    // and the recovery dialog all funnel through it).
    let handle = app.handle().clone();
    let for_session_end = handle.clone();
    std::thread::spawn(move || {
        let report = |stage: &str| {
            if let Some(splash) = handle.get_webview_window("splash") {
                if let Ok(arg) = serde_json::to_string(stage) {
                    let _ = splash.eval(format!("window.setStage && window.setStage({})", arg));
                }
            }
        };
        // T071: the data-root lock, acquired BEFORE any backend is spawned. An unknown holder is
        // never touched: the user gets Retry (nothing is deleted or replaced).
        loop {
            match motard_fabrics_erp::data_lock::acquire(&cfg.app_data_root, &cfg.installation_id, motard_fabrics_erp::runtime::boot_id()) {
                Ok(lock) => {
                    *DATA_LOCK.get_or_init(|| std::sync::Mutex::new(None)).lock().expect("data lock") = Some(lock);
                    break;
                }
                Err(motard_fabrics_erp::data_lock::LockError::LockedUnknown(detail)) => {
                    let _ = ask_user(
                        &handle,
                        StartupPrompt { state: "LOCKED_UNKNOWN".into(), detail, options: vec!["retry".into(), "show_details".into()], error: None },
                    );
                    close_startup_screen(&handle);
                }
                Err(e) => {
                    motard_fabrics_erp::runtime::show_fatal_dialog(
                        "مجلد البيانات غير متاح — Motard ERP",
                        &format!("تعذّر فتح قفل مجلد البيانات. لم يُغيَّر أي ملف.

{e}"),
                    );
                    std::process::exit(7);
                }
            }
        }

        // US3: FRESH / REUSE boot straight through; every other state waits for the user's choice,
        // which is applied (never deleting data) before the next attempt.
        let launch = LaunchFacts {
            install_instance_marker: motard_fabrics_erp::db_meta::read_install_instance_marker(),
            installation_id: cfg.installation_id.clone(),
            binding_new,
            running_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let mut decided: Option<motard_fabrics_erp::runtime::StartupEnv> = None;
        let mut last_error: Option<String> = None;
        let stack = loop {
            let restoring_over = decided.as_ref().filter(|d| d.restore_archive.is_some()).and_then(|d| d.set_aside.clone());
            match boot_desktop_stack_decided(&cfg, &report, &launch, decided.take()) {
                Ok(stack) => break stack,
                Err(BootOutcome::Failed(e)) => {
                    if let Some(aside) = restoring_over {
                        // The chosen backup was rejected: put the previous data back and ask again.
                        match motard_fabrics_erp::db_meta::undo_set_aside(&cfg.app_data_root, &aside) {
                            Ok(()) => {
                                last_error = Some(format!("تعذّرت استعادة النسخة الاحتياطية، وأُعيدت البيانات السابقة كما كانت.
{e}"));
                                continue;
                            }
                            Err(u) => eprintln!("[desktop-runtime] could not put the previous data back from {}: {u}", aside.display()),
                        }
                    }
                    eprintln!("FATAL: desktop stack failed to boot: {}", e);
                    std::process::exit(3);
                }
                Err(BootOutcome::Choose(state)) => {
                    let mut prompt = prompt_for(&state);
                    prompt.error = last_error.take();
                    loop {
                        let choice = ask_user(&handle, prompt.clone());
                        match apply_startup_choice(&cfg, &launch, &state, &choice.action, choice.file) {
                            Ok(next) => {
                                decided = next;
                                break;
                            }
                            Err(e) => prompt.error = Some(e),
                        }
                    }
                    close_startup_screen(&handle);
                }
            }
        };

        // The health gate already proved the named pipe answers
        // /api/health/live (see `server_ready_probe`). The window loads the
        // embedded SPA — no port, no localhost, nothing to refuse — and stays
        // hidden until that first page has actually painted, so the user never
        // sees a blank window.
        let supervisor = Arc::new(SupervisorHandle::start(stack, move |state| {
            apply_stack_state(&for_session_end, state);
        }));
        handle.manage(Arc::clone(&supervisor));

        let for_main = handle.clone();
        let for_end = Arc::clone(&supervisor);
        let for_load = Arc::clone(&supervisor);
        let _ = handle.run_on_main_thread(move || {
            let built = tauri::WebviewWindowBuilder::new(
                &for_main,
                "main",
                tauri::WebviewUrl::App(APP_PAGE.into()),
            )
            .title("Motard Fabrics Group ERP")
            .inner_size(1400.0, 900.0)
            .min_inner_size(1024.0, 768.0)
            .center()
            .visible(false)
            .on_navigation(|url| main_navigation_allowed(&url))
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    return;
                }
                // `Finished` also fires for a FAILED navigation, so the window
                // is only revealed while the page is one this app serves AND
                // the API behind it is actually answering.
                if !main_navigation_allowed(payload.url()) || !for_load.is_healthy() {
                    eprintln!(
                        "[desktop-runtime] page load finished outside the app while the stack is down ({}) — window stays hidden",
                        payload.url()
                    );
                    return;
                }
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(splash) = window.app_handle().get_webview_window("splash") {
                    let _ = splash.close();
                }
            })
            .build();
            // Windows shutdown / restart / sign-out: stop postgres cleanly
            // before the session ends (see session_end.rs).
            #[cfg(windows)]
            if let Ok(window) = &built {
                if let Ok(hwnd) = window.hwnd() {
                    motard_fabrics_erp::session_end::install(
                        hwnd.0 as isize,
                        Box::new(move || {
                            eprintln!("[desktop-runtime] Windows session ending — shutting down stack");
                            for_end.stop();
                        }),
                    );
                }
            }
            if let Err(e) = built {
                eprintln!("FATAL: could not create the main window: {e}");
                motard_fabrics_erp::runtime::show_fatal_dialog(
                    "خطأ في فتح النافذة — Motard ERP",
                    &format!("تعذّر إنشاء نافذة البرنامج.\n\nالخطأ: {e}"),
                );
                std::process::exit(3);
            }
        });
    });

    let _ = app.run(move |_app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(supervisor) = _app.try_state::<Arc<SupervisorHandle>>() {
                eprintln!("[desktop-runtime] ExitRequested — shutting down stack");
                supervisor.stop();
            }
            // Closing the last window does not by itself terminate this
            // process (verified live 2026-09-04: postgres/node shut down
            // correctly and the window closed, but the Rust process lingered
            // indefinitely afterward — an invisible resident zombie with no
            // window and no taskbar entry). Force a real process exit once
            // the stack is down.
            drop(hotpath_guard.take());
            std::process::exit(0);
        }
    });
}

#[derive(Serialize)]
struct FingerprintResult {
    hash: String,
    hostname: String,
    os: String,
}

/// Collect machine fingerprint for license binding.
/// DFP-039 / P0-1: SHA-256 of the same versioned envelope as the Node
/// `NodeFingerprintProvider` — implemented in exactly one place
/// (`crate::fingerprint`) so the shell and the boot gate can never diverge.
#[tauri::command]
fn get_fingerprint() -> Result<FingerprintResult, String> {
    let info = motard_fabrics_erp::fingerprint::machine_info();
    let hash = motard_fabrics_erp::fingerprint::desktop_fingerprint()?;

    Ok(FingerprintResult {
        hash,
        hostname: info.hostname,
        os: info.os,
    })
}

// `license_key`/`fingerprint` arrive in the payload for wire compatibility with
// the frontend but the bundled-desktop validation path only needs `api_url`.
#[derive(Deserialize)]
#[allow(dead_code)]
struct ValidateRequest {
    api_url: String,
    license_key: String,
    fingerprint: String,
}

#[derive(Serialize)]
struct ValidateResult {
    valid: bool,
    status: String,
    message: String,
    grace_remaining_days: Option<i32>,
}

/// Validate license against the backend API.
#[tauri::command]
async fn validate_license(req: ValidateRequest) -> Result<ValidateResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/license/status", req.api_url);

    let resp = client
        .get(&url)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("API connection failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(ValidateResult {
            valid: false,
            status: "connection_error".into(),
            message: format!("تعذر الاتصال بالخادم: {}", resp.status()),
            grace_remaining_days: None,
        });
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    let status = body["status"].as_str().unwrap_or("unknown").to_string();
    let valid = status == "active" || status == "trial";

    Ok(ValidateResult {
        valid,
        status,
        message: if valid {
            "الترخيص ساري المفعول".into()
        } else {
            "الترخيص منتهي أو غير صالح".into()
        },
        grace_remaining_days: body["graceRemainingDays"].as_i64().map(|v| v as i32),
    })
}

/// Issue 12: create Desktop/<company name> + document-type subfolders.
#[tauri::command]
fn ensure_document_folders(company_name: Option<String>) -> Result<String, String> {
    motard_fabrics_erp::document_archive::ensure_document_folders(company_name)
}

/// Issue 12: drop a PDF (or HTML fallback) into the matching archive subfolder.
#[tauri::command]
fn archive_document_pdf(
    doc_type: String,
    file_stem: String,
    html: String,
    company_name: Option<String>,
) -> Result<motard_fabrics_erp::document_archive::ArchiveResult, String> {
    motard_fabrics_erp::document_archive::archive_document_pdf(doc_type, file_stem, html, company_name)
}

/// App semver from Cargo (kept in sync with tauri.conf.json `version`).
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Which per-user data root this binary opened, and whether that root is the
/// customer's install or a dev build's. The operator sees it in the UI, so a
/// "the new build still shows my old customers" report is answered by looking
/// rather than guessing — and a dev run can never be mistaken for the product.
#[tauri::command]
fn get_data_root() -> Result<motard_fabrics_erp::DataRootInfo, String> {
    motard_fabrics_erp::data_root_info()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedBackup {
    path: String,
    size_bytes: u64,
    sha256: String,
}

/// Copy `source` to `target` through `<target>.partial`, flush it, re-hash the COPY and keep it only
/// when its size and sha256 equal the verified backup's. Never leaves a partial or mismatched file.
#[hotpath::measure]
fn copy_verified(source: &std::path::Path, target: &std::path::Path, size: u64, sha256: &str) -> Result<SavedBackup, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let partial = std::path::PathBuf::from(format!("{}.partial", target.display()));
    let result = (|| -> Result<SavedBackup, String> {
        {
            let mut from = std::fs::File::open(source).map_err(|e| format!("تعذّر فتح النسخة: {e}"))?;
            let mut to = std::fs::File::create(&partial).map_err(|e| format!("تعذّر إنشاء الملف: {e}"))?;
            std::io::copy(&mut from, &mut to).map_err(|e| format!("تعذّر نسخ الملف: {e}"))?;
            to.flush().and_then(|_| to.sync_all()).map_err(|e| format!("تعذّر حفظ الملف على القرص: {e}"))?;
        }
        let mut hasher = Sha256::new();
        let mut f = std::fs::File::open(&partial).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        let mut written = 0u64;
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            written += n as u64;
            hasher.update(&buf[..n]);
        }
        drop(f);
        let got = format!("{:x}", hasher.finalize());
        if written != size || !got.eq_ignore_ascii_case(sha256) {
            return Err(format!(
                "الملف المحفوظ لا يطابق النسخة الموثَّقة (الحجم {written}/{size}) — لم يُحفظ."
            ));
        }
        if target.exists() {
            std::fs::remove_file(target).map_err(|e| format!("تعذّر استبدال الملف الموجود: {e}"))?;
        }
        std::fs::rename(&partial, target).map_err(|e| format!("تعذّر حفظ الملف: {e}"))?;
        Ok(SavedBackup { path: target.display().to_string(), size_bytes: written, sha256: got })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// T100 (U-2, I-11): save a VERIFIED backup where the user chooses. The bridge carries text only,
/// so the zip never crosses it: the shell copies the file itself and reports success only when the
/// copy's size and sha256 equal the verified file's. Only files inside `<data root>\backups` can be
/// saved this way. `Ok(None)` = the user cancelled the dialog.
#[tauri::command]
#[hotpath::measure]
async fn save_backup_file(
    source_path: String,
    expected_sha256: String,
    expected_size: u64,
    suggested_name: String,
) -> Result<Option<SavedBackup>, String> {
    let backups = motard_fabrics_erp::app_data_dir()?.join("backups");
    let source = std::fs::canonicalize(&source_path).map_err(|e| format!("النسخة غير موجودة: {e}"))?;
    let allowed = std::fs::canonicalize(&backups).map_err(|e| e.to_string())?;
    if !source.starts_with(&allowed) || source.extension().and_then(|x| x.to_str()) != Some("zip") {
        return Err("لا يمكن حفظ إلا النسخ الاحتياطية الموثَّقة لهذا البرنامج.".into());
    }
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("حفظ النسخة الاحتياطية")
            .set_file_name(&suggested_name)
            .add_filter("Motard backup", &["zip"])
            .save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(target) = picked else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || copy_verified(&source, &target, expected_size, &expected_sha256))
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
}

/// The inbound mirror of `save_backup_file`: let the operator choose the backup archive to restore.
///
/// WHY a native picker rather than the page's `<input type="file">`: the SPA reaches the API only over
/// the Tauri IPC bridge, whose request body is a `String` (`runtime/pipe.rs`: `PipeRequest.body`). A
/// `File` cannot cross it, so the patched `fetch` drops every non-string body and the server sees zero
/// bytes — which is exactly the "لم يصل أي ملف" a valid archive produced. The bridge is text-only by
/// design, so — as with the outbound backup — the SHELL owns the file: it picks it here, measures its
/// size and sha256, and hands the backend a PATH (`POST /api/backup/restore-path`). The backend
/// re-verifies size + sha256 from the file's own bytes before opening the archive, so a substituted or
/// truncated file is still refused. The archive itself is only ever READ.
///
/// `Ok(None)` = the user cancelled the dialog.
#[tauri::command]
#[hotpath::measure]
async fn pick_backup_file() -> Result<Option<SavedBackup>, String> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("اختر ملف النسخة الاحتياطية للاستعادة")
            .add_filter("Motard backup", &["zip"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    // Measure the chosen file so the server can confirm it received the very same bytes.
    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut f = std::fs::File::open(&path).map_err(|e| format!("تعذّر فتح الملف: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut size = 0u64;
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            size += n as u64;
            hasher.update(&buf[..n]);
        }
        if size == 0 {
            return Err("الملف المختار فارغ".to_string());
        }
        Ok(SavedBackup {
            path: path.display().to_string(),
            size_bytes: size,
            sha256: format!("{:x}", hasher.finalize()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateCheck {
    available: bool,
    version: Option<String>,
    body: Option<String>,
    date: Option<String>,
}

/// CDN check only — call after Control Plane `/api/license/updates/status` allows it.
#[tauri::command]
async fn check_desktop_update(app: tauri::AppHandle) -> Result<DesktopUpdateCheck, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(DesktopUpdateCheck {
            available: true,
            version: Some(update.version.clone()),
            body: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(DesktopUpdateCheck {
            available: false,
            version: None,
            body: None,
            date: None,
        }),
    }
}

/// Re-checks then downloads/installs. Windows installer typically exits the process.
#[tauri::command]
async fn install_desktop_update(app: tauri::AppHandle) -> Result<(), String> {
    let lock = UPDATE_COORDINATOR.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.try_lock().map_err(|_| "تحديث آخر قيد التنفيذ — أعد المحاولة لاحقاً".to_string())?;
    let supervisor = app
        .try_state::<Arc<SupervisorHandle>>()
        .ok_or_else(|| "لا يمكن تحديث التطبيق قبل تشغيل المشرف".to_string())?;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("لا يوجد تحديث متاح حالياً".into());
    };
    // Download/check first while the application is healthy. Only after a
    // signed update is available do we stop the owned stack; a failed CDN check
    // must not leave the running application unusable.
    //
    // T083 (D-1) — before applying: (a) a VERIFIED pre-update backup, or no update; (b) the hand-off
    // token naming THIS install instance and the target version, so the next start is REUSE even if
    // the installer writes a new marker; (c) a graceful server stop with wal_checkpoint(TRUNCATE),
    // then the data lock is released; (d) apply. A failed or timed-out stop is reported as exactly
    // that — never as a damaged database (LC-4).
    let token = runtime_token()?;
    let backup = tokio::task::spawn_blocking({
        let token = token.clone();
        move || runtime_call("/api/desktop/runtime/pre-update-backup", &token)
    })
    .await
    .map_err(|e| e.to_string())?;
    if backup.status != 200 {
        return Err(format!(
            "لم يُطبَّق التحديث: تعذّر إنشاء نسخة احتياطية موثَّقة قبل التحديث ({}). بياناتك كما هي.",
            backup.error.unwrap_or(backup.body)
        ));
    }
    let root = motard_fabrics_erp::app_data_dir()?;
    motard_fabrics_erp::db_meta::write_update_token(
        &root,
        &motard_fabrics_erp::db_meta::UpdateToken {
            install_instance_id: motard_fabrics_erp::db_meta::read_install_instance_marker(),
            from_version: env!("CARGO_PKG_VERSION").to_string(),
            to_version: update.version.clone(),
            created_at: format!("{:?}", std::time::SystemTime::now()),
        },
    )
    .map_err(|e| format!("لم يُطبَّق التحديث: تعذّر حفظ ملف التسليم ({e})"))?;
    let stopped = tokio::task::spawn_blocking(move || runtime_call("/api/desktop/runtime/shutdown", &token))
        .await
        .map_err(|e| e.to_string())?;
    if stopped.status != 200 {
        eprintln!(
            "[desktop-runtime] graceful stop before update did not confirm (status {}): {} — the server is stopped; committed data is durable (WAL)",
            stopped.status,
            stopped.error.clone().unwrap_or_default()
        );
    }
    supervisor.stop();
    if let Some(slot) = DATA_LOCK.get() {
        slot.lock().map_err(|e| e.to_string())?.take(); // release motard.lock for the installer
    }
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // macOS/Linux need an explicit restart; Windows usually exits in install().
    app.restart();
}

/// Persist the central hub URL for outbox sync. Does not change the UI API base.
#[tauri::command]
fn get_hub_url() -> Result<String, String> {
    let root = motard_fabrics_erp::app_data_dir()?;
    Ok(motard_fabrics_erp::runtime::read_hub_url(&root).unwrap_or_default())
}

/// Persist the central hub URL for outbox sync. Does not change the UI API base.
#[tauri::command]
fn set_hub_url(url: String) -> Result<String, String> {
    let root = motard_fabrics_erp::app_data_dir()?;
    motard_fabrics_erp::runtime::write_hub_url(&root, &url)
}

/// Queue an operator recovery request. Startup refuses to execute destructive
/// reset actions; a verified recovery tool must handle this flag. This command
/// does not wipe device-binding.dat or secrets.dat.
#[tauri::command]
fn request_factory_reset() -> Result<(), String> {
    let root = motard_fabrics_erp::app_data_dir()?;
    motard_fabrics_erp::runtime::request_factory_reset(&root).map_err(|e| e.to_string())
}

/// Start over from the login screen: queue the reset, then restart the process
/// so the archive happens on the very next boot instead of waiting for the
/// operator to close the app by hand.
///
/// The archive itself is still done by `apply_requested_factory_reset` during
/// boot, never here — moving a live cluster aside from inside a running server
/// is how the data gets damaged. `restart()` fires `ExitRequested`, which runs
/// the normal `shutdown()` (clean postgres stop) before the new process starts,
/// so nothing is killed mid-write.
#[tauri::command]
fn apply_factory_reset_now(app: tauri::AppHandle) -> Result<(), String> {
    let root = motard_fabrics_erp::app_data_dir()?;
    motard_fabrics_erp::runtime::request_factory_reset(&root).map_err(|e| e.to_string())?;
    // Never returns: the runtime tears the process down and boots again.
    app.restart();
}

// ── Phase 1: the API gateway ─────────────────────────────────────────────────
// The UI is embedded in the binary and has no HTTP origin any more, so this
// command IS the transport. It is the only thing standing between the SPA and
// the local sidecar, and it is deliberately thin: business logic, middleware,
// routes and tests are untouched in `server.ts` — only the bind target moved
// from a TCP port to a named pipe.

/// Forward one API request to the bundled sidecar over the named pipe.
///
/// `async` on purpose: a synchronous pipe read inside a sync command would run
/// on the UI thread and freeze the window for the duration of the request. The
/// blocking work goes to a blocking thread and the result comes back as data.
///
/// Response HEADERS are forwarded, not just the status and body. The app's
/// session layer depends on them — `Set-Cookie` for the refresh cookie and
/// `X-License-Grace` for the offline grace window — and dropping them would
/// quietly break "stay signed in" and license grace, so the pipe client has
/// to surface them rather than swallow everything but the body.
#[tauri::command]
#[hotpath::measure]
async fn api(
    req: motard_fabrics_erp::runtime::PipeRequest,
) -> motard_fabrics_erp::runtime::PipeResponse {
    tokio::task::spawn_blocking(move || motard_fabrics_erp::runtime::pipe_request(&req))
        .await
        .unwrap_or_else(|e| motard_fabrics_erp::runtime::PipeResponse {
            status: 0,
            headers: Vec::new(),
            body: String::new(),
            error: Some(format!("api bridge task failed: {e}")),
            elapsed_us: 0,
        })
}

// ── In-app recovery dialog ──────────────────────────────────────────────────
// The application-level replacement for WebView2's built-in navigation-failure
// page. These four commands are the dialog's entire surface: what happened,
// try again, show me the log, let me out.

/// Current supervisor state, rendered by the dialog. Fetched on load so a
/// dialog opened mid-transition is never blank, and pushed on every change.
#[tauri::command]
fn recovery_status(supervisor: State<'_, Arc<SupervisorHandle>>) -> RecoveryReport {
    RecoveryReport::of(&supervisor.state())
}

/// Operator pressed "retry": spend a fresh attempt budget on the next cycle
/// instead of sitting in the exhausted `Failed` state.
#[tauri::command]
fn recovery_retry(supervisor: State<'_, Arc<SupervisorHandle>>) {
    supervisor.request_retry();
}

/// The server's own account of what went wrong (last `[FATAL]` line + log tail).
/// This is the actionable text: "the local port is unreachable" never is.
#[tauri::command]
fn recovery_log_tail(supervisor: State<'_, Arc<SupervisorHandle>>) -> String {
    supervisor.failure_detail()
}

/// The startup prompt the recovery window should render, if boot is waiting for a choice (T086).
#[tauri::command]
fn startup_status() -> Option<StartupPrompt> {
    prompt_slot().lock().ok().and_then(|g| g.clone())
}

/// The user's answer to the startup prompt. File-based actions open the native picker here.
#[tauri::command]
fn startup_choose(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let offered = prompt_slot().lock().ok().and_then(|g| g.clone()).map(|p| p.options).unwrap_or_default();
    if action == "quit" {
        app.exit(0);
        return Ok(());
    }
    if !offered.contains(&action) {
        return Err(format!("{action} is not an option now"));
    }
    let file = match action.as_str() {
        "restore_backup" => Some(
            rfd::FileDialog::new()
                .set_title("اختر ملف النسخة الاحتياطية")
                .add_filter("Motard backup", &["zip"])
                .pick_file()
                .ok_or("لم يُختر أي ملف")?,
        ),
        "locate" => Some(
            rfd::FileDialog::new()
                .set_title("اختر ملف قاعدة البيانات motard.db")
                .add_filter("Motard database", &["db"])
                .pick_file()
                .ok_or("لم يُختر أي ملف")?,
        ),
        "show_details" | "install_newer" => return Ok(()), // rendered by the window itself
        _ => None,
    };
    let (lock, cv) = choice_slot();
    *lock.lock().map_err(|e| e.to_string())? = Some(StartupChoice { action, file });
    cv.notify_all();
    Ok(())
}

/// Stop the local stack cleanly (server child) and exit.
#[tauri::command]
fn recovery_exit(app: tauri::AppHandle, supervisor: State<'_, Arc<SupervisorHandle>>) {
    supervisor.stop();
    app.exit(0);
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn the_app_asset_origin_is_allowed_on_any_path() {
        // After Phase 1 the UI has no port at all: it is served from Tauri's
        // own asset protocol, and client-side routes are all the same origin.
        for path in [
            "tauri://localhost/_shell.html",
            "tauri://localhost/assets/app-abc.js",
            "http://tauri.localhost/_shell.html",
        ] {
            assert!(main_navigation_allowed(&url(path)), "{path}");
        }
    }

    #[test]
    fn the_ipc_channel_is_allowed() {
        // Tauri reaches the native commands over its own channel; refusing it
        // would silently break every desktop command.
        assert!(main_navigation_allowed(&url("ipc://localhost")));
        assert!(main_navigation_allowed(&url("http://ipc.localhost")));
    }

    #[test]
    fn remote_urls_are_refused() {
        // This is what makes WebView2's network-error page unreachable by
        // construction: there is no origin the app would ever navigate to that
        // can fail because the internet is down.
        for remote in [
            "https://example.com/",
            "http://example.com/",
            "http://127.0.0.1:20431/",
            "file:///C:/Windows/System32/drivers/etc/hosts",
        ] {
            assert!(!main_navigation_allowed(&url(remote)), "{remote} must be refused");
        }
    }

    #[test]
    fn a_host_that_merely_looks_local_is_still_refused() {
        // The app's own origin only. A look-alike host must not slip through,
        // because a navigation to it is exactly the kind of load that ends on
        // the browser's error page.
        for lookalike in [
            "tauri://evil.example/_shell.html",
            "http://tauri.localhost.evil.example/",
            "tauri://127.0.0.1/",
        ] {
            assert!(!main_navigation_allowed(&url(lookalike)), "{lookalike}");
        }
    }

    #[test]
    fn in_page_schemes_are_not_treated_as_navigations_away() {
        // Print previews and blob exports render through these; blocking them
        // would break document archiving. The host rule still applies — a
        // scheme allowance is not a blank cheque for any host.
        for target in ["blob:t", "data:,", "about:blank", "http://asset.localhost/x"] {
            assert!(main_navigation_allowed(&url(target)), "{target}");
        }
    }
}

#[cfg(test)]
mod save_backup_tests {
    use super::copy_verified;
    use sha2::{Digest, Sha256};

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("motard-save-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_matching_copy_is_kept_and_reported() {
        let d = dir("ok");
        let src = d.join("b.zip");
        std::fs::write(&src, b"verified backup bytes").unwrap();
        let sha = format!("{:x}", Sha256::digest(b"verified backup bytes"));
        let out = copy_verified(&src, &d.join("saved.zip"), 21, &sha).unwrap();
        assert_eq!(out.size_bytes, 21);
        assert_eq!(out.sha256, sha);
        assert_eq!(std::fs::read(d.join("saved.zip")).unwrap(), b"verified backup bytes");
        assert!(!d.join("saved.zip.partial").exists());
    }

    #[test]
    fn a_mismatch_leaves_no_file_behind() {
        let d = dir("bad");
        let src = d.join("b.zip");
        std::fs::write(&src, b"bytes").unwrap();
        let err = copy_verified(&src, &d.join("saved.zip"), 5, &"0".repeat(64)).unwrap_err();
        assert!(err.contains("لا يطابق"), "{err}");
        assert!(!d.join("saved.zip").exists());
        assert!(!d.join("saved.zip.partial").exists());
    }
}
