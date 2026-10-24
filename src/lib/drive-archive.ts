/**
 * Google Drive archive — frontend API client (settings screen).
 *
 * Same transport conventions as sync-engine: base-URL aware, bearer token,
 * Arabic error messages from the typed backend codes. Drive-specific IPC
 * (connect/start/finish) goes through the Tauri shell — refresh tokens never
 * pass through here or anywhere in the webview.
 */
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getInvoke, isTauri } from "@/infrastructure/tauri-bridge";

async function driveApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message || `فشل الطلب (${res.status})`);
  return body;
}

export type DriveStatus = {
  archiveEnabled: boolean;
  isPrimaryDevice: boolean;
  coordinatorDeviceId: string | null;
  /** This installation's archive device id — what the primary designation names. */
  localDeviceId: string | null;
  connected: boolean;
  queue: { pending: number; uploading: number; done: number; failed: number; blocked: number };
  lastUpload: { uploadedAt: string | null; fileName: string; section: string } | null;
  lastRun: {
    id: string;
    kind: string;
    state: string;
    startedAt: string;
    finishedAt: string | null;
  } | null;
};

export type DriveQueueJob = {
  id: string;
  entityType: string;
  periodKey: string;
  section: string;
  fileName: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  uploadedAt: string | null;
  createdAt: string;
};

/** The progress of one archive run. */
export type DriveRunProgress = {
  state: "running" | "done" | "failed" | "partial" | "cancelled";
  progressDone: number;
  progressTotal: number;
  percent: number;
  currentFile: string | null;
  errors: string[];
  /** The period this run archives (`YYYY-MM`), when the run has finished. */
  periodKey?: string | null;
  trigger?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
};

/**
 * The answer to "start an archive run". The run continues in the BACKGROUND — the client polls
 * `runProgress(runId)` and can cancel it. `skipped` says why nothing was started (busy, not
 * connected, not the coordinator, nothing to do) instead of the client guessing.
 */
export type DriveRunStarted = {
  ok: boolean;
  runId: string | null;
  skipped: string | null;
};

export const driveApi_ = {
  status: () => driveApi<DriveStatus>("/drive/status"),
  test: () => driveApi<{ ok: boolean; email: string | null }>("/drive/test", { method: "POST" }),
  /** Start a run in the background; the answer carries the run id to poll. */
  startRun: (
    opts: { trigger?: "monthly" | "catchup" | "manual" | "connect"; periodKey?: string } = {},
  ) =>
    driveApi<DriveRunStarted>("/drive/archive/runs", {
      method: "POST",
      body: JSON.stringify(opts),
    }),
  /** The legacy alias of `startRun`. */
  syncNow: () =>
    driveApi<DriveRunStarted>("/drive/sync-now", {
      method: "POST",
    }),
  /** The progress of one run. */
  runProgress: (runId: string) =>
    driveApi<DriveRunProgress>(`/drive/archive/runs/${encodeURIComponent(runId)}`),
  /** Ask a running run to stop after its current file. */
  cancelRun: (runId: string) =>
    driveApi<{ ok: boolean }>(`/drive/archive/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    }),
  queue: (status?: string) =>
    driveApi<{ jobs: DriveQueueJob[] }>(
      `/drive/queue${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  retry: (id: string) =>
    driveApi<{ ok: boolean }>(`/drive/queue/${encodeURIComponent(id)}/retry`, { method: "POST" }),
};

// ── Tauri shell IPC (OAuth lifecycle lives in Rust) ─────────────────────────

export type GoogleShellStatus = {
  connected: boolean;
  /** An OAuth client is available: bundled into the release build, or an advanced override. */
  configured: boolean;
  /** Where the client comes from. `null` when no client is available at all. */
  source: "bundled" | "override" | null;
  email: string | null;
  scopes: string;
};

/**
 * The company's own Google OAuth client ("Desktop app" type). Google issues a client secret for that
 * type, which its token endpoint expects; it is optional here for clients that have none. Both are
 * sealed by the shell (DPAPI) and never come back to the page.
 */
export async function googleConfigure(
  clientId: string,
  clientSecret?: string,
): Promise<GoogleShellStatus> {
  if (!isTauri()) throw new Error("متاح في تطبيق سطح المكتب فقط");
  const invoke = await getInvoke();
  return (await invoke("google_configure_cmd", {
    clientId,
    clientSecret: clientSecret?.trim() ? clientSecret.trim() : null,
  })) as GoogleShellStatus;
}

export async function googleShellStatus(): Promise<GoogleShellStatus> {
  if (!isTauri()) throw new Error("متاح في تطبيق سطح المكتب فقط");
  const invoke = await getInvoke();
  return (await invoke("google_status_cmd")) as GoogleShellStatus;
}

/** The shell opens the consent URL in the system browser (the webview cannot navigate away). */
export async function googleConnectStart(): Promise<{ consentUrl: string; state: string }> {
  if (!isTauri()) throw new Error("متاح في تطبيق سطح المكتب فقط");
  const invoke = await getInvoke();
  return (await invoke("google_connect_start_cmd")) as { consentUrl: string; state: string };
}

/** Blocks until the user finishes consent in the browser (or timeout). */
export async function googleConnectFinish(): Promise<GoogleShellStatus> {
  if (!isTauri()) throw new Error("متاح في تطبيق سطح المكتب فقط");
  const invoke = await getInvoke();
  return (await invoke("google_connect_finish_cmd")) as GoogleShellStatus;
}

export async function googleDisconnect(): Promise<GoogleShellStatus> {
  if (!isTauri()) throw new Error("متاح في تطبيق سطح المكتب فقط");
  const invoke = await getInvoke();
  return (await invoke("google_disconnect_cmd")) as GoogleShellStatus;
}
