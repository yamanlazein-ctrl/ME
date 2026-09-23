// The app's own commands (src/main.rs `generate_handler!`) are registered here as an app manifest so each one
// gets an `allow-<command>` permission that a capability can grant. Without a capability the webview is denied
// every call ("Command … not allowed by ACL"), which silently breaks activation, hub linking, factory reset,
// document archiving and updates in the shipped app.
const APP_COMMANDS: &[&str] = &[
    "get_fingerprint",
    "validate_license",
    "ensure_document_folders",
    "archive_document_pdf",
    "get_hub_url",
    "set_hub_url",
    "request_factory_reset",
    "get_app_version",
    "check_desktop_update",
    "install_desktop_update",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
