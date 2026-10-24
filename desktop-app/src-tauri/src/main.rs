// No console window in the shipped build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The archive schedule lives in the BACKEND (googledrive/archiveSchedule.ts + the 6-hour worker):
// one owner only. A second scheduler in the shell would race the backend's worker, and the
// backend's run guard would silently swallow one of them — the month would then "not archive"
// without any error. (The Rust scheduler that used to live here was never started; it is gone.)
mod archive_render_loop;
mod backend;
mod boot;
mod commands;
mod fsutil;
mod google;
mod keys;
mod logger;
mod paths;
mod pdf_render;
mod pipe;
mod state;
mod webview2_render;

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
            commands::archive_write_pdf,
            commands::request_factory_reset,
            commands::apply_factory_reset_now,
            commands::save_backup_file,
            commands::pick_backup_file,
            commands::google_status_cmd,
            commands::google_configure_cmd,
            commands::google_connect_start_cmd,
            commands::google_connect_finish_cmd,
            commands::google_disconnect_cmd,
            commands::save_csv_file,
        ])
        .setup(move |app| {
            let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let locked = lock.as_ref().err().cloned();
            // The lock lives in `Shared` for the rest of the process (released when it ends).
            let shared = boot::Shared::new(paths, resources, lock.ok());
            app.manage(shared.clone());
            boot::start_drive_token_loop(shared.clone());
            // The archive render loop: the shell pulls the documents the backend wants rendered and
            // posts the rendered files back. This is the channel the PDF engine is reached through.
            archive_render_loop::start_archive_render_loop(shared.clone());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("boot.html".into()))
                .title("موتارد للأقمشة — Motard ERP")
                .inner_size(1366.0, 820.0)
                .min_inner_size(1024.0, 640.0)
                .maximized(true)
                .build()?;
            match locked {
                None => boot::start(app.handle().clone(), shared),
                Some(e) => {
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
