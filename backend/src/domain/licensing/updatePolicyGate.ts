/**
 * Vendor Control Plane — update / release gate helpers.
 *
 * The license row carries `updatePolicy` (channel, allow_updates, minimum_version).
 * Publishing installer artifacts (latest.json / CDN) stays outside the ERP DB;
 * this module decides whether a given install may / must update.
 */

import type { UpdateChannel, UpdatePolicy } from "./license-metadata.js";

const DEFAULT_POLICY: UpdatePolicy = {
  channel: "stable",
  allow_updates: true,
  minimum_version: "0.0.0",
};

/** Compare dotted numeric versions (1.2.3). Non-numeric segments → 0. */
export function compareSemver(a: string, b: string): number {
  const pa = a
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((p) => parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
  const pb = b
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((p) => parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function normalizeUpdatePolicy(raw: unknown): UpdatePolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const o = raw as Record<string, unknown>;
  const channel = o.channel;
  return {
    channel:
      channel === "stable" || channel === "beta" || channel === "none"
        ? channel
        : DEFAULT_POLICY.channel,
    allow_updates: typeof o.allow_updates === "boolean" ? o.allow_updates : true,
    minimum_version:
      typeof o.minimum_version === "string" && o.minimum_version.trim()
        ? o.minimum_version.trim()
        : DEFAULT_POLICY.minimum_version,
  };
}

export type UpdateEligibility = {
  policy: UpdatePolicy;
  /** Vendor disabled updates or channel is none. */
  updatesAllowed: boolean;
  /** currentVersion < minimum_version — install is below licensed floor. */
  belowMinimum: boolean;
  /** Safe to offer optional updater when updatesAllowed && !belowMinimum force path. */
  mayCheckForUpdates: boolean;
  /** Soft guidance: force upgrade UX when below minimum. */
  forceUpgrade: boolean;
  reason: string;
};

/**
 * Evaluate whether this Installation may use the Tauri updater / must upgrade.
 * `preferredChannel` is the release channel the client asked for (optional).
 */
export function evaluateUpdateEligibility(
  currentVersion: string | null | undefined,
  policyInput: unknown,
  preferredChannel?: UpdateChannel | null,
): UpdateEligibility {
  const policy = normalizeUpdatePolicy(policyInput);
  const ver = (currentVersion ?? "").trim() || "0.0.0";

  if (policy.channel === "none" || !policy.allow_updates) {
    return {
      policy,
      updatesAllowed: false,
      belowMinimum: compareSemver(ver, policy.minimum_version) < 0,
      mayCheckForUpdates: false,
      forceUpgrade: compareSemver(ver, policy.minimum_version) < 0,
      reason: "التحديثات معطّلة في سياسة الترخيص",
    };
  }

  if (preferredChannel && preferredChannel !== "none" && preferredChannel !== policy.channel) {
    return {
      policy,
      updatesAllowed: false,
      belowMinimum: compareSemver(ver, policy.minimum_version) < 0,
      mayCheckForUpdates: false,
      forceUpgrade: compareSemver(ver, policy.minimum_version) < 0,
      reason: `قناة التحديث المسموحة: ${policy.channel}`,
    };
  }

  const belowMinimum = compareSemver(ver, policy.minimum_version) < 0;
  return {
    policy,
    updatesAllowed: true,
    belowMinimum,
    mayCheckForUpdates: true,
    forceUpgrade: belowMinimum,
    reason: belowMinimum
      ? `الإصدار الحالي أقل من الحد الأدنى المرخّص (${policy.minimum_version})`
      : "مسموح بالتحقق من التحديثات",
  };
}
