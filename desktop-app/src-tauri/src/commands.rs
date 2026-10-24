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

/// Phase 2: the fixed archive categories. These MUST equal `ARCHIVE_CATEGORIES` in
/// `packages/shared/src/archivePaths.ts` (the same names on Drive); a test below checks they match
/// — both directions, key AND label. Keys are the category keys; the document kinds map onto them
/// (see `category_for_doc_type`).
const ARCHIVE_CATEGORIES: &[(&str, &str)] = &[
    ("entry_invoices", "فواتير الدخول"),
    ("sale_invoices", "فواتير الخروج"),
    ("returns", "المرتجعات"),
    ("print_jobs", "إرساليات واستلامات الطباعة"),
    ("statements", "كشوف الحسابات"),
    ("cashbox", "الصندوق والتقارير"),
    ("system_backups", "نسخ النظام الاحتياطية"),
];

/// The archive category a printed document belongs to. Unknown document types are refused, never
/// filed under a wrong category.
fn category_for_doc_type(doc_type: &str) -> Option<&'static str> {
    match doc_type {
        "entry" => Some("entry_invoices"),
        "sale" => Some("sale_invoices"),
        "return_sale" | "return_entry" => Some("returns"),
        // A print job (fabric sent to / received back from the printing factory) is a real archived
        // document that moves stock — it is neither an invoice nor a statement. The Phase 2 category
        // set dropped these two types, so the shell refused them as "unknown document type" and
        // print_send / print_receive documents stopped being archived at all.
        "print_send" | "print_receive" => Some("print_jobs"),
        "statement" => Some("statements"),
        "cashbox" => Some("cashbox"),
        _ => None,
    }
}

/// `YYYY-MM — <Arabic month>`, the same format as the shared `monthFolder`.
fn month_folder_name(year: i32, month: u32) -> String {
    const MONTHS: [&str; 12] = [
        "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر",
        "نوفمبر", "ديسمبر",
    ];
    format!("{year:04}-{month:02} — {}", MONTHS[(month - 1) as usize])
}

fn safe_name(s: &str, fallback: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let t = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if t.is_empty() || t.chars().all(|c| c == '.') { fallback.into() } else { t.chars().take(80).collect() }
}

/**
 * The shared naming engine's `sanitizeSegment` (packages/shared/src/archivePaths.ts), mirrored.
 *
 * The local archive and the Drive archive MUST have the same layout, so the local root is named by
 * the same rules as the Drive one. The test vectors below are the SAME table as the one in
 * `packages/shared/src/archivePaths.test.ts`: if either side drifts, one of the two fails.
 */
fn shared_sanitize_segment(raw: &str, max_len: usize) -> String {
    let mut replaced = String::new();
    for c in raw.chars() {
        // The shared ILLEGAL set: \ / : * ? " < > | and the C0/C1 control characters.
        if c.is_control() || r#"/\:?*|<>""#.contains(c) {
            replaced.push(' ');
        } else {
            replaced.push(c);
        }
    }
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "بدون-اسم".to_string();
    }
    if collapsed.chars().count() > max_len {
        collapsed.chars().take(max_len).collect::<String>().trim_end().to_string()
    } else {
        collapsed
    }
}

/// The shared `companyFolderName`: `<company> - أرشيف النظام`.
fn shared_company_folder_name(company: Option<&str>) -> String {
    let name = shared_sanitize_segment(company.unwrap_or(""), 100);
    let base = if name == "بدون-اسم" { "Motard ERP".to_string() } else { name };
    format!("{base} - أرشيف النظام")
}

fn archive_root(app: &AppHandle, company: Option<&str>) -> Result<PathBuf, String> {
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let root = desktop.join(shared_company_folder_name(company));
    if let Some(name) = company {
        migrate_legacy_archive_root(&desktop.join(safe_name(name, "Motard ERP")), &root);
    }
    Ok(root)
}

/// The folders 3.0.6 created under `Desktop\<company>\` — the whole content of a legacy archive root.
const LEGACY_DOC_FOLDERS: &[&str] =
    &["فواتير المبيع", "فواتير الإدخال", "إرساليات الطباعة", "استلامات الطباعة", "كشوف الحسابات"];

/// Migration: before the shared naming engine the local root was plain `Desktop\<company>`. That
/// folder is renamed in place, so an installation keeps ONE archive tree — but ONLY when it holds
/// nothing except the archive's own folders. A folder named after the company is exactly what a
/// business owner keeps on the Desktop for their own files; renaming it would carry those files away.
fn migrate_legacy_archive_root(legacy: &Path, root: &Path) {
    if legacy == root || root.exists() || !is_legacy_archive_root(legacy) {
        return;
    }
    let _ = std::fs::rename(legacy, root);
}

fn is_legacy_archive_root(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let mut any = false;
    for entry in entries {
        let Ok(entry) = entry else { return false };
        let is_known = entry.file_type().is_ok_and(|t| t.is_dir())
            && entry.file_name().to_str().is_some_and(|n| LEGACY_DOC_FOLDERS.contains(&n));
        if !is_known {
            return false;
        }
        any = true;
    }
    any
}

/// `<root>\YYYY\YYYY-MM — <month>\<category>` for one period.
fn period_category_dir(root: &std::path::Path, period: (i32, u32), category_key: &str) -> Result<PathBuf, String> {
    let label = ARCHIVE_CATEGORIES
        .iter()
        .find(|(k, _)| *k == category_key)
        .ok_or("فئة أرشيف غير معروفة")?
        .1;
    Ok(root
        .join(format!("{:04}", period.0))
        .join(month_folder_name(period.0, period.1))
        .join(label))
}

/// The period (year, month) to file under: the caller's `YYYY-MM` when given and valid, otherwise the
/// current local month. Documents are filed by their business month, so the caller passes it.
fn resolve_period(period: Option<&str>) -> Result<(i32, u32), String> {
    if let Some(p) = period {
        let mut it = p.split('-');
        let (y, m) = (it.next(), it.next());
        if let (Some(y), Some(m), None) = (y, m, it.next()) {
            if let (Ok(y), Ok(m)) = (y.parse::<i32>(), m.parse::<u32>()) {
                if (1..=12).contains(&m) && (1900..=2999).contains(&y) {
                    return Ok((y, m));
                }
            }
        }
        return Err("فترة الأرشيف يجب أن تكون بصيغة YYYY-MM".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Calendar month from a Unix timestamp (civil-from-days), UTC: the archive is filed by the
    // business month, and the caller passes an explicit period for any document that is not "now".
    let days = now.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mp = (5 * (doe - (365 * yoe + yoe / 4 - yoe / 100)) + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + if month <= 2 { 1 } else { 0 }) as i32;
    Ok((year, month))
}

#[tauri::command]
pub fn ensure_document_folders(
    app: AppHandle,
    company_name: Option<String>,
    period: Option<String>,
) -> Result<String, String> {
    let root = archive_root(&app, company_name.as_deref())?;
    let period = resolve_period(period.as_deref())?;
    for (key, _) in ARCHIVE_CATEGORIES {
        std::fs::create_dir_all(period_category_dir(&root, period, key)?).map_err(|e| e.to_string())?;
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
    period: Option<String>,
) -> Result<Value, String> {
    let category = category_for_doc_type(&doc_type).ok_or("نوع مستند غير معروف")?;
    let period = resolve_period(period.as_deref())?;
    let dir = period_category_dir(&archive_root(&app, company_name.as_deref())?, period, category)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.html", safe_name(&file_stem, "document")));
    fsutil::atomic_write(&file, html.as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({ "path": file.display().to_string(), "format": "html" }))
}

// ── Phase 3: background rendering for the Drive archive (pdf_render.rs) ──────────────────────────

/// Render an archive document to a REAL PDF and file it in the local archive tree.
///
/// This is what the print portal calls: the document is rendered by the same WebView2 worker the
/// Drive archive uses, so the local archive holds PDFs, not HTML. The HTML command
/// (`archive_document_pdf`) stays for one release as the fallback.
#[tauri::command]
pub fn archive_write_pdf(
    app: AppHandle,
    doc_type: String,
    file_stem: String,
    html: String,
    company_name: Option<String>,
    period: Option<String>,
    paper: Option<String>,
) -> Result<Value, String> {
    let category = category_for_doc_type(&doc_type).ok_or("نوع مستند غير معروف")?;
    let period = resolve_period(period.as_deref())?;
    let dir = period_category_dir(&archive_root(&app, company_name.as_deref())?, period, category)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = safe_name(&file_stem, "document");
    let file = dir.join(format!("{stem}.pdf"));
    let paper = match paper.as_deref() {
        Some("A5") => crate::pdf_render::Paper::A5,
        _ => crate::pdf_render::Paper::A4,
    };
    // The render happens on its own worker thread: the UI never waits for the browser.
    let rendered = crate::webview2_render::render_pdf(&html, paper.page_size())
        .map_err(|e| format!("فشل التصيير: {e}"))?;
    fsutil::atomic_write(&file, &rendered.bytes).map_err(|e| e.to_string())?;
    let (sha256, size_bytes) = crate::pdf_render::measure(&file)?;
    Ok(json!({
        "path": file.display().to_string(),
        "format": "pdf",
        "sha256": sha256,
        "sizeBytes": size_bytes,
    }))
}

// The Drive archive's renders do not go through IPC: the backend queues them and the shell's
// render loop (`archive_render_loop.rs`) renders and stages them. The backend removes each staged
// file once it is uploaded.

// ── Factory reset ────────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn request_factory_reset(sh: Sh<'_>, confirm: Option<String>) -> Result<(), String> {
    // Reachable without an ERP session (DESK-006): the typed phrase is enforced here, not in the page.
    if confirm.as_deref().map(str::trim) != Some(boot::CONFIRM_FACTORY_RESET) {
        return Err(format!("اكتب «{}» للتأكيد", boot::CONFIRM_FACTORY_RESET));
    }
    fsutil::atomic_write(&sh.paths.reset_request, fsutil::stamp().as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_factory_reset_now(app: AppHandle, sh: Sh<'_>, confirm: Option<String>) -> Result<(), String> {
    boot::factory_reset_now(&app, &sh, confirm.as_deref().unwrap_or(""))
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

/// Desktop-only: save arbitrary text content (e.g. CSV export) to a user-chosen path.
/// Opens a native save dialog, writes the bytes, and returns the saved file info.
#[tauri::command]
pub async fn save_csv_file(
    content: String,
    suggested_name: String,
) -> Result<Option<Value>, String> {
    let Some(dst) = rfd::AsyncFileDialog::new()
        .set_title("حفظ ملف CSV")
        .set_file_name(safe_name(&suggested_name, "motard-export.csv"))
        .add_filter("ملف CSV", &["csv"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let dst = dst.path().to_path_buf();
    std::fs::write(&dst, content.as_bytes()).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&dst).map_err(|e| e.to_string())?.len();
    Ok(Some(json!({ "path": dst.display().to_string(), "sizeBytes": size, "sha256": "" })))
}

// ── Google Drive link (google.rs). The WebView only ever sees the status below. ─────────────────

#[tauri::command]
pub fn google_status_cmd(sh: Sh<'_>) -> Value {
    sh.google.status()
}

#[tauri::command]
pub fn google_configure_cmd(sh: Sh<'_>, client_id: String, client_secret: Option<String>) -> Result<Value, String> {
    sh.google.configure(&client_id, client_secret.as_deref())
}

#[tauri::command]
pub fn google_connect_start_cmd(sh: Sh<'_>) -> Result<Value, String> {
    sh.google.connect_start(&crate::google::Google::open_default)
}

/// Waits (up to 5 min) for the browser's redirect; runs off the async runtime (blocking I/O).
#[tauri::command]
pub async fn google_connect_finish_cmd(sh: Sh<'_>) -> Result<Value, String> {
    let shared = sh.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let status = shared.google.connect_finish(crate::google::CONSENT_TIMEOUT)?;
        boot::push_drive_token(&shared); // uploads can start now, not at the next tick
        Ok(status)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn google_disconnect_cmd(sh: Sh<'_>) -> Result<Value, String> {
    let shared = sh.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let status = shared.google.disconnect()?;
        boot::push_drive_token(&shared); // the backend drops its token now
        Ok(status)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    /// The 3.0.6 archive root is renamed to the new name only when it is the archive's own folder.
    /// A Desktop folder that merely shares the company's name — and holds the owner's own files —
    /// must never be moved.
    #[test]
    fn only_a_pure_legacy_archive_root_is_renamed() {
        let desk = std::env::temp_dir().join(format!("motard-desk-{}", uuid::Uuid::new_v4().simple()));
        // A genuine 3.0.6 archive: only the archive's folders.
        let legacy = desk.join("Alpha");
        let new_root = desk.join("Alpha - أرشيف النظام");
        std::fs::create_dir_all(legacy.join("فواتير المبيع")).unwrap();
        std::fs::create_dir_all(legacy.join("كشوف الحسابات")).unwrap();
        super::migrate_legacy_archive_root(&legacy, &new_root);
        assert!(new_root.join("فواتير المبيع").is_dir(), "the archive moved to the new name");
        assert!(!legacy.exists());

        // The owner's own folder with the company's name: the archive folders plus personal files.
        let own = desk.join("Beta");
        let own_new = desk.join("Beta - أرشيف النظام");
        std::fs::create_dir_all(own.join("فواتير المبيع")).unwrap();
        std::fs::write(own.join("عقد الإيجار.docx"), b"mine").unwrap();
        super::migrate_legacy_archive_root(&own, &own_new);
        assert!(own.join("عقد الإيجار.docx").is_file(), "the owner's folder stays where it is");
        assert!(!own_new.exists());

        // An empty folder is not evidence of an archive either.
        let empty = desk.join("Gamma");
        std::fs::create_dir_all(&empty).unwrap();
        super::migrate_legacy_archive_root(&empty, &desk.join("Gamma - أرشيف النظام"));
        assert!(empty.is_dir());
        let _ = std::fs::remove_dir_all(&desk);
    }

    #[test]
    fn archive_names_cannot_escape_their_folder() {
        assert_eq!(safe_name(r"..\..\Windows\x", "d"), ".._.._Windows_x");
        assert_eq!(safe_name("..", "d"), "d");
        assert_eq!(safe_name("فاتورة 12/2026", "d"), "فاتورة 12_2026");
        assert_eq!(safe_name("  ", "d"), "d");
    }

    /// The six Desktop folder names must equal the shared `ARCHIVE_CATEGORIES` (Drive uses the same).
    /// The TypeScript file is read at test time, so a rename on either side fails this test.
    #[test]
    fn desktop_categories_match_the_shared_archive_categories() {
        let ts = include_str!("../../../packages/shared/src/archivePaths.ts");
        let start = ts.find("export const ARCHIVE_CATEGORIES").expect("shared categories present");
        let block = &ts[start..ts[start..].find("} as const").map(|i| start + i).expect("block end")];
        // Parse the shared `key: "label"` pairs and compare them as PAIRS, in order. The previous
        // check only asserted that each Rust label appeared somewhere in the TypeScript text, so a
        // renamed key with an unchanged label passed, and a key that existed only on one side was
        // invisible. Both directions, keys and labels, are now covered.
        let mut shared: Vec<(String, String)> = Vec::new();
        for line in block.lines() {
            let l = line.trim();
            let Some((key, rest)) = l.split_once(':') else { continue };
            let key = key.trim();
            let rest = rest.trim().trim_end_matches(',');
            let Some(label) = rest.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
                continue;
            };
            if key.is_empty() || key.contains(char::is_whitespace) || key.contains('=') {
                continue;
            }
            shared.push((key.to_string(), label.to_string()));
        }
        assert!(!shared.is_empty(), "parsed the shared ARCHIVE_CATEGORIES block");
        let rust: Vec<(String, String)> = super::ARCHIVE_CATEGORIES
            .iter()
            .map(|(k, l)| (k.to_string(), l.to_string()))
            .collect();
        assert_eq!(
            rust, shared,
            "the shell's archive categories and the shared ones must be the same key+label pairs, in the same order"
        );
        assert_eq!(super::ARCHIVE_CATEGORIES.len(), 7);
    }

    #[test]
    fn the_local_archive_root_uses_the_shared_naming_engine() {
        // The SAME vectors as packages/shared/src/archivePaths.test.ts. The local archive and the
        // Drive archive must have one layout: `<company> - أرشيف النظام / YYYY / YYYY-MM — …`.
        let cases: &[(&str, &str)] = &[
            ("موكتارد", "موكتارد - أرشيف النظام"),
            ("Motard Fabrics", "Motard Fabrics - أرشيف النظام"),
            ("", "Motard ERP - أرشيف النظام"),
            ("  ", "Motard ERP - أرشيف النظام"),
            (r#"a/b\c:d*e?f"g<h>i|j"#, "a b c d e f g h i j - أرشيف النظام"),
            ("مؤسسة  النور", "مؤسسة النور - أرشيف النظام"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                super::shared_company_folder_name(Some(input)),
                *expected,
                "the shared company folder name for {input:?}"
            );
        }
        // No company at all falls back to the product name, exactly as the shared module does.
        assert_eq!(
            super::shared_company_folder_name(None),
            "Motard ERP - أرشيف النظام"
        );
    }

    #[test]
    fn unknown_document_types_are_refused_not_misfiled() {
        assert_eq!(super::category_for_doc_type("sale"), Some("sale_invoices"));
        assert_eq!(super::category_for_doc_type("entry"), Some("entry_invoices"));
        assert_eq!(super::category_for_doc_type("return_sale"), Some("returns"));
        assert_eq!(super::category_for_doc_type("return_entry"), Some("returns"));
        assert_eq!(super::category_for_doc_type("print_send"), Some("print_jobs"));
        assert_eq!(super::category_for_doc_type("print_receive"), Some("print_jobs"));
        assert_eq!(super::category_for_doc_type("statement"), Some("statements"));
        assert_eq!(super::category_for_doc_type("payroll"), None);
    }

    #[test]
    fn every_archive_document_type_the_ui_can_emit_maps_to_a_category() {
        // The Phase 2 rewrite dropped print_send and print_receive from the mapping while the UI
        // kept offering them, so two document classes silently stopped being archived and the
        // shell reported "unknown document type". This test reads the UI's own union, so a type
        // added on the frontend without a shell mapping fails here instead of in the field.
        let bridge = include_str!("../../../src/infrastructure/tauri-bridge.ts");
        let line = bridge
            .lines()
            .find(|l| l.contains("export type ArchiveDocType"))
            .expect("ArchiveDocType is declared");
        let union = line
            .split_once('=')
            .expect("ArchiveDocType has a value")
            .1
            .trim()
            .trim_end_matches(';');
        let mut types: Vec<String> = union
            .split('|')
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        types.sort();
        assert!(!types.is_empty(), "parsed the ArchiveDocType union");
        for t in &types {
            assert!(
                super::category_for_doc_type(t).is_some(),
                "the UI can archive a {t} document but the shell refuses it as an unknown document type"
            );
        }
    }

    #[test]
    fn periods_are_validated_and_month_names_are_arabic() {
        assert_eq!(super::resolve_period(Some("2026-10")).unwrap(), (2026, 10));
        assert!(super::resolve_period(Some("2026-13")).is_err());
        assert!(super::resolve_period(Some("october")).is_err());
        assert!(super::resolve_period(Some("2026-10-05")).is_err());
        assert_eq!(super::month_folder_name(2026, 10), "2026-10 — أكتوبر");
        assert_eq!(super::month_folder_name(2027, 1), "2027-01 — يناير");
    }
}
