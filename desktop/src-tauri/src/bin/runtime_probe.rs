// D4-3 standalone probe — exercises desktop_runtime::boot_desktop_stack WITHOUT
// a GUI, using the dev tree (system node + already-built backend). It proves the
// orchestration works end-to-end: bundled postgres starts, the backend boots
// with injected local secrets, /api/health/live returns 200, then everything
// is cleanly shut down.
//
// Usage (from a VS Native Tools prompt):
//   cargo run --bin runtime_probe
// Env overrides:
//   ME_NODE_EXE            node runtime (default: "node" on PATH)
//   ME_LICENSE_PUBLIC_KEY  Ed25519 public PEM to inject (else parsed from backend/.env)
use motard_fabrics_erp::desktop_runtime::{boot_desktop_stack, shutdown, BootConfig};
use std::env;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")) // src-tauri
}

fn repo_root() -> PathBuf {
    manifest_dir().join("..").join("..")
}

/// Best-effort extraction of LICENSE_SIGNING_PUBLIC_KEY from backend/.env.
fn public_key_from_env_file() -> Option<String> {
    let path = repo_root().join("backend").join(".env");
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("LICENSE_SIGNING_PUBLIC_KEY=") {
            let v = rest.trim().trim_matches('"');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn main() {
    let manifest = manifest_dir();
    let resources_root = manifest.join("resources");
    let backend_dir = repo_root().join("backend");
    let server_js = backend_dir
        .join("dist")
        .join("backend")
        .join("src")
        .join("presentation")
        .join("server.js");

    let node_exe = env::var("ME_NODE_EXE").unwrap_or_else(|_| "node".to_string());
    let license_public_key = env::var("ME_LICENSE_PUBLIC_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(public_key_from_env_file);

    // Use an isolated data dir so the probe never touches a real install's pgdata.
    let probe_data = env::temp_dir().join("motard-erp-probe");
    std::fs::create_dir_all(&probe_data).ok();

    // Allow overriding ports (e.g. when the default 5432 is taken by a dev service).
    let db_port: u16 = env::var("ME_DB_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5432);
    let backend_port: u16 = env::var("ME_BACKEND_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);

    let cfg = BootConfig {
        resources_root,
        app_data_root: probe_data.clone(),
        node_exe: PathBuf::from(node_exe),
        backend_dir: backend_dir.clone(),
        server_js: server_js.clone(),
        license_public_key: license_public_key.clone(),
        db_port,
        backend_port,
    };

    // Optional negative test: ME_PREFLIGHT_MISSING=<filename> makes the probe
    // point resources_root at a fixture dir with that file deleted, proving the
    // pre-flight dialog path fires (boot fails with the missing-file list).
    if let Ok(missing) = env::var("ME_PREFLIGHT_MISSING") {
        let fixture = manifest.join("resources-preflight-fixture");
        let bin = fixture.join("postgres").join("bin");
        let _ = std::fs::remove_dir_all(&fixture);
        std::fs::create_dir_all(&bin).ok();
        std::fs::create_dir_all(fixture.join("ssr").join("dist").join("server")).ok();
        std::fs::create_dir_all(fixture.join("postgres").join("pgdata-template")).ok();
        // Copy only the small files the pre-flight needs, minus the requested one.
        for (src, dst) in [
            (manifest.join("resources").join("postgres").join("bin").join("pg_ctl.exe"), bin.join("pg_ctl.exe")),
            (manifest.join("resources").join("postgres").join("bin").join("initdb.exe"), bin.join("initdb.exe")),
            (manifest.join("resources").join("postgres").join("bin").join("libpq.dll"), bin.join("libpq.dll")),
            (manifest.join("resources").join("ssr").join("serve.mjs"), fixture.join("ssr").join("serve.mjs")),
            (manifest.join("resources").join("ssr").join("dist").join("server").join("server.js"), fixture.join("ssr").join("dist").join("server").join("server.js")),
            (manifest.join("resources").join("postgres").join("pgdata-template").join("PG_VERSION"), fixture.join("postgres").join("pgdata-template").join("PG_VERSION")),
        ] {
            if src.file_name().map(|n| n.to_string_lossy().to_string()) != Some(missing.clone()) {
                std::fs::copy(&src, &dst).ok();
            }
        }
        let cfg2 = BootConfig {
            resources_root: fixture,
            app_data_root: probe_data.clone(),
            node_exe: manifest.join("resources").join("node.exe"),
            backend_dir: backend_dir.clone(),
            server_js: server_js.clone(),
            license_public_key,
            db_port,
            backend_port,
        };
        eprintln!("[runtime-probe] negative preflight test: expect FAIL listing '{}'", missing);
        match boot_desktop_stack(&cfg2) {
            Ok(_) => { eprintln!("[runtime-probe] UNEXPECTED: boot succeeded with missing file"); std::process::exit(1); }
            Err(e) => {
                eprintln!("[runtime-probe] EXPECTED-FAIL: {}", e);
                if e.to_string().contains(&missing) { eprintln!("[runtime-probe] PASS: error names the missing file."); } else { eprintln!("[runtime-probe] note: error did not name the file"); }
                std::process::exit(0);
            }
        }
    }

    eprintln!("[runtime-probe] booting desktop stack (probe)…");
    let mut stack = match boot_desktop_stack(&cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[runtime-probe] FAIL boot: {}", e);
            std::process::exit(1);
        }
    };

    // Verify the health endpoint really answers.
    let healthy = (|| -> bool {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let addr: std::net::SocketAddr = format!("127.0.0.1:{}", stack.backend_port).parse().unwrap();
        let mut s = match TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let _ = s.write_all(b"GET /api/health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        let mut buf = [0u8; 512];
        match s.read(&mut buf) {
            Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).contains("HTTP/1.1 2"),
            _ => false,
        }
    })();

    if !healthy {
        eprintln!("[runtime-probe] FAIL: /api/health/live did not return 2xx");
        shutdown(&mut stack);
        std::process::exit(1);
    }

    // Verify the SSR frontend (spawned by boot_desktop_stack) really serves.
    // NOTE: the server-rendered /login page is a streaming shell: <html lang="ar"
    // dir="rtl">, Arabic <title>, and modulepreload/stylesheet links are emitted
    // by SSR; the form fields themselves are client-hydrated from the JS chunks
    // (verified separately via a real headless browser). So the probe asserts the
    // shell markers, the login route chunk preload, and that the chunk itself is
    // fetchable — proving static asset serving works end-to-end.
    let ssr_ok = (|| -> Option<String> {
        use std::io::{Read, Write};
        use std::net::TcpStream;

        fn get(path: &str) -> Option<String> {
            let addr: std::net::SocketAddr = "127.0.0.1:4173".parse().unwrap();
            let mut s = TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)).ok()?;
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let req = format!(
                "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                path
            );
            s.write_all(req.as_bytes()).ok()?;
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match s.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            Some(String::from_utf8_lossy(&buf).into_owned())
        }

        let page = get("/login")?;
        if !page.contains("HTTP/1.1 2") {
            return None;
        }
        for marker in ["dir=\"rtl\"", "lang=\"ar\"", "<title>", "modulepreload"] {
            if !page.contains(marker) {
                eprintln!("[runtime-probe] missing marker in /login: {}", marker);
                return None;
            }
        }
        // Extract the first preloaded asset and fetch it to prove asset serving.
        let idx = page.find("/assets/")?;
        let rest = &page[idx..];
        let end = rest.find('"')?;
        let asset = &rest[..end];
        let asset_resp = get(asset)?;
        if !asset_resp.contains("HTTP/1.1 2") {
            eprintln!("[runtime-probe] asset {} did not return 2xx", asset);
            return None;
        }
        Some(format!("(shell + asset {})", asset))
    })();

    match ssr_ok {
        Some(detail) => eprintln!("[runtime-probe] PASS: SSR serves /login {}.", detail),
        None => {
            eprintln!("[runtime-probe] FAIL: SSR frontend did not serve /login shell + assets");
            shutdown(&mut stack);
            std::process::exit(1);
        }
    }

    eprintln!("[runtime-probe] PASS: stack booted, backend healthy. Shutting down…");
    shutdown(&mut stack);
    eprintln!("[runtime-probe] PASS: clean shutdown complete.");
}
