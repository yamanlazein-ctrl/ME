// Every IPC command the shell registers (`generate_handler!` in src/main.rs) is declared here, so
// each one gets an `allow-<command>` permission, and the window's capability
// (capabilities/default.json) grants exactly these. A command missing from either list is refused
// by Tauri's ACL at runtime; `scripts/ipc-acl.test.mjs` keeps the three lists and every `invoke()`
// in the UI and the boot page in step.
const APP_COMMANDS: &[&str] = &[
    "api",
    "get_app_version",
    "boot_status",
    "boot_action",
    "get_data_root",
    "get_fingerprint",
    "ensure_document_folders",
    "archive_document_pdf",
    "archive_write_pdf",
    "request_factory_reset",
    "apply_factory_reset_now",
    "save_backup_file",
    "pick_backup_file",
    "google_status_cmd",
    "google_configure_cmd",
    "google_connect_start_cmd",
    "google_connect_finish_cmd",
    "google_disconnect_cmd",
    "save_csv_file",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
