// Frozen phone configuration built from the enrolment (FR-08). It never reads `process.env`.
import Constants from "expo-constants";

export interface Enrollment {
  hubUrl: string;
  tenantId: string;
  syncDeviceId: string;
}

export interface PhoneConfig {
  readonly hubUrl: string;
  readonly tenantId: string;
  readonly syncDeviceId: string;
  readonly deviceKind: "phone";
  readonly appVersion: string;
}

/** This build's version, as built (scripts/build-version.cjs): shown in «المزيد», sent at enrolment, compared by the
 * update check. */
export function appVersionInfo(): { version: string; versionCode: number } {
  return {
    version: Constants.expoConfig?.version ?? "0.0.0",
    versionCode: Number(Constants.expoConfig?.android?.versionCode ?? 1),
  };
}

export function buildConfig(enrollment: Enrollment, appVersion?: string): PhoneConfig {
  return Object.freeze({
    hubUrl: enrollment.hubUrl.replace(/\/+$/, ""),
    tenantId: enrollment.tenantId,
    syncDeviceId: enrollment.syncDeviceId,
    deviceKind: "phone" as const,
    appVersion: appVersion ?? appVersionInfo().version,
  });
}
