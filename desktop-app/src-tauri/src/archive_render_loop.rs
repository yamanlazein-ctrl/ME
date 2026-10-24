//! The archive render loop: the shell PULLS the documents the backend wants rendered.
//!
//! The backend owns the archive pipeline and the document data; this process owns the renderer.
//! Neither can call the other directly — the shell reaches the backend over the runtime pipe
//! (HTTP), and the backend has no channel to the shell — so the backend queues the work and this
//! loop pulls it, renders it, and posts the result back over the same route.
//!
//! Before this loop existed, the PDF engine was unreachable from the product: the backend could
//! only upload CSV. The whole "monthly document generation" feature depended on this channel.
//!
//! The render itself runs on ITS OWN worker thread (see `webview2_render.rs`), so a slow document
//! never blocks the poll loop, and the app's UI thread is never touched.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::logger;
use crate::paths::Paths;
use crate::pipe;
use crate::pdf_render;

/// How often the loop asks the backend for work.
const POLL_INTERVAL: Duration = Duration::from_millis(700);
/// How long one HTTP call to the backend may take.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// One queued render request, as the backend sends it.
///
/// The backend speaks camelCase (`runId`, `outName`); the field names must match it exactly, or
/// the request silently arrives without the run it belongs to.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderRequest {
    id: String,
    run_id: String,
    format: String,
    out_name: String,
    paper: Option<String>,
    html: String,
}

/// The list the backend answers with.
#[derive(Debug, Deserialize)]
struct RenderRequestList {
    #[serde(default)]
    requests: Vec<RenderRequest>,
}

/// Start the render loop. It runs until the process ends.
pub fn start_archive_render_loop(sh: std::sync::Arc<crate::boot::Shared>) {
    std::thread::Builder::new()
        .name("motard-render-loop".into())
        .spawn(move || loop {
            if let Err(err) = poll_once(&sh) {
                logger::warn(&format!("archive render loop: {err}"));
            }
            std::thread::sleep(POLL_INTERVAL);
        })
        .ok();
}

/// One turn of the loop: pull the pending requests, render them, report the results.
fn poll_once(sh: &crate::boot::Shared) -> Result<(), String> {
    // The pipe name and the runtime token only exist once the backend is up. The loop reads them
    // every turn, so a backend restart is picked up without restarting the loop.
    let Some((pipe_name, token)) = sh
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|r| (r.backend.pipe.clone(), r.token.clone()))
    else {
        // Not an error: the loop simply waits. Reporting it logged a warning every 0.7 s — for the
        // whole boot, and forever if the backend never came up (the log grew without bound).
        return Ok(());
    };
    let headers = vec![("X-Motard-Runtime-Token".to_string(), token.clone())];
    let response = tauri::async_runtime::block_on(pipe::request(
        &pipe_name,
        "GET",
        "/api/desktop/runtime/archive-render-requests",
        &headers,
        b"",
        HTTP_TIMEOUT,
    ))
    .map_err(|e| format!("pull: {e}"))?;
    if response.status != 200 {
        return Err(format!("pull: HTTP {}", response.status));
    }
    let list: RenderRequestList =
        serde_json::from_slice(&response.body).map_err(|e| format!("parse: {e}"))?;

    for request in list.requests {
        // The render runs on its own thread; this loop only waits for it.
        let outcome = render_one(&sh.paths, &request);
        let body = match &outcome {
            Ok((path, sha256, size)) => json!({
                "requestId": request.id,
                "path": path,
                "sha256": sha256,
                "sizeBytes": size,
            }),
            Err(e) => json!({ "requestId": request.id, "error": e }),
        };
        let mut post_headers = headers.clone();
        post_headers.push(("Content-Type".to_string(), "application/json".to_string()));
        let posted = tauri::async_runtime::block_on(pipe::request(
            &pipe_name,
            "POST",
            "/api/desktop/runtime/archive-artifact",
            &post_headers,
            body.to_string().as_bytes(),
            HTTP_TIMEOUT,
        ))
        .map_err(|e| format!("post: {e}"))?;
        if posted.status != 200 {
            logger::warn(&format!(
                "archive render loop: the backend refused the artefact (HTTP {})",
                posted.status
            ));
            // Close the request as FAILED, so it is not left pending and re-rendered on every poll
            // (the backend falls back to the CSV export for that document).
            let failed = json!({ "requestId": request.id, "error": format!("artefact refused: HTTP {}", posted.status) });
            let _ = tauri::async_runtime::block_on(pipe::request(
                &pipe_name,
                "POST",
                "/api/desktop/runtime/archive-artifact",
                &post_headers,
                failed.to_string().as_bytes(),
                HTTP_TIMEOUT,
            ));
        }
    }
    Ok(())
}

/// Render one request and stage the file. Returns the path, the hash and the size.
///
/// The name and the run id are validated BEFORE anything is rendered or written (`stage_file`): the
/// output must land inside `archive-staging\<runId>\` and nowhere else. The file is written
/// atomically and hashed from its own bytes.
fn render_one(paths: &Paths, request: &RenderRequest) -> Result<(String, String, u64), String> {
    let ext = match request.format.as_str() {
        "pdf" | "png" => request.format.as_str(),
        other => return Err(format!("unsupported format: {other}")),
    };
    pdf_render::validate_out_name(&request.out_name, ext)?;
    pdf_render::validate_run_id(&request.run_id)?;
    let bytes = if ext == "pdf" {
        let paper = match request.paper.as_deref() {
            Some("A5") => pdf_render::Paper::A5,
            _ => pdf_render::Paper::A4,
        };
        crate::webview2_render::render_pdf(&request.html, paper.page_size())
            .map_err(|e| format!("render: {e}"))?
            .bytes
    } else {
        crate::webview2_render::render_png(&request.html)
            .map_err(|e| format!("render: {e}"))?
            .bytes
    };
    let staged = pdf_render::stage_file(paths, &request.run_id, &request.out_name, ext, &bytes)?;
    Ok((staged.path, staged.sha256, staged.size_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract with the backend. The backend answers with camelCase (`runId`, `outName`);
    /// if the field names drift, the request arrives WITHOUT the run it belongs to and the
    /// rendered file lands nowhere. This test pins the exact JSON the backend sends.
    #[test]
    fn a_render_request_from_the_backend_is_understood() {
        let body = r#"{
            "ok": true,
            "requests": [
                {
                    "id": "req-1",
                    "runId": "run-7",
                    "artifactId": "inv-1",
                    "format": "pdf",
                    "outName": "2026-10-05_INV-1_sale.pdf",
                    "paper": "A4",
                    "html": "<html><body>فاتورة</body></html>",
                    "state": "pending",
                    "path": null,
                    "sha256": null,
                    "sizeBytes": null,
                    "error": null
                }
            ]
        }"#;
        let list: RenderRequestList = serde_json::from_str(body).expect("the backend's JSON must parse");
        assert_eq!(list.requests.len(), 1);
        let r = &list.requests[0];
        assert_eq!(r.id, "req-1");
        assert_eq!(r.run_id, "run-7");
        assert_eq!(r.format, "pdf");
        assert_eq!(r.out_name, "2026-10-05_INV-1_sale.pdf");
        assert_eq!(r.paper.as_deref(), Some("A4"));
        assert!(r.html.contains("فاتورة"));
    }

    /// A name that tries to leave the staging folder is refused before anything is rendered or
    /// written — the file would otherwise land wherever the name pointed (e.g. the keys folder).
    #[test]
    fn a_request_cannot_write_outside_the_staging_folder() {
        let root = std::env::temp_dir().join(format!("motard-loop-{}", uuid::Uuid::new_v4().simple()));
        let paths = Paths::at(&root);
        for (run_id, out_name) in [
            ("run-1", "..\\..\\keys\\secrets.pdf"),
            ("run-1", "../escape.pdf"),
            ("run-1", "C:\\evil.pdf"),
            ("..", "doc.pdf"),
            ("run-1", "doc.exe"),
        ] {
            let request = RenderRequest {
                id: "req".into(),
                run_id: run_id.into(),
                format: "pdf".into(),
                out_name: out_name.into(),
                paper: None,
                html: "<html></html>".into(),
            };
            assert!(render_one(&paths, &request).is_err(), "{run_id} / {out_name} must be refused");
        }
        assert!(!root.exists(), "nothing may be created for a refused request");
    }

    #[test]
    fn an_empty_request_list_is_not_an_error() {
        let list: RenderRequestList = serde_json::from_str(r#"{"ok":true,"requests":[]}"#).expect("parse");
        assert!(list.requests.is_empty());
    }
}
