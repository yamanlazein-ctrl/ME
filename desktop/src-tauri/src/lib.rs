// Library crate for motard-fabrics-erp.
//
// Layer map (Plan §1 — hard separation, one-directional dependencies):
//   runtime          process lifecycle, DB bootstrap, ports, recovery
//   identity         installation identity (License ≠ Company ≠ Installation ≠ User)
//   device_binding   DPAPI-bound install blob (leaf primitive for identity)
//   secret_store     DPAPI-encrypted local secrets (leaf primitive for runtime)
//   db_meta          pgdata identity stamp (leaf primitive for runtime)
//   hidden_process   console-less child spawning (leaf primitive for runtime)
//   document_archive desktop document folders + PDF drop (Tauri commands only)
//
// Nothing here implements ERP business logic: invoices, inventory, ledger,
// licensing rules, and sync all live in the shared backend/frontend and are
// reused unchanged by the desktop shell.
pub mod db_meta;
pub mod device_binding;
pub mod document_archive;
pub mod hidden_process;
pub mod identity;
pub mod runtime;
pub mod secret_store;

// ── Shared per-user app-data root ────────────────────────────────────────────
// Used by secret_store, device_binding, and runtime so the three
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
