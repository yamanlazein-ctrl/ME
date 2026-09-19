//! Desktop data-directory identity (P0-2 / P1-4).
//!
//! `%LOCALAPPDATA%/motard-erp/db-meta.json` stamps the live pgdata with:
//!   * `installation_id` — must match the DPAPI device-binding identity
//!   * `pg_major`        — must match the bundled postgres PG_VERSION
//!   * `schema_journal_idx` — last Drizzle journal idx this binary understands;
//!     a *newer* on-disk value means this binary is too old (refuse, no down-migrate)
//!
//! Missing metadata next to an existing PG_VERSION is refused unless this is a
//! genuine same-machine upgrade (legacy cluster predating db-meta.json): that
//! path requires a local `secrets.dat` so a copied-in foreign pgdata alone
//! cannot be adopted onto a new install.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

pub const META_FILE: &str = "db-meta.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbMeta {
    pub installation_id: String,
    pub pg_major: u16,
    #[serde(default)]
    pub schema_journal_idx: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

pub fn meta_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(META_FILE)
}

pub fn read_meta(app_data_root: &Path) -> io::Result<Option<DbMeta>> {
    let path = meta_path(app_data_root);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let parsed: DbMeta = serde_json::from_str(&raw)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, format!("db-meta.json تالف: {e}")))?;
    if parsed.installation_id.trim().is_empty() || parsed.pg_major == 0 {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "db-meta.json ناقص (installation_id / pg_major)",
        ));
    }
    Ok(Some(parsed))
}

pub fn write_meta(app_data_root: &Path, meta: &DbMeta) -> io::Result<()> {
    fs::create_dir_all(app_data_root)?;
    let body = serde_json::to_string_pretty(meta)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e.to_string()))?;
    fs::write(meta_path(app_data_root), body)
}

/// First line of PostgreSQL's `PG_VERSION` file, e.g. "16".
pub fn read_pg_major(pg_version_file: &Path) -> io::Result<u16> {
    let text = fs::read_to_string(pg_version_file)?;
    let major = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u16>()
        .map_err(|_| {
            io::Error::new(
                ErrorKind::InvalidData,
                format!("تعذّر قراءة إصدار PostgreSQL من {}", pg_version_file.display()),
            )
        })?;
    Ok(major)
}

pub fn bundled_pg_major(resources_root: &Path) -> io::Result<u16> {
    let template = resources_root
        .join("postgres")
        .join("pgdata-template")
        .join("PG_VERSION");
    if template.exists() {
        return read_pg_major(&template);
    }
    // Fallback: some layouts keep PG_VERSION only after copy.
    Err(io::Error::new(
        ErrorKind::NotFound,
        "ملف PG_VERSION للقالب المرفق غير موجود",
    ))
}

/// Last `idx` in Drizzle `_journal.json`. Missing journal → 0 (migrate will no-op / fail later).
pub fn bundled_schema_journal_idx(backend_dir: &Path) -> i32 {
    let candidates = [
        backend_dir
            .join("src")
            .join("infrastructure")
            .join("orm")
            .join("migrations")
            .join("meta")
            .join("_journal.json"),
        backend_dir
            .join("dist")
            .join("backend")
            .join("src")
            .join("infrastructure")
            .join("orm")
            .join("migrations")
            .join("meta")
            .join("_journal.json"),
    ];
    for path in candidates {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(entries) = v.get("entries").and_then(|e| e.as_array()) {
                    if let Some(last) = entries.last() {
                        if let Some(idx) = last.get("idx").and_then(|i| i.as_i64()) {
                            return idx as i32;
                        }
                    }
                }
            }
        }
    }
    0
}

#[derive(Debug)]
pub enum ClusterDecision {
    Fresh,
    Reuse,
}

/// Decide whether an existing cluster may be reused.
///
/// * No `PG_VERSION` → Fresh.
/// * `PG_VERSION` + matching meta (id + pg major, schema not newer than binary) → Reuse.
/// * `PG_VERSION` + no meta + matching pg major + local `secrets.dat` → adopt
///   onto this installation_id (upgrade from pre-meta installs on the same machine).
/// * `PG_VERSION` + no meta + no secrets → refuse (foreign/copied cluster).
/// * Anything else → Err with an Arabic operator message.
pub fn evaluate_existing_cluster(
    app_data_root: &Path,
    pgdata: &Path,
    installation_id: &str,
    bundled_pg_major: u16,
    bundled_schema_idx: i32,
) -> io::Result<ClusterDecision> {
    if !pgdata.join("PG_VERSION").exists() {
        return Ok(ClusterDecision::Fresh);
    }
    let on_disk_major = read_pg_major(&pgdata.join("PG_VERSION"))?;
    if on_disk_major != bundled_pg_major {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "إصدار PostgreSQL المحفوظ ({on_disk_major}) لا يطابق المرفق مع هذا التثبيت ({bundled_pg_major}).\n\
                 لا يمكن إعادة استخدام مجلد البيانات هذا. انقل نسخة احتياطية ثم استخدم إعادة الضبط المصنعي."
            ),
        ));
    }
    match read_meta(app_data_root)? {
        Some(meta) => {
            if meta.installation_id != installation_id {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "هوية التثبيت في قاعدة البيانات المحلية لا تطابق هذا التثبيت.\n\
                     غالباً نُسخت مجلدات بيانات من تثبيت آخر. لن يُعاد استخدامها.",
                ));
            }
            if meta.pg_major != bundled_pg_major {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    format!(
                        "db-meta.json يحمل pg_major={} بينما التثبيت الحالي {}",
                        meta.pg_major, bundled_pg_major
                    ),
                ));
            }
            if meta.schema_journal_idx > bundled_schema_idx {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    format!(
                        "قاعدة البيانات أُحدّثت بمخطط أحدث (فهرس {0}) من هذا البرنامج ({1}).\n\
                         ثبّت الإصدار الأحدث من البرنامج — لا يوجد مسار تراجع للمخطط.",
                        meta.schema_journal_idx, bundled_schema_idx
                    ),
                ));
            }
            Ok(ClusterDecision::Reuse)
        }
        None => {
            // Legacy same-machine upgrade only: pgdata without meta is safe to
            // adopt when this AppData already holds secrets from a prior boot
            // of this product. A bare copied pgdata (no secrets) is foreign.
            if !app_data_root.join("secrets.dat").exists() {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "مجلد قاعدة البيانات المحلية موجود بدون هوية تثبيت (db-meta.json) وبدون أسرار محلية.\n\
                     لن يُعاد استخدامه — قد يكون منسوخاً من تثبيت أو جهاز آخر.\n\
                     انقل نسخة احتياطية إن لزم، ثم استخدم إعادة الضبط المصنعي أو احذف مجلد pgdata يدوياً.",
                ));
            }
            let meta = DbMeta {
                installation_id: installation_id.to_string(),
                pg_major: bundled_pg_major,
                schema_journal_idx: 0,
                created_at: Some(chrono_now()),
            };
            write_meta(app_data_root, &meta)?;
            Ok(ClusterDecision::Reuse)
        }
    }
}

pub fn stamp_fresh_cluster(
    app_data_root: &Path,
    installation_id: &str,
    pg_major: u16,
    schema_journal_idx: i32,
) -> io::Result<()> {
    write_meta(
        app_data_root,
        &DbMeta {
            installation_id: installation_id.to_string(),
            pg_major,
            schema_journal_idx,
            created_at: Some(chrono_now()),
        },
    )
}

fn chrono_now() -> String {
    // RFC3339-ish UTC without pulling a chrono crate: enough for operators.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "motard-dbmeta-{}",
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
    fn missing_pgdata_is_fresh() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        let d = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap();
        assert!(matches!(d, ClusterDecision::Fresh));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn matching_meta_reuses() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
        write_meta(
            &dir,
            &DbMeta {
                installation_id: "id-a".into(),
                pg_major: 16,
                schema_journal_idx: 40,
                created_at: None,
            },
        )
        .unwrap();
        let d = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap();
        assert!(matches!(d, ClusterDecision::Reuse));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mismatched_installation_id_refuses() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
        write_meta(
            &dir,
            &DbMeta {
                installation_id: "other-install".into(),
                pg_major: 16,
                schema_journal_idx: 1,
                created_at: None,
            },
        )
        .unwrap();
        let err = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap_err();
        assert!(err.to_string().contains("هوية التثبيت"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_schema_on_older_binary_refuses() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
        write_meta(
            &dir,
            &DbMeta {
                installation_id: "id-a".into(),
                pg_major: 16,
                schema_journal_idx: 99,
                created_at: None,
            },
        )
        .unwrap();
        let err = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap_err();
        assert!(err.to_string().contains("أحدث"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_meta_without_secrets_refuses() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
        // Ensure this test cannot observe a real operator's AppData secrets
        // through a shared temp-path collision.
        let _ = fs::remove_file(dir.join("secrets.dat"));
        let err = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap_err();
        assert!(err.to_string().contains("db-meta.json"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_meta_adopts_when_secrets_present() {
        let dir = scratch();
        let pgdata = dir.join("pgdata");
        fs::create_dir_all(&pgdata).unwrap();
        fs::write(pgdata.join("PG_VERSION"), "16\n").unwrap();
        fs::write(dir.join("secrets.dat"), b"legacy").unwrap();
        let d = evaluate_existing_cluster(&dir, &pgdata, "id-a", 16, 63).unwrap();
        assert!(matches!(d, ClusterDecision::Reuse));
        let meta = read_meta(&dir).unwrap().unwrap();
        assert_eq!(meta.installation_id, "id-a");
        let _ = fs::remove_dir_all(&dir);
    }
}
