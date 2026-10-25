// Hub HTTP behaviour for the phone (FR-38, FR-40, contracts/hub-api.md). The shared sync client calls the global
// `fetch` itself, so the phone wraps `fetch` once: every request to /api/sync/push and /api/sync/pull carries
// X-Motard-Money-Version, and the answers that stop sync are classified into typed errors and reported to the sync loop.
import { MONEY_RULES_VERSION } from "@erp/shared";

export const MONEY_VERSION_HEADER = "X-Motard-Money-Version";

export class VersionMismatchError extends Error {
  constructor(
    readonly hubVersion: number | null,
    readonly clientVersion: number | null,
  ) {
    super("SYNC_VERSION_MISMATCH");
    this.name = "VersionMismatchError";
  }
}

export class DeviceRevokedError extends Error {
  constructor(message = "SYNC_DEVICE_REVOKED") {
    super(message);
    this.name = "DeviceRevokedError";
  }
}

export class UnknownDeviceError extends Error {
  constructor(message = "SYNC_UNKNOWN_DEVICE") {
    super(message);
    this.name = "UnknownDeviceError";
  }
}

export type HubSignal =
  | { kind: "versionMismatch"; error: VersionMismatchError }
  | { kind: "revoked"; error: DeviceRevokedError }
  | { kind: "unknownDevice"; error: UnknownDeviceError }
  | { kind: "serverDate"; date: Date };

/** Maps a hub answer to a typed error: 426 SYNC_VERSION_MISMATCH, 403 SYNC_DEVICE_REVOKED, 403 SYNC_UNKNOWN_DEVICE. */
export function classifyHubFailure(
  status: number,
  body: { code?: unknown; hubVersion?: unknown; clientVersion?: unknown } | null,
): VersionMismatchError | DeviceRevokedError | UnknownDeviceError | null {
  const code = typeof body?.code === "string" ? body.code : null;
  if (status === 426 && code === "SYNC_VERSION_MISMATCH") {
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return new VersionMismatchError(num(body?.hubVersion), num(body?.clientVersion));
  }
  if (status === 403 && code === "SYNC_DEVICE_REVOKED") return new DeviceRevokedError();
  if ((status === 403 || status === 401) && code === "SYNC_UNKNOWN_DEVICE") {
    return new UnknownDeviceError();
  }
  return null;
}

const SYNC_PATH = /\/api\/sync\/(push|pull)(\?|$)/;

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

export function createHubFetch(
  base: typeof fetch,
  onSignal: (signal: HubSignal) => void = () => undefined,
): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    let nextInit = init;
    if (SYNC_PATH.test(url)) {
      const headers = new Headers(init?.headers);
      headers.set(MONEY_VERSION_HEADER, String(MONEY_RULES_VERSION));
      nextInit = { ...init, headers };
    }
    const response = await base(input as RequestInfo, nextInit);
    const dateHeader = response.headers?.get?.("date");
    if (dateHeader) {
      const parsed = new Date(dateHeader);
      if (!Number.isNaN(parsed.getTime())) onSignal({ kind: "serverDate", date: parsed });
    }
    if (response.status === 426 || response.status === 403 || response.status === 401) {
      let body: Parameters<typeof classifyHubFailure>[1] = null;
      try {
        body = (await response.clone().json()) as typeof body;
      } catch {
        body = null;
      }
      const typed = classifyHubFailure(response.status, body);
      if (typed instanceof VersionMismatchError)
        onSignal({ kind: "versionMismatch", error: typed });
      else if (typed instanceof DeviceRevokedError) onSignal({ kind: "revoked", error: typed });
      else if (typed instanceof UnknownDeviceError)
        onSignal({ kind: "unknownDevice", error: typed });
    }
    return response;
  };
}

let installed: typeof fetch | null = null;
let original: typeof fetch | null = null;

/** Wraps the global fetch once; returns a function that restores it. */
export function installHubFetch(onSignal: (signal: HubSignal) => void): () => void {
  if (installed) return () => undefined;
  original = globalThis.fetch;
  installed = createHubFetch(original, onSignal);
  globalThis.fetch = installed;
  return () => {
    if (original) globalThis.fetch = original;
    installed = null;
    original = null;
  };
}
