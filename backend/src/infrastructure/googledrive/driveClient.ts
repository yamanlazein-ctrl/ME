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

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

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
  trashed?: boolean;
};

export type TokenProvider = () => Promise<string>;

export type DriveClientOptions = {
  token: TokenProvider;
  /** Base URL override for tests; default is the real API. */
  baseUrl?: string;
  maxRetries?: number;
  /**
   * Per-request timeout. Without it a hung Google connection hung the archive pass forever, and
   * with the run guard held every later trigger answered "busy" — the archive silently wedged.
   */
  timeoutMs?: number;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE = "https://www.googleapis.com";
const MULTIPART_BOUNDARY = "motard-drive-upload";
/** Generous enough for a slow connection, short enough that a hang is recovered from. */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Floor throughput for a request that CARRIES a body. The abort signal bounds the whole transfer,
 * not just the connect, so a flat 60 s cap aborted every upload slower than that — a 50 MB backup
 * on a 1 Mbit/s line (~7 minutes) failed on every attempt and never reached Drive.
 */
const MIN_UPLOAD_BYTES_PER_SEC = 32 * 1024;

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
  private readonly timeoutMs: number;

  constructor(private readonly opts: DriveClientOptions) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    this.maxRetries = opts.maxRetries ?? 4;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The time a body of `bytes` may take: the base timeout plus the transfer at the floor rate. */
  private transferTimeoutMs(bytes: number): number {
    return this.timeoutMs + Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_SEC) * 1000);
  }

  private async request(
    method: string,
    path: string,
    init?: {
      body?: string | Uint8Array;
      headers?: Record<string, string>;
      raw?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
    let lastError: Error | null = null;
    // The token is read PER ATTEMPT, not once before the loop: the shell pushes a fresh access
    // token every 20 seconds, so a 401 usually means the token was rotated underneath us. Re-reading
    // it and retrying once turns that into a success instead of a "blocked" job.
    let token = await this.opts.token();
    let refreshed = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
          body: init?.body,
          // A hung connection used to hang the pass forever, and with the run guard held the
          // archive was wedged with no error and no timeout.
          signal: AbortSignal.timeout(init?.timeoutMs ?? this.timeoutMs),
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
        return {
          status: res.status,
          body: init?.raw ? text : text ? JSON.parse(text) : {},
          text,
          headers: res.headers,
        };
      }
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const reason = reasonOf(body);
      if (res.status === 401) {
        // One retry with a freshly read token; after that the token really is refused.
        if (!refreshed) {
          refreshed = true;
          token = await this.opts.token();
          continue;
        }
        throw new DriveAuthError(redact(text).slice(0, 300));
      }
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

  /**
   * Phase 2 — find the file this app already uploaded for one document, by its stable `motardKey`
   * (stored in Drive `appProperties`). Matching by key, not by name, so renaming a party or a
   * document never creates a duplicate. Trashed files are excluded.
   *
   * The lookup is GLOBAL: the key is unique by construction, and a parent-scoped lookup missed the
   * file whenever the month or category folder had been recreated — which silently produced a
   * duplicate file. `parentId` is kept only as an optional narrowing hint.
   */
  async findByAppKey(appKey: string, parentId?: string): Promise<DriveFileMeta | null> {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const escaped = esc(appKey);
    const parentClause = parentId ? ` and '${esc(parentId)}' in parents` : "";
    const q = `appProperties has { key='motardKey' and value='${escaped}' } and trashed = false${parentClause}`;
    const { body } = await this.request(
      "GET",
      `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,md5Checksum,size)&pageSize=2`,
    );
    const files = (body as { files?: DriveFileMeta[] }).files ?? [];
    return files[0] ?? null;
  }

  /**
   * Phase 2 — replace the bytes of an existing file (same file id, so Drive keeps one copy of the
   * document). Used when an edited document is re-archived.
   *
   * `name` refreshes the Drive file name as well: the file name carries the party name and the
   * cancelled marker, so an updated document must not keep the name it had before the edit.
   */
  async updateMedia(
    fileId: string,
    mime: string,
    content: Uint8Array,
    name?: string,
  ): Promise<DriveFileMeta> {
    const { body } = await this.request(
      "PATCH",
      `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,md5Checksum,size`,
      {
        headers: { "Content-Type": mime },
        body: content,
        timeoutMs: this.transferTimeoutMs(content.length),
      },
    );
    if (!name) return body as DriveFileMeta;
    // A metadata PATCH with only `name` leaves appProperties untouched.
    return (await this.renameFile(fileId, name)) as DriveFileMeta;
  }

  /**
   * Phase 2 — rewrite a file's `motardKey`. Used to adopt a file that was uploaded before the key
   * was derived from the document's immutable id, so it is found by the new key from then on.
   */
  // Drive MERGES `appProperties` on update (a key it does not mention is kept), so this only sets
  // `motardKey`; it would not drop another property if one were added later.
  async updateAppProperties(fileId: string, appKey: string): Promise<DriveFileMeta> {
    const { body } = await this.request(
      "PATCH",
      `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties: { motardKey: appKey } }),
      },
    );
    return body as DriveFileMeta;
  }

  /** Phase 2 — rename a folder (used when the company name changes, keeping the folder id). */
  async renameFile(fileId: string, name: string): Promise<DriveFileMeta> {
    const { body } = await this.request(
      "PATCH",
      `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    return body as DriveFileMeta;
  }

  /** Find a child by exact name under `parentId` (folders and files; trashed excluded). */
  async findChild(parentId: string, name: string): Promise<DriveFileMeta | null> {
    // Drive query strings escape both the backslash and the quote (a company name may contain either).
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${escaped}' and trashed = false`;
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
    appKey?: string,
  ): Promise<DriveFileMeta> {
    const boundary = MULTIPART_BOUNDARY;
    const meta = JSON.stringify({
      name,
      parents: [parentId],
      ...(appKey ? { appProperties: { motardKey: appKey } } : {}),
    });
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
        timeoutMs: this.transferTimeoutMs(body.length),
      },
    );
    return uploaded as DriveFileMeta;
  }

  /**
   * Open a resumable upload session. It goes through `request()`, so it inherits the retry, the
   * backoff, the timeout and the token re-read — the session init used to be a raw fetch with NO
   * retry at all, so one transient blip failed the whole upload of a large backup.
   */
  private async initResumableSession(
    parentId: string,
    name: string,
    mime: string,
    sizeBytes: number,
    appKey?: string,
  ): Promise<string> {
    const { headers } = await this.request(
      "POST",
      "/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size",
      {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime,
          "X-Upload-Content-Length": String(sizeBytes),
        },
        body: JSON.stringify({
          name,
          parents: [parentId],
          ...(appKey ? { appProperties: { motardKey: appKey } } : {}),
        }),
      },
    );
    const sessionUrl = headers.get("location");
    if (!sessionUrl) throw new DriveError(0, "RESUMABLE_NO_SESSION", "no Location header", true);
    return sessionUrl;
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
    appKey?: string,
  ): Promise<DriveFileMeta> {
    const sessionUrl = await this.initResumableSession(
      parentId,
      name,
      mime,
      content.length,
      appKey,
    );
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const put = await this.doFetch(sessionUrl, {
          method: "PUT",
          headers: { "Content-Length": String(content.length), "Content-Type": mime },
          body: content,
          signal: AbortSignal.timeout(this.transferTimeoutMs(content.length)),
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

  /**
   * Phase 4 — resumable upload of a file ON DISK, streamed (never loaded into memory). Used for large
   * archives such as the database backup ZIP. Each attempt opens the file again, because a streamed
   * request body cannot be replayed after a failed attempt.
   */
  async uploadResumableFromFile(
    parentId: string,
    name: string,
    mime: string,
    filePath: string,
    sizeBytes: number,
    appKey?: string,
  ): Promise<DriveFileMeta> {
    const sessionUrl = await this.initResumableSession(parentId, name, mime, sizeBytes, appKey);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
        const put = await this.doFetch(sessionUrl, {
          method: "PUT",
          headers: { "Content-Length": String(sizeBytes), "Content-Type": mime },
          body,
          duplex: "half",
          signal: AbortSignal.timeout(this.transferTimeoutMs(sizeBytes)),
        } as RequestInit);
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

  /**
   * Phase 4 — download a file from Drive to disk, STREAMED and hashed while it streams. The bytes
   * are never held in memory (a backup ZIP can be hundreds of megabytes).
   *
   * The file is written to `outPath + ".partial"` and renamed only when the streamed SHA-256
   * matches the expected hash — a truncated download never becomes the final file.
   *
   * This is the read half of the archive. Without it the Drive archive is a write-only sink: the
   * database backup that is uploaded there could not be fetched back, so it could not be used to
   * recover a lost installation (and it is a hard prerequisite for the Smart Merge restore).
   */
  async downloadToFile(
    fileId: string,
    outPath: string,
    expectedSha256?: string,
  ): Promise<{ path: string; sha256: string; size: number }> {
    const { createWriteStream } = await import("node:fs");
    const { rename, rm, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256");
    let size = 0;
    const partial = `${outPath}.partial`;
    await mkdir(dirname(outPath), { recursive: true });
    const res = await this.doFetch(
      `${this.base}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${await this.opts.token()}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok || !res.body) {
      const text = res.ok ? "" : await res.text().catch(() => "");
      if (res.status === 401) throw new DriveAuthError(redact(text).slice(0, 300));
      throw new DriveError(
        res.status,
        "DOWNLOAD",
        redact(text).slice(0, 300),
        res.status >= 500 || res.status === 429,
      );
    }
    const out = createWriteStream(partial);
    // Listen for a write error (disk full, file locked) from the FIRST byte: an 'error' event with no
    // listener is an uncaught exception that takes the whole backend down.
    let writeError: Error | null = null;
    out.on("error", (e) => {
      writeError = e;
    });
    try {
      const reader = res.body.getReader();
      for (;;) {
        if (writeError) throw writeError;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        hash.update(value);
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            out.once("drain", () => resolve());
            out.once("error", reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        if (writeError) return reject(writeError);
        out.once("error", reject);
        out.end(() => resolve());
      });
    } catch (err) {
      out.destroy();
      await rm(partial, { force: true }).catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }
    const sha256 = hash.digest("hex");
    if (expectedSha256 && expectedSha256 !== sha256) {
      // The download does not match what was expected: keep the partial file out of the way and
      // refuse to produce the final one.
      await rm(partial, { force: true }).catch(() => {});
      throw new DriveError(
        0,
        "HASH_MISMATCH",
        "the downloaded content does not match its hash",
        false,
      );
    }
    await rename(partial, outPath);
    return { path: outPath, sha256, size };
  }

  /** Get metadata by id — used to verify a crashed upload's file actually landed. */
  async getFile(fileId: string): Promise<DriveFileMeta | null> {
    try {
      const { body } = await this.request(
        "GET",
        `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,md5Checksum,size,trashed`,
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
