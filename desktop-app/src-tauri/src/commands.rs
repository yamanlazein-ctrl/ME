//! IPC commands. Names and shapes match `src/infrastructure/tauri-bridge.ts` and `src/lib/drive-archive.ts`.

use crate::boot::{self, BootStatus, Shared};
use crate::{fsutil, paths, pipe, state};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

type Sh<'a> = State<'a, Arc<Shared>>;

#[derive(Deserialize)]
pub struct ApiReq {
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    error: Option<String>,
    elapsed_us: u128,
}

#[tauri::command]
pub async fn api(sh: Sh<'_>, req: ApiReq) -> Result<ApiResp, String> {
    let t = Instant::now();
    let fail = |e: String| ApiResp { status: 0, headers: vec![], body: String::new(), error: Some(e), elapsed_us: t.elapsed().as_micros() };
    if !req.path.starts_with("/api/") {
        return Ok(fail("PATH_NOT_ALLOWED".into()));
    }
    let Some(pipe_name) = sh.pipe() else { return Ok(fail("BACKEND_NOT_READY".into())) };
    // The runtime token is the shell's alone; a page can never present it.
    let headers: Vec<(String, String)> = req
        .headers
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("x-motard-runtime-token"))
        .collect();
    let body = req.body.unwrap_or_default();
    // Backups and restores of a large company take minutes.
    match pipe::request(&pipe_name, &req.method, &req.path, &headers, body.as_bytes(), Duration::from_secs(600)).await {
        Ok(r) => Ok(ApiResp {
            status: r.status,
            headers: r.headers,
            body: String::from_utf8_lossy(&r.body).into_owned(),
            error: None,
            elapsed_us: t.elapsed().as_micros(),
        }),
        Err(e) => Ok(fail(e)),
    }
}

#[tauri::command]
pub fn get_app_version() -> &'static str {
    boot::APP_VERSION
}

#[tauri::command]
pub fn boot_status(sh: Sh<'_>) -> BootStatus {
    sh.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn boot_action(app: AppHandle, sh: Sh<'_>, name: String, confirm: Option<String>) -> Result<String, String> {
    boot::action(&app, &sh, &name, confirm.as_deref())
}

#[tauri::command]
pub fn get_data_root(sh: Sh<'_>) -> Value {
    let p = &sh.paths;
    let install = state::read_install(p).ok().flatten();
    let meta = state::read_db_meta(p);
    let m = |k: &str| meta.as_ref().and_then(|v| v.get(k)).cloned().unwrap_or(Value::Null);
    json!({
        "profile": paths::profile(),
        "dataRoot": p.root.display().to_string(),
        "databasePath": p.db.display().to_string(),
        "dataId": install.as_ref().map(|i| i.data_id.clone()).filter(|s| !s.is_empty()).map(Value::from).unwrap_or(m("data_id")),
        "tenantId": install.as_ref().and_then(|i| i.tenant_id.clone()).map(Value::from).unwrap_or(m("tenant_id")),
        "companyName": m("company_name"),
        "schemaJournalIdx": m("schema_journal_idx"),
        "pipe": sh.pipe().unwrap_or_default(),
    })
}

#[tauri::command]
pub fn get_fingerprint() -> Value {
    use sha2::{Digest, Sha256};
    let guid = machine_guid().unwrap_or_default();
    json!({
        "hash": fsutil::hex(&Sha256::digest(format!("motard-erp:{guid}").as_bytes())),
        "hostname": std::env::var("COMPUTERNAME").unwrap_or_default(),
        "os": "windows",
    })
}

fn machine_guid() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY};
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Cryptography"),
            w!("MachineGuid"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut len),
        )
    };
    if rc.is_err() {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..n]))
}

// ── Desktop document archive (printable HTML under Desktop\<company>\) ───────────────────────────

const DOC_FOLDERS: &[(&str, &str)] = &[
    ("sale", "فواتير المبيع"),
    ("entry", "فواتير الإدخال"),
    ("print_send", "إرساليات الطباعة"),
    ("print_receive", "استلامات الطباعة"),
    ("statement", "كشوف الحسابات"),
];

fn safe_name(s: &str, fallback: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let t = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if t.is_empty() || t.chars().all(|c| c == '.') { fallback.into() } else { t.chars().take(80).collect() }
}

fn archive_root(app: &AppHandle, company: Option<&str>) -> Result<PathBuf, String> {
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    Ok(desktop.join(safe_name(company.unwrap_or(""), "Motard ERP")))
}

#[tauri::command]
pub fn ensure_document_folders(app: AppHandle, company_name: Option<String>) -> Result<String, String> {
    let root = archive_root(&app, company_name.as_deref())?;
    for (_, folder) in DOC_FOLDERS {
        std::fs::create_dir_all(root.join(folder)).map_err(|e| e.to_string())?;
    }
    Ok(root.display().to_string())
}

#[tauri::command]
pub fn archive_document_pdf(
    app: AppHandle,
    doc_type: String,
    file_stem: String,
    html: String,
    company_name: Option<String>,
) -> Result<Value, String> {
    let folder = DOC_FOLDERS.iter().find(|(k, _)| *k == doc_type).ok_or("نوع مستند غير معروف")?.1;
    let dir = archive_root(&app, company_name.as_deref())?.join(folder);
    let file = dir.join(format!("{}.html", safe_name(&file_stem, "document")));
    fsutil::atomic_write(&file, html.as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({ "path": file.display().to_string(), "format": "html" }))
}

// ── Factory reset ────────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn request_factory_reset(sh: Sh<'_>) -> Result<(), String> {
    fsutil::atomic_write(&sh.paths.reset_request, fsutil::stamp().as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_factory_reset_now(app: AppHandle, sh: Sh<'_>) -> Result<(), String> {
    boot::factory_reset_now(&app, &sh)
}

// ── Backup files (the shell owns file I/O; the IPC body is text only) ───────────────────────────

fn file_info(path: &Path) -> Result<Value, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let sha = fsutil::sha256_file(path).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path.display().to_string(), "sizeBytes": size, "sha256": sha }))
}

#[tauri::command]
pub async fn save_backup_file(
    sh: Sh<'_>,
    source_path: String,
    expected_sha256: String,
    expected_size: u64,
    suggested_name: String,
) -> Result<Option<Value>, String> {
    let backups = std::fs::canonicalize(&sh.paths.backups).map_err(|e| e.to_string())?;
    let src = std::fs::canonicalize(&source_path).map_err(|_| "ملف النسخة غير موجود".to_string())?;
    if !src.starts_with(&backups) {
        return Err("مصدر النسخة خارج مجلد النسخ الاحتياطية".into());
    }
    let Some(dst) = rfd::AsyncFileDialog::new()
        .set_title("حفظ النسخة الاحتياطية")
        .set_file_name(safe_name(&suggested_name, "motard-backup.zip"))
        .add_filter("نسخة موتارد", &["zip"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let dst = dst.path().to_path_buf();
    let sha = fsutil::copy_verified(&src, &dst).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&dst).map_err(|e| e.to_string())?.len();
    if !sha.eq_ignore_ascii_case(&expected_sha256) || size != expected_size {
        let _ = std::fs::remove_file(&dst);
        return Err("النسخة المحفوظة لا تطابق النسخة الأصلية — لم تُحفظ".into());
    }
    file_info(&dst).map(Some)
}

#[tauri::command]
pub async fn pick_backup_file() -> Result<Option<Value>, String> {
    let Some(f) = rfd::AsyncFileDialog::new()
        .set_title("اختر ملف النسخة الاحتياطية")
        .add_filter("نسخة موتارد", &["zip"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    file_info(f.path()).map(Some)
}

// ── Not in v3.0 (ADR-001 "Updates", "Not in v3.0") ───────────────────────────────────────────────

#[tauri::command]
pub fn check_desktop_update() -> Value {
    json!({ "available": false, "version": null, "body": "التحديث يتم بتشغيل برنامج التثبيت الأحدث؛ بياناتك تبقى كما هي.", "date": null })
}

#[tauri::command]
pub fn install_desktop_update() -> Result<(), String> {
    Err("لا يوجد تحديث عبر الإنترنت في هذا الإصدار. شغّل برنامج التثبيت الأحدث؛ بياناتك تبقى كما هي.".into())
}

const DRIVE_NA: &str = "ربط Google Drive غير متاح في هذا الإصدار. النسخ المحلية ومجلد المستندات تعمل.";

#[tauri::command]
pub fn google_status_cmd() -> Value {
    json!({ "connected": false, "configured": false, "email": null, "scopes": "" })
}

#[tauri::command]
pub fn google_configure_cmd(client_id: Option<String>) -> Result<Value, String> {
    let _ = client_id;
    Err(DRIVE_NA.into())
}

#[tauri::command]
pub fn google_connect_start_cmd() -> Result<Value, String> {
    Err(DRIVE_NA.into())
}

#[tauri::command]
pub fn google_connect_finish_cmd() -> Result<Value, String> {
    Err(DRIVE_NA.into())
}

#[tauri::command]
pub fn google_disconnect_cmd() -> Result<Value, String> {
    Err(DRIVE_NA.into())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn archive_names_cannot_escape_their_folder() {
        assert_eq!(safe_name(r"..\..\Windows\x", "d"), ".._.._Windows_x");
        assert_eq!(safe_name("..", "d"), "d");
        assert_eq!(safe_name("فاتورة 12/2026", "d"), "فاتورة 12_2026");
        assert_eq!(safe_name("  ", "d"), "d");
    }
}
