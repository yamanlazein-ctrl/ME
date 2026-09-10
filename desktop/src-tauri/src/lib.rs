// Library crate for motard-fabrics-erp. Shared modules (used by both the Tauri
// `main` binary and standalone test/diagnostic binaries like `d3_probe`) live
// here so each bin depends on the library instead of re-declaring `#[path]`
// module hacks. D4-3's main.rs sidecar logic should pull from this crate too.
pub mod desktop_runtime;
pub mod device_binding;
pub mod document_archive;
pub mod hidden_process;
pub mod secret_store;

// ── Shared per-user app-data root ────────────────────────────────────────────
// Used by secret_store, device_binding, and desktop_runtime so the three
// modules can never disagree on where this lives. Returns Err instead of
// panicking so callers can show a dialog instead of crashing silently.
pub fn app_data_dir() -> Result<std::path::PathBuf, String> {
    let mut dir = dirs_sys::known_folder_local_app_data().ok_or_else(|| {
        "تعذّر تحديد مجلد AppData\\Local لهذا المستخدم (known_folder_local_app_data فشلت)"
            .to_string()
    })?;
    dir.push("motard-erp");
    Ok(dir)
}
