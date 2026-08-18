import type { EndpointMeta, ApiError } from "./_shared";

export interface BackupInfo {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string;
  status: "completed" | "failed" | "in_progress";
}

export type ListBackupsResponse = BackupInfo[];
export type ListBackupsError = ApiError;
export const ListBackupsEndpoint: EndpointMeta = {
  path: "/api/backups",
  method: "GET",
  auth: { required: true, roles: ["admin"] },
  description: "List all database backups",
};

export type CreateBackupResponse = BackupInfo;
export type CreateBackupError = ApiError & { code: "BACKUP_FAILED" };
export const CreateBackupEndpoint: EndpointMeta = {
  path: "/api/backups",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Create a new database backup",
};

export type GetBackupResponse = BackupInfo;
export type GetBackupError = ApiError & { code: "NOT_FOUND" };
export const GetBackupEndpoint: EndpointMeta = {
  path: "/api/backups/:id",
  method: "GET",
  auth: { required: true, roles: ["admin"] },
  description: "Get backup info by ID",
};

export interface RestoreBackupRequest {
  id: string;
}
export type RestoreBackupResponse = { success: boolean; message: string };
export type RestoreBackupError = ApiError & { code: "NOT_FOUND" | "RESTORE_FAILED" };
export const RestoreBackupEndpoint: EndpointMeta = {
  path: "/api/backups/:id/restore",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Restore database from a backup",
};

export type DeleteBackupError = ApiError & { code: "NOT_FOUND" };
export const DeleteBackupEndpoint: EndpointMeta = {
  path: "/api/backups/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a backup file",
};

export type DownloadBackupError = ApiError & { code: "NOT_FOUND" };
export const DownloadBackupEndpoint: EndpointMeta = {
  path: "/api/backups/:id/download",
  method: "GET",
  auth: { required: true, roles: ["admin"] },
  description: "Download backup file (binary)",
};
