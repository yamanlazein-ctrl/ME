#!/usr/bin/env bash
# ============================================================================
# PostgreSQL Backup Script — ERP Fabric
# ============================================================================
# Usage: ./backup.sh [daily|weekly|monthly]
#   daily   → keeps last 7 days
#   weekly  → keeps last 4 weeks
#   monthly → keeps last 12 months
#
# Requirements: pg_dump, gzip, rclone (optional cloud upload)
# Environment:  DATABASE_URL from env or .env (safe key=value parse)
#
# DFP-028: no `export $(xargs)` dotenv, no destructive rclone sync by default,
# verify via gunzip + SQL markers (optional isolated restore when VERIFY_RESTORE=1).
# ============================================================================

set -euo pipefail

BACKUP_BASE="${BACKUP_DIR:-./backups}"
S3_REMOTE="${S3_REMOTE:-}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
VERIFY_RESTORE="${VERIFY_RESTORE:-0}"
# Destructive remote delete is opt-in only (DFP-028).
BACKUP_ALLOW_RCLONE_SYNC="${BACKUP_ALLOW_RCLONE_SYNC:-0}"

TYPE="${1:-daily}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATE=$(date +%Y-%m-%d)

BACKUP_DIR="${BACKUP_BASE}/${TYPE}"
mkdir -p "${BACKUP_DIR}"

LOG_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.log"
exec >> "${LOG_FILE}" 2>&1

echo "========================================"
echo "Backup started: ${TIMESTAMP}"
echo "Type: ${TYPE}"
echo "========================================"

load_dotenv() {
  local file="$1"
  [ -f "$file" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    case "$key" in
      *[!\$_a-zA-Z0-9]*|"") continue ;;
    esac
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    # Only fill missing vars — never overwrite an already-exported secret.
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$file"
}

if ! command -v pg_dump &> /dev/null; then
  echo "ERROR: pg_dump not found. Install postgresql-client."
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  load_dotenv "../.env"
  load_dotenv ".env"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in .env"
  exit 1
fi

# Redact password in logs (never print full URL).
echo "Database URL: ${DATABASE_URL//:*@/:***@}"

DUMP_FILE="${BACKUP_DIR}/erp_backup_${TYPE}_${TIMESTAMP}.sql.gz"
START_TIME=$(date +%s)

pg_dump \
  --dbname="${DATABASE_URL}" \
  --verbose \
  --no-owner \
  --no-privileges \
  --format=plain \
  | gzip -9 > "${DUMP_FILE}"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
SIZE=$(du -h "${DUMP_FILE}" | cut -f1)

echo "Backup created: ${DUMP_FILE}"
echo "Duration: ${DURATION}s"
echo "Size: ${SIZE}"

echo "Verifying backup integrity..."
if ! gzip -t "${DUMP_FILE}"; then
  echo "ERROR: Backup verification FAILED — gzip integrity check failed"
  exit 1
fi

CREATE_COUNT=$(gunzip -c "${DUMP_FILE}" | grep -c '^CREATE TABLE' || true)
if [ "${CREATE_COUNT}" -lt 1 ]; then
  echo "ERROR: Backup verification FAILED — no CREATE TABLE statements found"
  exit 1
fi
echo "Backup verification: PASSED (gzip ok, ${CREATE_COUNT} CREATE TABLE statements)"

if [ "${VERIFY_RESTORE}" = "1" ] && command -v psql &> /dev/null && command -v createdb &> /dev/null; then
  TEST_DB="erp_backup_verify_${TIMESTAMP}"
  echo "VERIFY_RESTORE=1 — restoring into isolated database ${TEST_DB}"
  ADMIN_URL="${DATABASE_URL%/*}/postgres"
  createdb --maintenance-db="${ADMIN_URL}" "${TEST_DB}"
  VERIFY_URL="${DATABASE_URL%/*}/${TEST_DB}"
  if ! gunzip -c "${DUMP_FILE}" | psql --set ON_ERROR_STOP=1 "${VERIFY_URL}" > /dev/null; then
    dropdb --maintenance-db="${ADMIN_URL}" "${TEST_DB}" || true
    echo "ERROR: isolated restore verification FAILED"
    exit 1
  fi
  dropdb --maintenance-db="${ADMIN_URL}" "${TEST_DB}"
  echo "Isolated restore verification: PASSED"
fi

if command -v rclone &> /dev/null && [ -n "${S3_REMOTE}" ]; then
  REMOTE_PATH="${S3_REMOTE}/${TYPE}/"
  if [ "${BACKUP_ALLOW_RCLONE_SYNC}" = "1" ]; then
    echo "WARNING: BACKUP_ALLOW_RCLONE_SYNC=1 — using rclone sync (can delete remote files)"
    rclone sync "${BACKUP_DIR}" "${REMOTE_PATH}" \
      --checksum \
      --transfers=4 \
      --checkers=8 \
      --no-update-modtime \
      --backup-dir="${S3_REMOTE}/archive/${TYPE}_${DATE}"
  else
    echo "Uploading with rclone copy (non-destructive; set BACKUP_ALLOW_RCLONE_SYNC=1 for sync)"
    rclone copy "${BACKUP_DIR}" "${REMOTE_PATH}" \
      --checksum \
      --transfers=4 \
      --checkers=8 \
      --no-update-modtime
  fi
  echo "S3 upload: COMPLETED"
else
  echo "S3 upload: SKIPPED (rclone not configured or S3_REMOTE empty)"
fi

case "${TYPE}" in
  daily)
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +7 -delete
    echo "Cleaned backups older than 7 days"
    ;;
  weekly)
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +28 -delete
    echo "Cleaned backups older than 28 days"
    ;;
  monthly)
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +365 -delete
    echo "Cleaned backups older than 365 days"
    ;;
esac

TOTAL_SIZE=$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)
BACKUP_COUNT=$(find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" | wc -l)

echo "========================================"
echo "Backup summary:"
echo "  File: ${DUMP_FILE}"
echo "  Size: ${SIZE}"
echo "  Duration: ${DURATION}s"
echo "  Directory total: ${TOTAL_SIZE} (${BACKUP_COUNT} backups)"
echo "  Status: SUCCESS"
echo "========================================"

SUMMARY="ERP Backup: ${TYPE} | ${SIZE} | ${DURATION}s | ${BACKUP_COUNT} retained"

if [ -n "${SLACK_WEBHOOK}" ]; then
  curl -s -X POST "${SLACK_WEBHOOK}" \
    -H 'Content-type: application/json' \
    -d "{\"text\":\"${SUMMARY}\"}" > /dev/null || true
fi

if [ -n "${NOTIFY_EMAIL}" ] && command -v mail &> /dev/null; then
  echo "${SUMMARY}" | mail -s "ERP Backup: ${TYPE} — ${DATE}" "${NOTIFY_EMAIL}" || true
fi

exit 0
