#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use motard_fabrics_erp::runtime::{
    boot_desktop_stack_with_progress, no_window_command, shutdown, BootConfig, DesktopStack,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

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
    // Step 0 (Plan §2 — License ≠ Company ≠ Installation ≠ User): refuse to
    // boot unless this machine+user can decrypt the device-binding blob. A
    // copied/tampered install (different Windows user or PC) cannot decrypt
    // it and must NOT start the bundled stack. Fresh installs mint a new
    // installation identity here; company/user setup happens later in the ERP.
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
            get_app_version,
            check_desktop_update,
            install_desktop_update,
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

    // D4-3: boot the self-contained stack (PostgreSQL + Node backend) BEFORE the
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
    let shared: Arc<Mutex<Option<DesktopStack>>> = Arc::new(Mutex::new(None));
    let handle = app.handle().clone();
    let shared_for_boot = Arc::clone(&shared);
    std::thread::spawn(move || {
        let report = |stage: &str| {
            if let Some(splash) = handle.get_webview_window("splash") {
                if let Ok(arg) = serde_json::to_string(stage) {
                    let _ = splash.eval(format!("window.setStage && window.setStage({})", arg));
                }
            }
        };
        match boot_desktop_stack_with_progress(&cfg, &report) {
            Ok(stack) => {
                // The server picked its own port, so the window is created NOW, pointing at it. It starts
                // hidden and is shown (and the splash closed) only when the page has really loaded — the user
                // never sees a blank window.
                let url = stack.app_url();
                *shared_for_boot.lock().unwrap() = Some(stack);
                let for_main = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let parsed: tauri::Url = match url.parse() {
                        Ok(u) => u,
                        Err(e) => {
                            eprintln!("FATAL: bad application url {url}: {e}");
                            std::process::exit(3);
                        }
                    };
                    let built = tauri::WebviewWindowBuilder::new(
                        &for_main,
                        "main",
                        tauri::WebviewUrl::External(parsed),
                    )
                    .title("Motard Fabrics Group ERP")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(1024.0, 768.0)
                    .center()
                    .visible(false)
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            let _ = window.show();
                            let _ = window.set_focus();
                            if let Some(splash) = window.app_handle().get_webview_window("splash") {
                                let _ = splash.close();
                            }
                        }
                    })
                    .build();
                    if let Err(e) = built {
                        eprintln!("FATAL: could not create the main window: {e}");
                        motard_fabrics_erp::runtime::show_fatal_dialog(
                            "خطأ في فتح النافذة — Motard ERP",
                            &format!("تعذّر إنشاء نافذة البرنامج.\n\nالخطأ: {e}"),
                        );
                        std::process::exit(3);
                    }
                });
            }
            Err(e) => {
                eprintln!("FATAL: desktop stack failed to boot: {}", e);
                std::process::exit(3);
            }
        }
    });

    let shared_for_exit = Arc::clone(&shared);
    let _ = app.run(move |_app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(mut s) = shared_for_exit.lock().unwrap().take() {
                eprintln!("[desktop-runtime] ExitRequested — shutting down stack");
                shutdown(&mut s);
            }
            // Closing the last window does not by itself terminate this
            // process (verified live 2026-09-04: postgres/node shut down
            // correctly and the window closed, but the Rust process lingered
            // indefinitely afterward — an invisible resident zombie with no
            // window and no taskbar entry). Force a real process exit once
            // the stack is down.
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
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("لا يوجد تحديث متاح حالياً".into());
    };
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

/// Queue a factory reset: next boot deletes pgdata + db-meta.json + hub session.
/// Does not wipe device-binding.dat or secrets.dat. MSI uninstall still preserves
/// AppData unless MOTARD_WIPEDATA=1.
#[tauri::command]
fn request_factory_reset() -> Result<(), String> {
    let root = motard_fabrics_erp::app_data_dir()?;
    motard_fabrics_erp::runtime::request_factory_reset(&root).map_err(|e| e.to_string())
}
