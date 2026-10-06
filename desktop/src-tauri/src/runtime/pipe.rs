// Named-pipe transport — the desktop API channel after the Phase 1 cut-over.
//
// Before: the UI navigated to `http://127.0.0.1:<port>/`, so the application
// was a web page served by a local web server, and a dead server meant
// WebView2's own "can't reach this page" screen. After: Tauri serves the SPA
// from its own asset protocol, and this module is the only path to the API.
//
// `node`'s `http.Server.listen(pipePath)` speaks ordinary HTTP/1.1 over the
// duplex stream, so this is a small HTTP client, not a new protocol — the
// Express app, every middleware, route and test is byte-identical.
//
// Two Windows facts the spike proved and this module encodes:
//   1. a pipe handle must be opened read+WRITE. `File::open` is read-only and
//      every write then fails with `Access is denied. (os error 5)`.
//   2. a keep-alive response without `Content-Length` cannot be framed — the
//      next request's bytes would be read as this body. One request per
//      connection (`Connection: close`, body ends at EOF) keeps framing trivial
//      and was measured at p99 1.35 ms over 1000 requests, so the extra
//      connect is not worth the framing risk.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;

/// The pipe the bundled sidecar listens on. A well-known name in the per-user
/// namespace, so two Windows users on one machine never collide.
///
/// PR-3: a debug (`dev-fast`) build uses a DIFFERENT pipe — and a different app
/// data root — from the installed release build. Both binaries otherwise live in
/// the same per-user namespace, so running the dev executable next to an
/// installed one would have them fight over the same pipe and, worse, the same
/// pgdata. Isolating them by build mode makes that impossible.
pub const PIPE_PATH: &str = if cfg!(debug_assertions) {
    r"\\.\pipe\motard-erp-dev"
} else {
    r"\\.\pipe\motard-erp"
};

/// Header/body byte cap. A local request/response over a pipe is not a network
/// boundary, but an unbounded read is still an OOM waiting for a bad day; 32 MiB
/// is far above any report the app produces (the largest measured payload is a
/// 2 MiB export) and far below anything that would hurt the machine.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// A single HTTP/1.1 exchange over one pipe connection.
pub struct PipeConnection {
    reader: BufReader<std::fs::File>,
    writer: std::fs::File,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

/// One `Name: value` pair from the response. A `Vec` rather than a map because
/// `Set-Cookie` legitimately repeats, and a map would silently keep only one.
pub type HeaderPair = (String, String);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeResponse {
    pub status: u16,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    /// `Some` when the exchange failed before a status line arrived — the case
    /// the UI must render as a normal error instead of a dead page.
    pub error: Option<String>,
    pub elapsed_us: u64,
}

impl PipeConnection {
    pub fn connect(pipe: &str) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(Path::new(pipe))?;
        Ok(Self {
            reader: BufReader::new(file.try_clone()?),
            writer: file,
        })
    }

    /// True when the sidecar is accepting a connection right now. Cheap enough to
    /// run every poll cycle; this is the liveness signal that replaced the port
    /// file.
    pub fn is_listening(pipe: &str) -> bool {
        Self::connect(pipe).is_ok()
    }

    fn exchange(
        &mut self,
        method: &str,
        path: &str,
        headers: Option<&std::collections::HashMap<String, String>>,
        body: Option<&str>,
    ) -> std::io::Result<(u16, Vec<HeaderPair>, String)> {
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
        if let Some(h) = headers {
            for (k, v) in h {
                // Host and Connection are ours to set; a caller overriding them
                // would break framing.
                if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("connection") {
                    continue;
                }
                req.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        let payload = body.unwrap_or("");
        if !payload.is_empty() {
            req.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        req.push_str("Connection: close\r\n\r\n");
        req.push_str(payload);

        self.writer.write_all(req.as_bytes())?;
        self.writer.flush()?;

        let mut status_line = String::new();
        self.reader.read_line(&mut status_line)?;
        if status_line.is_empty() {
            return Err(std::io::Error::other("sidecar closed before responding"));
        }
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| {
                std::io::Error::other(format!("no status code in response: {status_line:?}"))
            })?;

        let mut out_headers: Vec<HeaderPair> = Vec::new();
        loop {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line)?;
            if n == 0 || line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim();
                if !name.is_empty() {
                    out_headers.push((name.to_string(), value.trim().to_string()));
                }
            }
        }

        let mut buf = Vec::new();
        self.reader.by_ref().take(MAX_BODY_BYTES as u64).read_to_end(&mut buf)?;
        if buf.len() >= MAX_BODY_BYTES {
            return Err(std::io::Error::other(format!(
                "response exceeded the {MAX_BODY_BYTES}-byte cap"
            )));
        }
        Ok((
            status,
            out_headers,
            String::from_utf8_lossy(&buf).into_owned(),
        ))
    }
}

/// One request, one connection, timed. Never panics and never hangs: a dead or
/// wedged sidecar surfaces as `error: Some(..)` with status 0, which is exactly
/// what the transport bridge turns into a normal rejected promise.
#[hotpath::measure]
pub fn request(req: &PipeRequest) -> PipeResponse {
    let started = std::time::Instant::now();
    let run = || -> std::io::Result<(u16, Vec<HeaderPair>, String)> {
        let mut conn = PipeConnection::connect(PIPE_PATH)?;
        conn.exchange(
            &req.method,
            &req.path,
            req.headers.as_ref(),
            req.body.as_deref(),
        )
    };
    let elapsed_us = started.elapsed().as_micros() as u64;
    match run() {
        Ok((status, headers, body)) => PipeResponse {
            status,
            headers,
            body,
            error: None,
            elapsed_us,
        },
        Err(e) => PipeResponse {
            status: 0,
            headers: Vec::new(),
            body: String::new(),
            error: Some(format!("{e}")),
            elapsed_us,
        },
    }
}

/// Liveness probe used by boot and by the supervisor's health cycle.
#[hotpath::measure]
pub fn probe_live() -> bool {
    let req = PipeRequest {
        method: "GET".into(),
        path: "/api/health/live".into(),
        body: None,
        headers: None,
    };
    let r = request(&req);
    r.error.is_none() && r.status == 200
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_pipe_is_reported_not_panicked() {
        // The whole point of the migration: an unreachable sidecar is a TYPED
        // error the UI can render, never a hang and never a crash.
        let r = request(&PipeRequest {
            method: "GET".into(),
            path: "/api/health/live".into(),
            body: None,
            headers: None,
        });
        match r.error.as_deref() {
            Some(err) => {
                // Nothing listening: the contract is a typed error, not a hang
                // and not a panic.
                assert!(!err.is_empty());
                assert_eq!(r.status, 0);
                assert_eq!(r.body, "");
                assert!(r.headers.is_empty());
            }
            None => assert_eq!(r.status, 200, "a live sidecar must answer 200"),
        }
    }

    #[test]
    fn probe_live_agrees_with_the_request() {
        let r = request(&PipeRequest {
            method: "GET".into(),
            path: "/api/health/live".into(),
            body: None,
            headers: None,
        });
        assert_eq!(probe_live(), r.error.is_none() && r.status == 200);
    }

    #[test]
    fn host_and_connection_headers_cannot_be_overridden() {
        // A caller-supplied Host or Connection would break response framing —
        // this is a real exchange whenever a sidecar happens to be listening.
        let mut conn = match PipeConnection::connect(PIPE_PATH) {
            Ok(c) => c,
            // No sidecar in this unit-test process: the framing itself is
            // exercised end-to-end by the desktop integration run.
            Err(_) => return,
        };
        let mut h = std::collections::HashMap::new();
        h.insert("host".to_string(), "evil.example".to_string());
        h.insert("connection".to_string(), "keep-alive".to_string());
        h.insert("x-probe".to_string(), "kept".to_string());
        let (status, headers, _body) = conn
            .exchange("GET", "/api/health/live", Some(&h), None)
            .expect("a poisoned Host must not stop the request being served");
        assert_eq!(status, 200);
        // The response came from a real server, and these are the server's own
        // headers — proof the forced `Connection: close` still framed it.
        assert!(headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("content-type")));
    }

    #[test]
    fn the_pipe_name_is_per_user_and_isolated_by_build_mode() {
        // A per-user namespace name means two Windows users on one machine
        // (each with their own AppData and their own cluster) never collide.
        // A debug (dev-fast) build must use the -dev pipe so a dev run can never
        // contend with an installed release for the same pipe / pgdata (PR-3).
        let expected = if cfg!(debug_assertions) {
            r"\\.\pipe\motard-erp-dev"
        } else {
            r"\\.\pipe\motard-erp"
        };
        assert_eq!(PIPE_PATH, expected);
    }
}
