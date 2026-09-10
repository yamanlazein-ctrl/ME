import type { UUID } from "../../domain/types/index.js";

export interface SyncDeviceRow {
  id: UUID;
  tenantId: UUID;
  lastSeenByUserId: UUID | null;
  deviceFingerprint: string;
  deviceFingerprintVersion: number;
  platform: string;
  hostname: string | null;
  label: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IRegisterSyncDeviceInput {
  tenantId: UUID;
  userId: UUID;
  deviceFingerprint: string;
  deviceFingerprintVersion?: number;
  platform: string;
  hostname?: string | null;
  label?: string | null;
}

export interface ISyncDeviceRepository {
  registerOrTouch(input: IRegisterSyncDeviceInput): Promise<SyncDeviceRow>;
}
