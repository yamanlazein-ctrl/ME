/**
 * BC-5 (specs/002-mobile-app): the version manifest of the direct-APK channel. No authentication: a phone that is not yet
 * signed in, or that the hub refuses for an old money-rules version (FR-38), must still be able to learn that it has to
 * update. The values come from the environment; when they are not set the route answers 404 MOBILE_VERSION_NOT_CONFIGURED.
 */
import type { Router } from "express";
import { MONEY_RULES_VERSION } from "@erp/shared";

type Env = Record<string, string | undefined>;

export interface MobileVersionManifest {
  minVersionCode: number;
  latestVersionCode: number;
  latestVersionName: string;
  apkUrl: string;
  apkSha256: string;
  moneyRulesVersion: number;
}

/** The manifest from the environment, or null when any value is missing or malformed. */
export function readMobileVersionManifest(env: Env = process.env): MobileVersionManifest | null {
  const min = Number(env.MOBILE_MIN_VERSION_CODE);
  const latest = Number(env.MOBILE_LATEST_VERSION_CODE);
  const name = env.MOBILE_LATEST_VERSION_NAME?.trim();
  const apkUrl = env.MOBILE_APK_URL?.trim();
  const sha = env.MOBILE_APK_SHA256?.trim().toLowerCase();
  if (!Number.isInteger(min) || min < 0 || !Number.isInteger(latest) || latest < min) return null;
  if (!name || !apkUrl || !sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return {
    minVersionCode: min,
    latestVersionCode: latest,
    latestVersionName: name,
    apkUrl,
    apkSha256: sha,
    moneyRulesVersion: MONEY_RULES_VERSION,
  };
}

export function registerMobileVersionRoute(router: Router, env: Env = process.env): void {
  router.get("/api/mobile/version", (_req, res) => {
    const manifest = readMobileVersionManifest(env);
    if (!manifest) {
      return res.status(404).json({
        code: "MOBILE_VERSION_NOT_CONFIGURED",
        message: "لم يُضبط إصدار التطبيق على هذا المركز",
        statusCode: 404,
      });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(manifest);
  });
}
