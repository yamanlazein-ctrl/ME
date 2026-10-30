// The in-app update check of the direct-APK channel (FR-43, BC-5): at most once a day, ask the hub's public manifest
// `GET /api/mobile/version` and offer the download when `latestVersionCode` is greater than this app's. A failed check is
// silent: the phone works the same, and the next check is tried on the next start.

export interface VersionManifest {
  minVersionCode: number;
  latestVersionCode: number;
  latestVersionName: string;
  apkUrl: string;
  apkSha256: string;
  moneyRulesVersion: number;
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type Channel = "play" | "apk";

/** True when no check was made yet or the last one is a day old or more (a clock that went back counts as due). */
export function isCheckDue(lastCheckAt: string | null, now: Date): boolean {
  if (!lastCheckAt) return true;
  const last = Date.parse(lastCheckAt);
  if (!Number.isFinite(last)) return true;
  const elapsed = now.getTime() - last;
  return elapsed >= CHECK_INTERVAL_MS || elapsed < 0;
}

export interface UpdateOffer {
  versionName: string;
  apkUrl: string;
  apkSha256: string;
  /** This build is below the hub's minimum: updating is required, not optional. */
  required: boolean;
}

export function offerFor(
  manifest: VersionManifest,
  currentVersionCode: number,
): UpdateOffer | null {
  if (!(manifest.latestVersionCode > currentVersionCode)) return null;
  return {
    versionName: manifest.latestVersionName,
    apkUrl: manifest.apkUrl,
    apkSha256: manifest.apkSha256,
    required: currentVersionCode < manifest.minVersionCode,
  };
}

function isManifest(v: unknown): v is VersionManifest {
  const m = v as Partial<VersionManifest> | null;
  return (
    !!m &&
    Number.isInteger(m.minVersionCode) &&
    Number.isInteger(m.latestVersionCode) &&
    typeof m.latestVersionName === "string" &&
    typeof m.apkUrl === "string" &&
    m.apkUrl.length > 0 &&
    typeof m.apkSha256 === "string"
  );
}

export interface CheckDeps {
  fetch: typeof fetch;
  now(): Date;
}

export interface CheckResult {
  /** False when the check was skipped (Play channel, not due) or failed. */
  checked: boolean;
  offer: UpdateOffer | null;
}

export async function checkForUpdate(
  args: {
    channel: Channel;
    hubUrl: string;
    currentVersionCode: number;
    lastCheckAt: string | null;
  },
  deps: CheckDeps,
): Promise<CheckResult> {
  if (args.channel !== "apk" || !args.hubUrl || !isCheckDue(args.lastCheckAt, deps.now())) {
    return { checked: false, offer: null };
  }
  try {
    const res = await deps.fetch(`${args.hubUrl.replace(/\/+$/, "")}/api/mobile/version`);
    // 404 = the hub publishes no manifest: that is an answer, not a failure (the day's check is done).
    if (res.status === 404) return { checked: true, offer: null };
    if (!res.ok) return { checked: false, offer: null };
    const body: unknown = await res.json();
    if (!isManifest(body)) return { checked: false, offer: null };
    return { checked: true, offer: offerFor(body, args.currentVersionCode) };
  } catch {
    return { checked: false, offer: null };
  }
}
