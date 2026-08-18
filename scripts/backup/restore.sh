#!/usr/bin/env bash
# ============================================================================
# PostgreSQL Restore Script — ERP Fabric
# ============================================================================
# Usage: ./restore.sh <backup_file.sql.gz> [target_database_url]
# 
# WARNING: This DESTROYS and recreates the target database. Use on test first.
# ============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_URL="${2:-${DATABASE_URL:-}}"

if [ -z "${BACKUP_FILE}" ] || [ -z "${TARGET_URL}" ]; then
  echo "Usage: ./restore.sh <backup_file.sql.gz> [target_database_url]"
  echo ""
  echo "Example:"
  echo "  ./restore.sh backups/daily/erp_backup_daily_20260815_030000.sql.gz"
  echo "  ./restore.sh backup.sql.gz postgres://user:pass@localhost:5432/erp_test"
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

# Extract database name from URL for warning
DB_NAME=$(echo "${TARGET_URL}" | sed -n 's/.*\/\([^?]*\).*/\1/p')

echo "WARNING: This will DESTROY and recreate database: ${DB_NAME}"
echo "Backup file: ${BACKUP_FILE}"
echo ""
read -p "Are you sure? Type 'yes' to continue: " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

START_TIME=$(date +%s)

echo "Restoring..."
gunzip -c "${BACKUP_FILE}" | psql "${TARGET_URL}"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "Restore completed in ${DURATION}s"
echo "Verify: SELECT COUNT(*) FROM invoices;"
echo "Verify: SELECT COUNT(*) FROM ledger_entries;"
