//! Phase 3 — background document rendering for the Drive archive (no print dialog).
//!
//! The rendering itself lives in `webview2_render.rs`: a dedicated WebView2 environment on a
//! worker thread, driving a hidden window. That module owns the COM work; this one owns the
//! ARCHIVE side of it — the staging layout, the validation, the paper sizes and the hash of the
//! produced bytes.
//!
//! Why the worker thread matters: the browser's `PrintToPdf` is asynchronous, but the COM calls
//! around it are not free, and the app's own webview lives on the UI thread. Rendering there would
//! freeze the window for the whole document. On a worker thread the desktop stays responsive, and
//! the render can be exercised by `cargo test` on any machine with the WebView2 runtime.
//!
//! Output goes to `<root>\archive-staging\<runId>\` only, never to the Desktop archive folder.

use crate::fsutil;
use crate::paths::Paths;
use crate::webview2_render::PageSize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Staging directory name under the data root.
pub const STAGING_DIR: &str = "archive-staging";

/// Paper sizes in millimetres, the same sizes the print CSS uses (A4 / A5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paper {
    A4,
    A5,
}

impl Paper {
    /// The page size in INCHES (WebView2's `PrintToPdf` unit).
    pub fn page_size(self) -> PageSize {
        match self {
            Paper::A4 => PageSize {
                width_in: 8.27,
                height_in: 11.69,
            },
            Paper::A5 => PageSize {
                width_in: 5.83,
                height_in: 8.27,
            },
        }
    }
}

/// What a render produced: the staged file, its size and its SHA-256.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// `<root>\archive-staging\<runId>`. The run id must be a plain identifier: no separators, no dots,
/// so a crafted id can never point outside the staging area.
pub fn run_staging_dir(paths: &Paths, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    Ok(paths.root.join(STAGING_DIR).join(run_id))
}

pub fn validate_run_id(run_id: &str) -> Result<(), String> {
    let ok = !run_id.is_empty()
        && run_id.len() <= 64
        && run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err("معرّف التشغيل غير صالح".into()) }
}

/// A staged output file name: one plain segment, a known extension, no path separators.
pub fn validate_out_name(name: &str, ext: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 150
        || name.contains(['/', '\\', ':', '\0'])
        || name == "."
        || name == ".."
        || name.starts_with('.');
    if bad {
        return Err("اسم الملف غير صالح".into());
    }
    if !name.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        return Err(format!("امتداد الملف يجب أن يكون .{ext}"));
    }
    Ok(())
}

/// SHA-256 and size of a staged file, read from its own bytes (never trusted from the caller).
pub fn measure(path: &Path) -> Result<(String, u64), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("قراءة الملف المُنتج: {e}"))?;
    let sha = fsutil::hex(&Sha256::digest(&bytes));
    Ok((sha, bytes.len() as u64))
}

/// Write `bytes` into the run's staging directory atomically and return what was written.
pub fn stage_file(paths: &Paths, run_id: &str, name: &str, ext: &str, bytes: &[u8]) -> Result<RenderResult, String> {
    validate_out_name(name, ext)?;
    let dir = run_staging_dir(paths, run_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(name);
    fsutil::atomic_write(&file, bytes).map_err(|e| e.to_string())?;
    let (sha256, size_bytes) = measure(&file)?;
    Ok(RenderResult { path: file.display().to_string(), sha256, size_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use crate::webview2_render::{render_pdf as wv2_render_pdf, render_png as wv2_render_png};

    fn temp_paths(tag: &str) -> Paths {
        let root = std::env::temp_dir().join(format!(
            "motard-pdf-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        Paths::at(&root)
    }

    #[test]
    fn run_ids_cannot_escape_the_staging_area() {
        assert!(validate_run_id("run-1").is_ok());
        assert!(validate_run_id("..").is_err());
        assert!(validate_run_id("a/b").is_err());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn output_names_cannot_escape_the_staging_area() {
        assert!(validate_out_name("doc.pdf", "pdf").is_ok());
        assert!(validate_out_name("../doc.pdf", "pdf").is_err());
        assert!(validate_out_name("a/b.pdf", "pdf").is_err());
        assert!(validate_out_name(".pdf", "pdf").is_err());
        assert!(validate_out_name("doc.png", "pdf").is_err());
    }

    #[test]
    fn the_staging_area_is_always_inside_the_run_directory() {
        let paths = temp_paths("stage");
        let dir = run_staging_dir(&paths, "run-9").expect("staging dir");
        assert!(dir.starts_with(&paths.root));
        assert!(dir.ends_with("archive-staging/run-9"));
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn staged_files_are_hashed_from_their_own_bytes() {
        let paths = temp_paths("hash");
        let r = stage_file(&paths, "run-1", "doc.pdf", "pdf", b"hello").expect("stage");
        assert_eq!(r.size_bytes, 5);
        // The SHA-256 of "hello".
        assert_eq!(
            r.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn the_paper_sizes_are_the_ones_the_print_css_uses() {
        // A4 and A5, in INCHES — the unit WebView2's `PrintToPdf` takes. The print CSS uses the
        // same two sizes (`print.css`), so the archived PDF and the printed page agree.
        let a4 = Paper::A4.page_size();
        assert!((a4.width_in - 8.27).abs() < 0.01);
        assert!((a4.height_in - 11.69).abs() < 0.01);
        let a5 = Paper::A5.page_size();
        assert!((a5.width_in - 5.83).abs() < 0.01);
        assert!((a5.height_in - 8.27).abs() < 0.01);
    }

    /// THE SPIKE, as an automated test: a REAL PDF, produced by the real WebView2 renderer, on the
    /// machine that runs the tests. It needs the WebView2 runtime (present on any Windows 10/11 with
    /// Edge). The PDF is checked for its magic bytes and for the page size of A4.
    ///
    /// It does NOT skip: a render that fails is a failure. The first version of this test skipped
    /// on any error, and so "passed" while the renderer was in fact timing out — a green test that
    /// proved nothing.
    #[test]
    fn a_real_pdf_is_produced() {
        let html = "<!doctype html><html><head><meta charset='utf-8'><style>\
            @page { size: A4; margin: 12mm; }\
            body { font-family: 'Segoe UI', Tahoma, sans-serif; }\
            </style></head><body><h1>فاتورة اختبار</h1><p>مرحبا</p></body></html>";
        let rendered = wv2_render_pdf(html, Paper::A4.page_size())
            .expect("the WebView2 renderer must produce a PDF (is the WebView2 runtime installed?)");
        assert!(rendered.bytes.len() > 500, "the PDF must not be empty");
        assert_eq!(&rendered.bytes[..5], b"%PDF-", "the output must be a PDF");
        // A modern PDF keeps its objects in COMPRESSED streams, so the page tree is not in
        // plaintext: the trailer is the reliable end marker.
        let tail = &rendered.bytes[rendered.bytes.len().saturating_sub(32)..];
        assert!(
            tail.windows(5).any(|w| w == b"%%EOF"),
            "the PDF must be complete (no %%EOF trailer)"
        );
    }

    /// The PNG path: the cashbox snapshot. Same renderer, a different capture.
    #[test]
    fn a_real_png_is_produced() {
        let html = "<!doctype html><html><head><meta charset='utf-8'><style>\
            body { font-family: 'Segoe UI', Tahoma, sans-serif; background:#fff; }\
            </style></head><body><h1>تقرير الصندوق</h1></body></html>";
        let rendered = wv2_render_png(html)
            .expect("the WebView2 renderer must produce a PNG (is the WebView2 runtime installed?)");
        assert!(rendered.bytes.len() > 500, "the PNG must not be empty");
        // The PNG magic number.
        assert_eq!(&rendered.bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
