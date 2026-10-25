// Enrolment (FR-06, FR-08): exchange the company's enrolment code for this phone's own sync identity on the hub, then
// fix the tenant locally. The hub exchange is the desktop's own `enrollHub` (POST /api/sync/enroll; the device credential
// it returns is kept encrypted and later traded for tokens through POST /api/sync/device-token by the shared
// hubConfig code), so a phone is enrolled exactly like a desktop.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  enrollHub,
  setRuntimeCentralSyncUrl,
  rememberLocalSyncIdentity,
} from "@backend/application/use-cases/sync/hubConfig";
import { runInTransaction } from "@backend/infrastructure/orm/sqlite/transaction";
import { buildPhoneRepositories } from "./container";
import { applyPhoneConfig } from "../platform/envConfig";
import { ensureMeta, type PhoneRuntime } from "./runtime";
import { getSecret, setSecret } from "../platform/secureStore";
import type { PhoneIdentity, PhoneUser } from "./phone";

export class EnrollmentRefusedError extends Error {
  constructor(
    message: string,
    readonly stage: "url" | "reach" | "login" | "role" | "local",
  ) {
    super(message);
    this.name = "EnrollmentRefusedError";
  }
}

export interface StoredEnrollment {
  hubUrl: string;
  tenantId: string;
  syncDeviceId: string;
  user: PhoneUser;
  installationId: string;
  /** False until the first download finished (FR-07). */
  firstDownloadDone: boolean;
}

const ENROLLMENT_KEY = "enrollment";

export async function loadEnrollment(): Promise<StoredEnrollment | null> {
  const raw = await getSecret(ENROLLMENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredEnrollment;
  } catch {
    return null;
  }
}

export async function saveEnrollment(enrollment: StoredEnrollment): Promise<void> {
  await setSecret(ENROLLMENT_KEY, JSON.stringify(enrollment));
}

export function toIdentity(enrollment: StoredEnrollment): PhoneIdentity {
  return {
    tenantId: enrollment.tenantId,
    syncDeviceId: enrollment.syncDeviceId,
    user: enrollment.user,
  };
}

/** Points the shared hub code at the enrolled hub (after a restart, from the stored enrolment). */
export function applyEnrollmentToHubConfig(enrollment: StoredEnrollment): void {
  applyPhoneConfig({
    CENTRAL_SYNC_URL: enrollment.hubUrl,
    MOTARD_INSTALLATION_ID: enrollment.installationId,
  });
  setRuntimeCentralSyncUrl(enrollment.hubUrl);
}

export async function enroll(
  runtime: PhoneRuntime,
  conn: Parameters<typeof ensureMeta>[0],
  input: { hubUrl: string; code: string; appVersion?: string },
): Promise<StoredEnrollment> {
  const deviceId = randomUUID();
  const installationId = randomUUID();
  const result = await enrollHub({
    url: input.hubUrl,
    code: input.code.trim(),
    device: {
      id: deviceId,
      fingerprint: `phone-${installationId}`,
      fingerprintVersion: 1,
      platform: "android",
      hostname: "phone",
      label: "phone",
    },
    local: { tenantId: "", userId: "" },
  });
  if (!result.ok) throw new EnrollmentRefusedError(result.error, result.stage);
  const info = result.info;
  if (!info.hubTenantId || !info.hubUserId) {
    throw new EnrollmentRefusedError("ردّ المركز ناقص: لا يوجد معرّف الشركة", "login");
  }
  const user: PhoneUser = {
    id: info.hubUserId,
    name: info.hubUserName ?? "المدير",
    role: (info.hubUserRole as PhoneUser["role"] | undefined) ?? "admin",
  };
  const tenantId = info.hubTenantId;
  rememberLocalSyncIdentity(tenantId, user.id);

  // The phone's tenant is the hub's company, fixed for the life of the database (FR-08).
  await runInTransaction(async (tx) => {
    await tx.execute(
      sql`INSERT OR IGNORE INTO tenants (id, name, slug, status, license_status, license_type)
          VALUES (${tenantId}, 'الشركة', ${`phone-${tenantId.slice(0, 8)}`}, 'active', 'active', 'perpetual')`,
    );
    await tx.execute(
      sql`INSERT OR IGNORE INTO users (id, tenant_id, name, email, password_hash, role, active)
          VALUES (${user.id}, ${tenantId}, ${user.name}, ${`${user.id}@device.local`}, 'not-used-on-device', ${user.role}, 1)`,
    );
  });
  ensureMeta(conn, {
    tenantId,
    installationId,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  });
  const repos = buildPhoneRepositories();
  await repos.syncDeviceRepo.registerOrTouch({
    tenantId: tenantId as never,
    userId: user.id as never,
    deviceFingerprint: `phone-${installationId}`,
    deviceFingerprintVersion: 1,
    platform: "android",
    hostname: "phone",
    label: "phone",
    deviceId: deviceId as never,
  });

  const enrollment: StoredEnrollment = {
    hubUrl: info.hubUrl ?? input.hubUrl,
    tenantId,
    syncDeviceId: deviceId,
    user,
    installationId,
    firstDownloadDone: false,
  };
  await saveEnrollment(enrollment);
  applyEnrollmentToHubConfig(enrollment);
  return enrollment;
}
