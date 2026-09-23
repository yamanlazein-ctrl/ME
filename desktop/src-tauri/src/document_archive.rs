//! Issue 12 — Desktop document archive folders + PDF drop.
//!
//! On first use, creates:
//!   Desktop/<company name>/{فواتير البيع,فواتير الدخول,إرسال المطبعة,استلام المطبعة,كشوفات الحسابات}
//!
//! The root folder is named after the tenant's actual company (2026-09-22 —
//! previously a fixed brand string regardless of which customer's install
//! this was). Falls back to `FALLBACK_ROOT_FOLDER` when no usable company
//! name is supplied (empty, whitespace-only, or the frontend hasn't loaded
//! settings yet) so archiving never fails just because of that.
//!
//! `archive_document_pdf` writes a PDF into the matching subfolder (newest-first
//! naming via timestamp prefix). Prefers Edge/Chrome headless `--print-to-pdf`
//! for Arabic-capable rendering; falls back to a `.html` sibling if no browser
//! is available so the archive is never silently empty.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const FALLBACK_ROOT_FOLDER: &str = "أقمشة ومنسوجات";

const SUBFOLDERS: &[(&str, &str)] = &[
    ("sale", "فواتير البيع"),
    ("entry", "فواتير الدخول"),
    ("print_send", "إرسال المطبعة"),
    ("print_receive", "استلام المطبعة"),
    ("statement", "كشوفات الحسابات"),
];

fn desktop_dir() -> Result<PathBuf, String> {
    dirs_sys::known_folder_desktop().ok_or_else(|| {
        "تعذّر تحديد مجلد سطح المكتب (known_folder_desktop فشلت)".to_string()
    })
}

/// The Desktop root folder name: the tenant's real company name when one was
/// supplied (sanitized for NTFS), else the fixed fallback brand string.
fn resolve_root_name(company_name: Option<&str>) -> String {
    match company_name.map(sanitize_stem) {
        Some(name) if !name.is_empty() => name,
        _ => FALLBACK_ROOT_FOLDER.to_string(),
    }
}

fn subfolder_name(doc_type: &str) -> Result<&'static str, String> {
    SUBFOLDERS
        .iter()
        .find(|(k, _)| *k == doc_type)
        .map(|(_, name)| *name)
        .ok_or_else(|| format!("نوع مستند غير معروف للأرشفة: {doc_type}"))
}

/// Create the project root + four document-type subfolders on the Desktop.
/// Idempotent — safe to call on every launch.
pub fn ensure_folders_at(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| format!("فشل إنشاء مجلد الأرشيف: {e}"))?;
    for (_, name) in SUBFOLDERS {
        fs::create_dir_all(root.join(name))
            .map_err(|e| format!("فشل إنشاء المجلد الفرعي {name}: {e}"))?;
    }
    Ok(root.to_path_buf())
}

pub fn ensure_document_folders(company_name: Option<String>) -> Result<String, String> {
    let root = desktop_dir()?.join(resolve_root_name(company_name.as_deref()));
    let path = ensure_folders_at(&root)?;
    Ok(path.to_string_lossy().into_owned())
}

fn sanitize_stem(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(120)
        .collect()
}

fn find_chromium() -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    CANDIDATES.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn html_to_pdf(html_path: &Path, pdf_path: &Path) -> Result<(), String> {
    let browser = find_chromium().ok_or_else(|| {
        "لم يُعثر على Edge/Chrome لتحويل HTML→PDF — سيُحفظ ملف HTML بدلاً منه".to_string()
    })?;
    let file_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));
    let status = Command::new(&browser)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            &format!("--print-to-pdf={}", pdf_path.to_string_lossy()),
            &file_url,
        ])
        .status()
        .map_err(|e| format!("فشل تشغيل المتصفح للطباعة إلى PDF: {e}"))?;
    if !status.success() {
        return Err(format!("متصفح PDF خرج برمز {:?}", status.code()));
    }
    if !pdf_path.is_file() {
        return Err("لم يُنشأ ملف PDF رغم نجاح أمر المتصفح".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ArchiveResult {
    pub path: String,
    pub format: String,
}

/// Archive a printed/saved document into the Desktop folder tree.
/// Opens a native Save As dialog with a sanitized default filename so the
/// user can rename the file and choose the destination folder.
/// `html` should be a full HTML document (RTL + print CSS inlined by the FE).
pub fn archive_document_pdf(
    doc_type: String,
    file_stem: String,
    html: String,
    company_name: Option<String>,
) -> Result<ArchiveResult, String> {
    let root = desktop_dir()?.join(resolve_root_name(company_name.as_deref()));
    ensure_folders_at(&root)?;
    let sub = subfolder_name(&doc_type)?;
    let dir = root.join(sub);
    let stem = sanitize_stem(&file_stem);
    let default_name = format!("{stem}.pdf");

    // Save As: user can change name + folder. Cancel aborts without writing.
    let chosen = rfd::FileDialog::new()
        .set_title("حفظ المستند PDF")
        .set_directory(&dir)
        .set_file_name(&default_name)
        .add_filter("PDF", &["pdf"])
        .save_file();

    let pdf_path = match chosen {
        Some(path) => {
            let mut path = path;
            if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
                path.set_extension("pdf");
            }
            path
        }
        None => return Err("أُلغي الحفظ من نافذة Save As".into()),
    };

    if let Some(parent) = pdf_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("فشل إنشاء مجلد الحفظ: {e}"))?;
    }

    let html_path = pdf_path.with_extension("html");
    {
        let mut f = fs::File::create(&html_path)
            .map_err(|e| format!("فشل كتابة HTML مؤقت: {e}"))?;
        f.write_all(html.as_bytes())
            .map_err(|e| format!("فشل كتابة محتوى HTML: {e}"))?;
    }

    match html_to_pdf(&html_path, &pdf_path) {
        Ok(()) => {
            let _ = fs::remove_file(&html_path);
            Ok(ArchiveResult {
                path: pdf_path.to_string_lossy().into_owned(),
                format: "pdf".into(),
            })
        }
        Err(e) => {
            // Keep the HTML so the operator still has an archive copy.
            eprintln!("[document-archive] PDF fallback ({e}) — kept {}", html_path.display());
            Ok(ArchiveResult {
                path: html_path.to_string_lossy().into_owned(),
                format: "html".into(),
            })
        }
    }
}

/// Compact sortable timestamp without external chrono crate.
#[allow(dead_code)]
fn chrono_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs:0>10}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn ensure_folders_creates_all_subs() {
        let tmp = env::temp_dir().join(format!("motard-archive-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = ensure_folders_at(&tmp).expect("create");
        for (_, name) in SUBFOLDERS {
            assert!(root.join(name).is_dir(), "missing {name}");
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_root_name_prefers_the_real_company_name() {
        assert_eq!(resolve_root_name(Some("شركة الأمل")), "شركة الأمل");
    }

    #[test]
    fn resolve_root_name_falls_back_when_missing_or_blank() {
        assert_eq!(resolve_root_name(None), FALLBACK_ROOT_FOLDER);
        assert_eq!(resolve_root_name(Some("")), FALLBACK_ROOT_FOLDER);
        assert_eq!(resolve_root_name(Some("   ")), FALLBACK_ROOT_FOLDER);
    }

    #[test]
    fn resolve_root_name_sanitizes_ntfs_illegal_characters() {
        assert_eq!(resolve_root_name(Some("Fabrics/Group:2026")), "Fabrics_Group_2026");
    }

    #[test]
    fn statement_doc_type_maps_to_its_arabic_subfolder() {
        assert_eq!(subfolder_name("statement").expect("known type"), "كشوفات الحسابات");
    }
}
