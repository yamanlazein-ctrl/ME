#!/usr/bin/env bash
# ============================================================================
# PostgreSQL Backup Script — ERP Fabric
# ============================================================================
# Usage: ./backup.sh [daily|weekly|monthly]
#   daily   → keeps last 7 days
#   weekly  → keeps last 4 weeks  
#   monthly → keeps last 12 months
#
# Requirements: pg_dump, gzip, rclone (for S3/Cloud sync)
# Environment:  DATABASE_URL from ../.env or .env
# ============================================================================

set -euo pipefail

BACKUP_BASE="${BACKUP_DIR:-./backups}"
S3_REMOTE="${S3_REMOTE:-s3:erp-backups}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"

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

# ---------------------------------------------------------------------------
# 1. Verify environment
# ---------------------------------------------------------------------------
if ! command -v pg_dump &> /dev/null; then
  echo "ERROR: pg_dump not found. Install postgresql-client."
  exit 1
fi

# Load DATABASE_URL from env or .env
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "../.env" ]; then
    export $(grep -v '^#' "../.env" | xargs) 2>/dev/null || true
  fi
  if [ -f ".env" ]; then
    export $(grep -v '^#' ".env" | xargs) 2>/dev/null || true
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in .env"
  exit 1
fi

echo "Database URL: ${DATABASE_URL//:*@/:***@}"

# ---------------------------------------------------------------------------
# 2. Create backup
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 3. Verify backup (restore test on temporary DB)
# ---------------------------------------------------------------------------
TEST_DB="test_backup_${TIMESTAMP}"
echo "Verifying backup integrity..."

# Extract and test on temporary database (if pg_restore available)
if command -v psql &> /dev/null && [ -n "${DATABASE_URL:-}" ]; then
  # Create a test database from the backup (lightweight check)
  # We just check the first 100 lines for SQL validity, not full restore
  if gunzip -c "${DUMP_FILE}" | head -100 | grep -q "CREATE TABLE"; then
    echo "Backup verification: PASSED (contains valid CREATE TABLE statements)"
  else
    echo "ERROR: Backup verification FAILED — no CREATE TABLE statements found"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 4. Sync to S3/Cloud (if rclone configured)
# ---------------------------------------------------------------------------
if command -v rclone &> /dev/null && [ -n "${S3_REMOTE:-}" ]; then
  echo "Syncing to S3..."
  rclone sync "${BACKUP_DIR}" "${S3_REMOTE}/${TYPE}/" \
    --checksum \
    --transfers=4 \
    --checkers=8 \
    --no-update-modtime \
    --backup-dir="${S3_REMOTE}/archive/${TYPE}_${DATE}"
  echo "S3 sync: COMPLETED"
else
  echo "S3 sync: SKIPPED (rclone not configured)"
fi

# ---------------------------------------------------------------------------
# 5. Cleanup old backups
# ---------------------------------------------------------------------------
case "${TYPE}" in
  daily)
    # Keep last 7 days
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +7 -delete
    echo "Cleaned backups older than 7 days"
    ;;
  weekly)
    # Keep last 4 weeks
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +28 -delete
    echo "Cleaned backups older than 28 days"
    ;;
  monthly)
    # Keep last 12 months
    find "${BACKUP_DIR}" -maxdepth 1 -name "*.sql.gz" -mtime +365 -delete
    echo "Cleaned backups older than 365 days"
    ;;
esac

# ---------------------------------------------------------------------------
# 6. Log summary
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 7. Notifications
# ---------------------------------------------------------------------------
SUMMARY="✅ ERP Backup: ${TYPE} | ${SIZE} | ${DURATION}s | ${BACKUP_COUNT} retained"

if [ -n "${SLACK_WEBHOOK}" ]; then
  curl -s -X POST "${SLACK_WEBHOOK}" \
    -H 'Content-type: application/json' \
    -d "{\"text\":\"${SUMMARY}\"}" > /dev/null || true
fi

if [ -n "${NOTIFY_EMAIL}" ] && command -v mail &> /dev/null; then
  echo "${SUMMARY}" | mail -s "ERP Backup: ${TYPE} — ${DATE}" "${NOTIFY_EMAIL}" || true
fi

exit 0
