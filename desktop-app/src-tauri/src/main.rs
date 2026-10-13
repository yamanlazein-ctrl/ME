// No console window in the shipped build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod boot;
mod commands;
mod fsutil;
mod keys;
mod logger;
mod paths;
mod pipe;
mod state;

use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn main() {
    let paths = match paths::Paths::resolve() {
        Ok(p) => p,
        Err(e) => {
            rfd::MessageDialog::new().set_title("Motard ERP").set_description(e).show();
            return;
        }
    };
    logger::init(paths.logs.clone());
    logger::info(&format!("shell {} starting, data root {}", boot::APP_VERSION, paths.root.display()));

    // Held for the life of the process: no second shell (another build, a copied EXE) opens this data.
    let lock = boot::lock_data_root(&paths);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::api,
            commands::get_app_version,
            commands::boot_status,
            commands::boot_action,
            commands::get_data_root,
            commands::get_fingerprint,
            commands::ensure_document_folders,
            commands::archive_document_pdf,
            commands::request_factory_reset,
            commands::apply_factory_reset_now,
            commands::save_backup_file,
            commands::pick_backup_file,
            commands::check_desktop_update,
            commands::install_desktop_update,
            commands::google_status_cmd,
            commands::google_configure_cmd,
            commands::google_connect_start_cmd,
            commands::google_connect_finish_cmd,
            commands::google_disconnect_cmd,
        ])
        .setup(move |app| {
            let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let shared = boot::Shared::new(paths, resources);
            app.manage(shared.clone());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("boot.html".into()))
                .title("موتارد للأقمشة — Motard ERP")
                .inner_size(1366.0, 820.0)
                .min_inner_size(1024.0, 640.0)
                .maximized(true)
                .build()?;
            match lock {
                Ok(file) => {
                    // Leaked on purpose: the OS releases the lock when the process ends.
                    std::mem::forget(file);
                    boot::start(app.handle().clone(), shared);
                }
                Err(e) => {
                    let mut st = shared.status.lock().unwrap();
                    st.phase = "recovery".into();
                    st.code = Some("LOCKED".into());
                    st.detail = Some(format!("بيانات البرنامج مفتوحة من نسخة أخرى ({e})"));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let shared = window.state::<std::sync::Arc<boot::Shared>>().inner().clone();
                logger::info("window closing: stopping backend");
                boot::shutdown(&shared);
            }
        })
        .build(tauri::generate_context!())
        .expect("tauri runtime failed")
        .run(|app, event| {
            // Any other way out (tray-less exit, Windows logoff/restart): stop cleanly if still running.
            if let tauri::RunEvent::Exit = event {
                if let Some(shared) = app.try_state::<std::sync::Arc<boot::Shared>>() {
                    boot::shutdown(&shared);
                }
            }
        });
}
