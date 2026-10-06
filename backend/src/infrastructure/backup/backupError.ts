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
      | "RESTORE_FAILED",
    message: string,
  ) {
    super(message);
  }
}
