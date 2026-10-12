/**
 * Thin Google Drive v3 client. ALL Drive I/O goes through this module so the
 * queue worker and folder organizer can be tested with a mocked `DriveClient`.
 *
 * Auth: the caller supplies a bearer access token per call via `token()`. The
 * token is minted/refreshed by the Rust shell and pushed to this process
 * (`setLiveDriveToken`, below) — NEVER logged; `redact()` strips credentials
 * from any error dump.
 *
 * Retry policy: 5xx / 429 / 403-with-rate-limit-reason are retried with
 * bounded exponential backoff; 4xx otherwise are surfaced as typed errors
 * (auth failures as `DriveAuthError`, everything else as `DriveError`).
 */

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`DRIVE_${code} (${status}): ${message}`);
    this.name = "DriveError";
  }
}

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(`DRIVE_AUTH: ${message}`);
    this.name = "DriveAuthError";
  }
}

export type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
};

export type TokenProvider = () => Promise<string>;

export type DriveClientOptions = {
  token: TokenProvider;
  /** Base URL override for tests; default is the real API. */
  baseUrl?: string;
  maxRetries?: number;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE = "https://www.googleapis.com";
const MULTIPART_BOUNDARY = "motard-drive-upload";

function isRetryable(status: number, reason?: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"))
    return true;
  return false;
}

function reasonOf(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: { errors?: Array<{ reason?: string }>; message?: string } }).error;
    return e?.errors?.[0]?.reason;
  }
  return undefined;
}

/** Strip anything secret-looking from an error before it can reach a log. */
export function redact(text: string): string {
  return (
    text
      // The whole credential (Google tokens carry '.', '_', '-'), with or without the Bearer word.
      .replace(/(Authorization:\s*)(?:Bearer\s+)?\S+/gi, "$1[REDACTED]")
      .replace(/\bya29\.\S+/g, "[REDACTED]")
      .replace(
        /"(access_token|refresh_token|id_token|code|client_secret)":\s*"[^"]*"/g,
        '"$1":"[REDACTED]"',
      )
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Live access token (D-01) ────────────────────────────────────────────────
// The Rust shell owns the refresh token (DPAPI) and pushes a short-lived access token over the
// runtime-only `POST /api/desktop/runtime/drive-token` after connect, on refresh and on disconnect
// (null). Kept in memory only — never persisted, never logged; a restarted sidecar is re-fed by the
// shell's next push.
let live: { token: string; expiresAtMs: number } | null = null;

let onConnected: (() => void) | null = null;

export function setLiveDriveToken(token: string | null, expiresAtSec = 0): void {
  const was = liveDriveTokenAvailable();
  live = token ? { token, expiresAtMs: expiresAtSec * 1000 } : null;
  if (!was && liveDriveTokenAvailable()) onConnected?.();
}

/** Run `fn` whenever a token arrives after none was available (connect / first push after boot). */
export function onLiveDriveConnected(fn: () => void): void {
  onConnected = fn;
}

export function liveDriveTokenAvailable(): boolean {
  return live !== null && live.expiresAtMs > Date.now();
}

/** TokenProvider for the production client: the shell's token, or an auth error when there is none. */
export const liveDriveToken: TokenProvider = async () => {
  if (!live || !liveDriveTokenAvailable()) throw new DriveAuthError("NOT_CONNECTED");
  return live.token;
};

export class DriveClient {
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: DriveClientOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    this.maxRetries = opts.maxRetries ?? 4;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    init?: { body?: string | Uint8Array; headers?: Record<string, string>; raw?: boolean },
  ): Promise<{ status: number; body: unknown; text: string }> {
    const token = await this.opts.token();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
          body: init?.body,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new DriveError(0, "NETWORK", redact(lastError.message), true);
      }
      const text = await res.text();
      if (res.ok) {
        return { status: res.status, body: init?.raw ? text : text ? JSON.parse(text) : {}, text };
      }
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const reason = reasonOf(body);
      if (res.status === 401) throw new DriveAuthError(redact(text).slice(0, 300));
      if (isRetryable(res.status, reason) && attempt < this.maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new DriveError(
        res.status,
        reason ?? "HTTP_ERROR",
        redact(text).slice(0, 300),
        isRetryable(res.status, reason),
      );
    }
    throw new DriveError(0, "UNREACHABLE", "exhausted retries", true); // not reached
  }

  /** Find a child by exact name under `parentId` (folders and files; trashed excluded). */
  async findChild(parentId: string, name: string): Promise<DriveFileMeta | null> {
    const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
    const { body } = await this.request(
      "GET",
      `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,md5Checksum)&pageSize=2`,
    );
    const files = (body as { files?: DriveFileMeta[] }).files ?? [];
    return files[0] ?? null;
  }

  async createFolder(parentId: string | null, name: string): Promise<DriveFileMeta> {
    const metadata = {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    };
    const { body } = await this.request("POST", "/drive/v3/files", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    return body as DriveFileMeta;
  }

  /** multipart/related upload for small files; resumable is unnecessary below ~5 MB. */
  async uploadSmall(
    parentId: string,
    name: string,
    mime: string,
    content: Uint8Array,
  ): Promise<DriveFileMeta> {
    const boundary = MULTIPART_BOUNDARY;
    const meta = JSON.stringify({ name, parents: [parentId] });
    const metaBytes = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(metaBytes.length + content.length + tail.length);
    body.set(metaBytes, 0);
    body.set(content, metaBytes.length);
    body.set(tail, metaBytes.length + content.length);
    const { body: uploaded } = await this.request(
      "POST",
      "/upload/drive/v3/files?uploadType=multipart&fields=id,name,md5Checksum,size",
      {
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return uploaded as DriveFileMeta;
  }

  /**
   * Resumable upload: init a session, then PUT the bytes. Returns the file meta
   * on completion. An interrupted session surfaces as DriveError(status=0) and
   * the queue's next attempt simply opens a fresh session.
   */
  async uploadResumable(
    parentId: string,
    name: string,
    mime: string,
    content: Uint8Array,
  ): Promise<DriveFileMeta> {
    const token = await this.opts.token();
    const init = await this.doFetch(
      `${this.base}/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime,
          "X-Upload-Content-Length": String(content.length),
        },
        body: JSON.stringify({ name, parents: [parentId] }),
      },
    );
    if (!init.ok) {
      const text = await init.text();
      if (init.status === 401) throw new DriveAuthError(redact(text).slice(0, 300));
      throw new DriveError(
        init.status,
        "RESUMABLE_INIT",
        redact(text).slice(0, 300),
        init.status >= 500 || init.status === 429,
      );
    }
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl) throw new DriveError(0, "RESUMABLE_NO_SESSION", "no Location header", true);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const put = await this.doFetch(sessionUrl, {
          method: "PUT",
          headers: { "Content-Length": String(content.length), "Content-Type": mime },
          body: content,
        });
        if (put.ok) return (await put.json()) as DriveFileMeta;
        const text = await put.text();
        if (put.status === 401) throw new DriveAuthError(redact(text).slice(0, 300));
        if (!(put.status >= 500 || put.status === 429)) {
          throw new DriveError(put.status, "RESUMABLE_UPLOAD", redact(text).slice(0, 300), false);
        }
      } catch (err) {
        if (err instanceof DriveAuthError || (err instanceof DriveError && !err.retryable))
          throw err;
      }
      await sleep(500 * 2 ** attempt);
    }
    throw new DriveError(0, "RESUMABLE_INTERRUPTED", "upload session failed after retries", true);
  }

  /** Get metadata by id — used to verify a crashed upload's file actually landed. */
  async getFile(fileId: string): Promise<DriveFileMeta | null> {
    try {
      const { body } = await this.request(
        "GET",
        `/drive/v3/files/${fileId}?fields=id,name,mimeType,md5Checksum,size`,
      );
      return body as DriveFileMeta;
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return null;
      throw err;
    }
  }

  /** Cheap connectivity/permission probe: list the (shared) drive root. */
  async ping(): Promise<{ ok: true; email: string | null }> {
    const { body } = await this.request(
      "GET",
      "/drive/v3/about?fields=user(displayName,emailAddress)",
    );
    const user = (body as { user?: { emailAddress?: string | null } }).user;
    return { ok: true, email: user?.emailAddress ?? null };
  }
}
