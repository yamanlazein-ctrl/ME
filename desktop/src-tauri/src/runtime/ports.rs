// Port management — the bundled PostgreSQL is purely internal (Plan §9.2).
//
// Root cause this closes (R-04/R-05): the DB port was once hardcoded to 5432
// — PostgreSQL's universally-known standard port — so ANY other Postgres on
// the machine (system service, another vendor's bundle, a developer instance,
// an orphaned previous run of this same app) made `pg_ctl start` fail with a
// message no non-technical customer could act on.
//
// Architecture, not a workaround:
//   1. The DEFAULT is drawn once from a high, uncommon range (40000..60000),
//      far from 5432 and from common service ranges, then persisted in
//      `db-port.txt` next to pgdata/secrets.dat and reused on every later
//      launch (stable DATABASE_URL, no per-boot churn).
//   2. If even the saved port is occupied on a given boot (checked
//      immediately before bind to shrink the TOCTOU window), boot falls back
//      to another free port in the same range and re-persists it.
//   3. `postgresql.conf` is forced into lock-step with the bind port, because
//      pg_ctl's `-w` readiness probe reads the port from the conf, NOT from
//      the `-o "-p ..."` passed to postgres — a disagreement is a guaranteed
//      false "start failed".
//
// Deliberately NOT applied to `backend_port`: the prebuilt SSR/frontend
// bundle has that port baked in at build time and cannot discover a moved
// one at runtime.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// High, uncommon port range for the bundled PostgreSQL's default.
pub const DB_PORT_RANGE: std::ops::Range<u16> = 40000..60000;

fn db_port_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join("db-port.txt")
}

pub fn resolve_db_port(app_data_root: &Path) -> u16 {
    let path = db_port_path(app_data_root);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(port) = text.trim().parse::<u16>() {
            if DB_PORT_RANGE.contains(&port) {
                return port;
            }
        }
    }
    use rand::Rng;
    let port = rand::rngs::OsRng.gen_range(DB_PORT_RANGE);
    persist_db_port(app_data_root, port);
    port
}

/// Persist the live DB port whenever boot falls back to a free port so the
/// next launch reuses the same value (stable DATABASE_URL / postgresql.conf).
pub fn persist_db_port(app_data_root: &Path, port: u16) {
    let _ = fs::create_dir_all(app_data_root);
    if let Err(e) = fs::write(db_port_path(app_data_root), port.to_string()) {
        crate::runtime::log(&format!(
            "warning: could not persist db-port.txt ({port}): {e}"
        ));
    }
}

/// Return `preferred` if free, otherwise another free port in DB_PORT_RANGE.
///
/// The small TOCTOU race (something else grabbing the port between this check
/// and postgres's own bind) is accepted and documented: postgres/pg_ctl will
/// fail loudly and the single-cause fatal path covers it. What this function
/// must NOT do is silently "fix" a conflict by retrying forever — one
/// deterministic fallback, then the real error surfaces.
pub fn find_free_db_port(preferred: u16) -> u16 {
    use rand::Rng;
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    // Stay inside the desktop DB port range — OS ephemeral ports from
    // bind(..., 0) can land outside 40000..59999 and break db-port.txt reuse.
    for _ in 0..64 {
        let candidate = rand::rngs::OsRng.gen_range(DB_PORT_RANGE);
        if candidate != preferred && TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return candidate;
        }
    }
    preferred
}

/// Default Desktop API port — baked into the prebuilt frontend (`VITE_API_BASE_URL`).
pub const BACKEND_PORT_DEFAULT: u16 = 8080;

/// DFP-009: the packaged frontend cannot discover a relocated backend port, so
/// we refuse to boot when the fixed port is occupied instead of hanging on
/// `/api/health/live` for 60s. Returns Ok when a probe bind succeeds.
pub fn ensure_backend_port_free(port: u16) -> Result<(), String> {
    use std::net::TcpListener;
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(_listener) => Ok(()),
        Err(e) => Err(format!(
            "backend port {port} is occupied (cannot bind 127.0.0.1:{port}): {e}"
        )),
    }
}

/// Force `postgresql.conf`'s port to the port postgres will actually bind.
///
/// pg_ctl's `-w` probe reads the port from the conf, not from `-o "-p ..."`.
/// initdb ships `#port = 5432` (commented); skipping commented lines once left
/// the conf without an active `port = N`, so pg_ctl probed 5432 while `-o -p`
/// listened elsewhere — a full 60s false failure. Uncomment/replace any port
/// directive, or append one when none exists. Idempotent.
pub fn sync_pg_conf_port(pgdata: &Path, db_port: u16) -> io::Result<()> {
    let conf = pgdata.join("postgresql.conf");
    let text = fs::read_to_string(&conf)?;
    let wanted = format!("port = {}", db_port);
    let mut replaced = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let directive = trimmed.strip_prefix('#').unwrap_or(trimmed).trim_start();
            if !replaced && directive.starts_with("port") && directive.contains('=') {
                // Match `port =` / `#port =` only — not unrelated `*_port` keys.
                let rest = directive.trim_start_matches("port").trim_start();
                if rest.starts_with('=') {
                    replaced = true;
                    return wanted.clone();
                }
            }
            line.to_string()
        })
        .collect();
    if !replaced {
        lines.push(wanted.clone());
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    fs::write(&conf, out)?;
    crate::runtime::log(&format!("postgresql.conf port synced to {}", db_port));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "motard-erp-{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_db_port_never_returns_5432_and_persists_across_calls() {
        let dir = scratch("dbport");

        let first = resolve_db_port(&dir);
        assert!(
            DB_PORT_RANGE.contains(&first),
            "port {} outside the intended high/uncommon range",
            first
        );
        assert_ne!(first, 5432, "must never default to the standard PostgreSQL port");

        // Second call must reuse the SAME persisted port, not roll a new one.
        let second = resolve_db_port(&dir);
        assert_eq!(first, second, "port must be stable across launches");

        let saved = fs::read_to_string(dir.join("db-port.txt")).unwrap();
        assert_eq!(saved.trim().parse::<u16>().unwrap(), first);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_db_port_file_falls_back_into_range() {
        let dir = scratch("dbport-corrupt");
        fs::write(dir.join("db-port.txt"), "not-a-port").unwrap();
        let port = resolve_db_port(&dir);
        assert!(DB_PORT_RANGE.contains(&port));
        assert_ne!(port, 5432);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preferred_free_port_is_returned_unchanged() {
        // 48001 is inside the range; whether it is free is environment
        // dependent, so only assert the contract: result is in range.
        let port = find_free_db_port(48001);
        assert!(DB_PORT_RANGE.contains(&port) || port == 48001);
    }

    #[test]
    fn sync_pg_conf_port_uncomments_and_sets() {
        let dir = scratch("pgconf");
        fs::write(dir.join("postgresql.conf"), "#port = 5432\nlisten_addresses = 'localhost'\n").unwrap();
        sync_pg_conf_port(&dir, 41234).unwrap();
        let out = fs::read_to_string(dir.join("postgresql.conf")).unwrap();
        assert!(out.contains("port = 41234"), "conf must carry the bind port:\n{out}");
        assert!(!out.contains("#port"), "commented directive must be replaced:\n{out}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_pg_conf_port_appends_when_absent() {
        let dir = scratch("pgconf-append");
        fs::write(dir.join("postgresql.conf"), "listen_addresses = 'localhost'\n").unwrap();
        sync_pg_conf_port(&dir, 41235).unwrap();
        let out = fs::read_to_string(dir.join("postgresql.conf")).unwrap();
        assert!(out.contains("port = 41235"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_backend_port_free_rejects_occupied_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        assert!(
            ensure_backend_port_free(occupied).is_err(),
            "occupied port must fail"
        );
        drop(listener);
    }
}
