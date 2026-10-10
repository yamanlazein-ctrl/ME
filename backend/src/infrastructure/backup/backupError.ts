/** Errors of the backup/restore HTTP surface (both formats). Moved from portableBackup.ts. */
export class BackupError extends Error {
  constructor(
    readonly code:
      | "BACKUP_CORRUPT"
      | "BACKUP_UNSUPPORTED_FORMAT"
      | "BACKUP_NEWER_THAN_APP"
      | "BACKUP_SCHEMA_MISMATCH"
      | "RESTORE_CONFIRM_REQUIRED"
      | "RESTORE_VERIFY_FAILED"
      | "RESTORE_FAILED"
      // Desktop path-based verify/restore (receiveShellPath + v3 archive
      // verification). Each maps to its own actionable Arabic message in
      // sendBackupError instead of one generic BACKUP_CORRUPT.
      | "BACKUP_FILE_MISSING"
      | "BACKUP_FILE_HASH_MISMATCH"
      | "BACKUP_NO_FILE_RECEIVED"
      | "BACKUP_NOT_A_ZIP"
      | "BACKUP_MANIFEST_MISSING"
      | "BACKUP_MANIFEST_HASH_MISMATCH"
      | "BACKUP_DATABASE_MISSING"
      | "BACKUP_INTEGRITY_FAILED"
      | "BACKUP_FOREIGN_KEYS_FAILED"
      | "BACKUP_TABLE_MISMATCH"
      // Refusals that mapBackupError re-maps before constructing a BackupError
      // (BACKUP_POSTGRES_ERA / BACKUP_FORMAT_UNKNOWN / BACKUP_SCHEMA_NEWER_THAN_APP
      // / BACKUP_CREATE_FAILED) still need to be assignable here so the v3
      // error union can flow through the passthrough branch.
      | "BACKUP_CREATE_FAILED",
    message: string,
  ) {
    super(message);
  }
}
