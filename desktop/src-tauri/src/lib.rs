// Library crate for motard-fabrics-erp.
//
// Layer map (Plan §1 — hard separation, one-directional dependencies):
//   runtime          process lifecycle, DB bootstrap, ports, recovery
//   identity         installation identity (License ≠ Company ≠ Installation ≠ User)
//   device_binding   DPAPI-bound install blob (leaf primitive for identity)
//   secret_store     DPAPI-encrypted local secrets (leaf primitive for runtime)
//   db_meta          data-root identity + startup decision (leaf primitive for runtime)
//   hidden_process   console-less child spawning (leaf primitive for runtime)
//   document_archive desktop document folders + PDF drop (Tauri commands only)
//
// Nothing here implements ERP business logic: invoices, inventory, ledger,
// licensing rules, and sync all live in the shared backend/frontend and are
// reused unchanged by the desktop shell.
pub mod data_lock;
pub mod db_meta;
pub mod device_binding;
pub mod document_archive;
pub mod fingerprint;
pub mod hidden_process;
pub mod identity;
pub mod runtime;
pub mod secret_store;
#[cfg(windows)]
pub mod session_end;

/// Which per-user data root THIS binary uses. A `dev-fast`/debug build and an
/// installed release build are two different products as far as data is
/// concerned: separate database, separate secrets, separate device binding,
/// separate named pipe. Running the wrong executable must never open the
/// customer's database, and vice versa.
pub const DATA_ROOT_DIR_NAME: &str = if cfg!(debug_assertions) {
    "motard-erp-dev"
} else {
    "motard-erp"
};

/// "release" | "dev" — surfaced to the operator so the UI can say WHICH
/// database is open instead of leaving a dev run indistinguishable from the
/// installed product.
pub const BUILD_PROFILE: &str = if cfg!(debug_assertions) { "dev" } else { "release" };

// ── Shared per-user app-data root ────────────────────────────────────────────
// Used by secret_store, device_binding, and runtime so the three
// modules can never disagree on where this lives. Returns Err instead of
// panicking so callers can show a dialog instead of crashing silently.
pub fn app_data_dir() -> Result<std::path::PathBuf, String> {
    let mut dir = dirs_sys::known_folder_local_app_data().ok_or_else(|| {
        "تعذّر تحديد مجلد AppData\\Local لهذا المستخدم (known_folder_local_app_data فشلت)"
            .to_string()
    })?;
    dir.push(DATA_ROOT_DIR_NAME);
    Ok(dir)
}

/// Everything the operator needs to answer "which database am I looking at?" (ID-7, T087):
/// `{ profile, dataRoot, databasePath, dataId, tenantId, companyName, schemaJournalIdx, pipe }`.
/// Identity fields come from the db-meta.json sidecar; the company name is read READ-ONLY from the
/// database. Missing values are null (e.g. before the first launch created the database).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    pub profile: &'static str,
    pub data_root: String,
    /// The SQLite database file (`<root>\data\motard.db`).
    pub database_path: String,
    pub data_id: Option<String>,
    pub tenant_id: Option<String>,
    pub company_name: Option<String>,
    pub schema_journal_idx: Option<i32>,
    pub pipe: &'static str,
}

fn company_name(database: &std::path::Path, tenant_id: Option<&str>) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let tenant = tenant_id?;
    // the onboarding's company profile name, else the tenant name
    conn.query_row("SELECT name FROM company_profiles WHERE tenant_id = ?1 LIMIT 1", [tenant], |r| r.get::<_, String>(0))
        .or_else(|_| conn.query_row("SELECT name FROM tenants WHERE id = ?1", [tenant], |r| r.get::<_, String>(0)))
        .ok()
}

pub fn data_root_info() -> Result<DataRootInfo, String> {
    let root = app_data_dir()?;
    let database = crate::db_meta::database_path(&root);
    let meta = crate::db_meta::read_meta(&root).ok().flatten();
    let tenant_id = meta.as_ref().and_then(|m| m.tenant_id.clone());
    Ok(DataRootInfo {
        profile: BUILD_PROFILE,
        data_root: root.display().to_string(),
        company_name: if database.exists() { company_name(&database, tenant_id.as_deref()) } else { None },
        database_path: database.display().to_string(),
        data_id: meta.as_ref().and_then(|m| m.data_id.clone()),
        tenant_id,
        schema_journal_idx: meta.as_ref().map(|m| m.schema_journal_idx),
        pipe: runtime::PIPE_PATH,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The isolation invariant: a debug build must never be able to name the
    /// release data root (or the release pipe). This is the guard that keeps a
    /// `dev-fast` run from opening a customer's database.
    #[test]
    fn debug_builds_never_share_the_release_data_root() {
        if cfg!(debug_assertions) {
            assert_eq!(DATA_ROOT_DIR_NAME, "motard-erp-dev");
            assert_eq!(BUILD_PROFILE, "dev");
        } else {
            assert_eq!(DATA_ROOT_DIR_NAME, "motard-erp");
            assert_eq!(BUILD_PROFILE, "release");
        }
    }

    /// The pipe and the data root are chosen by the same profile switch; a
    /// mismatch would mean one process serves the API over a pipe while
    /// another process owns a different cluster.
    #[test]
    fn pipe_and_data_root_agree_on_the_profile() {
        assert!(
            runtime::PIPE_PATH.ends_with(DATA_ROOT_DIR_NAME),
            "pipe {} does not match data root {DATA_ROOT_DIR_NAME}",
            runtime::PIPE_PATH
        );
    }

    #[test]
    fn data_root_info_reports_the_sqlite_database_path() {
        let info = data_root_info().expect("data root must resolve");
        assert!(info.database_path.ends_with("motard.db"));
        assert!(info.database_path.contains(DATA_ROOT_DIR_NAME));
        assert!(info.data_root.contains(DATA_ROOT_DIR_NAME));
    }
}
