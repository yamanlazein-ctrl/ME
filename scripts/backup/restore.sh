#!/usr/bin/env bash
# ============================================================================
# PostgreSQL Restore Script — ERP Fabric
# ============================================================================
# Usage:
#   ./restore.sh <backup_file.sql.gz> <target_database_url>
#
# DFP-028 safeguards:
#   - target URL is REQUIRED (no silent DATABASE_URL fallback to production)
#   - refuses well-known production DB names unless RESTORE_ALLOW_PRODUCTION=1
#   - confirmation must be typed OR RESTORE_CONFIRM=yes in non-interactive CI
#   - psql runs with ON_ERROR_STOP=1
# ============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"
TARGET_URL="${2:-}"
RESTORE_CONFIRM="${RESTORE_CONFIRM:-}"
RESTORE_ALLOW_PRODUCTION="${RESTORE_ALLOW_PRODUCTION:-0}"

if [ -z "${BACKUP_FILE}" ] || [ -z "${TARGET_URL}" ]; then
  echo "Usage: ./restore.sh <backup_file.sql.gz> <target_database_url>"
  echo ""
  echo "Example:"
  echo "  ./restore.sh backups/daily/erp_backup_daily_20260815_030000.sql.gz \\"
  echo "    postgres://user:pass@localhost:5432/erp_restore_test"
  echo ""
  echo "Non-interactive: RESTORE_CONFIRM=yes ./restore.sh <file> <url>"
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

if ! gzip -t "${BACKUP_FILE}"; then
  echo "ERROR: Backup file failed gzip integrity check"
  exit 1
fi

DB_NAME=$(echo "${TARGET_URL}" | sed -n 's/.*\/\([^?]*\).*/\1/p')
case "${DB_NAME}" in
  erp|fabric_erp|production|prod)
    if [ "${RESTORE_ALLOW_PRODUCTION}" != "1" ]; then
      echo "ERROR: refusing restore into production-like database '${DB_NAME}'."
      echo "Use a disposable DB name, or set RESTORE_ALLOW_PRODUCTION=1 explicitly."
      exit 1
    fi
    ;;
esac

echo "WARNING: This will apply SQL into database: ${DB_NAME}"
echo "Backup file: ${BACKUP_FILE}"
echo ""

if [ "${RESTORE_CONFIRM}" = "yes" ]; then
  echo "RESTORE_CONFIRM=yes — continuing without interactive prompt"
else
  read -r -p "Are you sure? Type 'yes' to continue: " CONFIRM
  if [ "${CONFIRM}" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
fi

START_TIME=$(date +%s)

echo "Restoring with ON_ERROR_STOP=1..."
gunzip -c "${BACKUP_FILE}" | psql --set ON_ERROR_STOP=1 "${TARGET_URL}"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "Restore completed in ${DURATION}s"
echo "Verify: SELECT COUNT(*) FROM invoices;"
echo "Verify: SELECT COUNT(*) FROM ledger_entries;"
