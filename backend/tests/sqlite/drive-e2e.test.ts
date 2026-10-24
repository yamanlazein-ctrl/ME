/**
 * Google Drive archive, end to end over HTTP (audit C-04): the PRODUCTION wiring
 * (`wireDriveArchive`, used by server.ts), the real `DriveClient`, the runtime route the Rust shell
 * pushes its access token to, and a fake Google Drive HTTP server that records exactly what reaches
 * it. Real temporary SQLite database and a real verified backup.
 *
 *   no token  → status "not connected", sync uploads nothing
 *   shell pushes a token (runtime-token gated) → sync uploads the backup with its exact bytes,
 *     authorised with that token, into the archive folder chain; status shows the upload
 *   shell pushes null (disconnect) → not connected again
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "motard-drive-e2e-"));
const saved = { ...process.env };
const DEVICE = randomUUID();
process.env.DB_ENGINE = "sqlite";
process.env.DESKTOP_DEPLOY = "true";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID = DEVICE;
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
delete process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const TOKEN = "ya29.e2e-access-token-0123456789";

/** Fake Google Drive v3: folders by (parent, name), multipart uploads captured byte for byte. */
type Upload = { name: string; parents: string[]; bytes: Buffer; auth: string | undefined };
const drive = {
  sessions: new Map<string, { name: string; parents: string[]; auth?: string }>(),
  folders: new Map<string, string>(),
  files: new Map<string, Upload>(),
  uploads: [] as Upload[],
};
let driveServer: Server;
let driveBase = "";

function startFakeDrive(): Promise<void> {
  driveServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      // A resumable session URL (`/upload/session/<id>`) authorises its own PUT, as on Google; every other
      // request must carry the bearer token.
      const isSessionPut = req.method === "PUT" && /^\/upload\/session\//.test(req.url ?? "");
      if (!isSessionPut && req.headers.authorization !== `Bearer ${TOKEN}`)
        return json(401, { error: { message: "bad token" } });
      const body = Buffer.concat(chunks);
      if (req.method === "GET" && url.pathname === "/drive/v3/files") {
        const q = url.searchParams.get("q") ?? "";
        const name = /name = '([^']*)'/.exec(q)?.[1] ?? "";
        const parent = /'([^']*)' in parents/.exec(q)?.[1] ?? "root";
        const id = drive.folders.get(`${parent}|${name}`);
        return json(200, {
          files: id ? [{ id, name, mimeType: "application/vnd.google-apps.folder" }] : [],
        });
      }
      if (req.method === "POST" && url.pathname === "/drive/v3/files") {
        const meta = JSON.parse(body.toString("utf8")) as { name: string; parents?: string[] };
        const id = `fld-${drive.folders.size + 1}`;
        drive.folders.set(`${meta.parents?.[0] ?? "root"}|${meta.name}`, id);
        return json(200, { id, name: meta.name, mimeType: "application/vnd.google-apps.folder" });
      }
      // Phase 4: resumable protocol (init → session URL → PUT the bytes). The init carries the metadata.
      if (
        req.method === "POST" &&
        url.pathname === "/upload/drive/v3/files" &&
        url.searchParams.get("uploadType") === "resumable"
      ) {
        const meta = JSON.parse(body.toString("utf8") || "{}") as {
          name: string;
          parents: string[];
        };
        const sessionId = `sess-${drive.uploads.length + 1}-${Date.now()}`;
        // The session-creating request is the authorised one; remember its token for the uploaded file.
        drive.sessions.set(sessionId, { ...meta, auth: req.headers.authorization });
        res.writeHead(200, {
          Location: `${driveBase}/upload/session/${sessionId}`,
          "Content-Type": "application/json",
        });
        res.end("{}");
        return;
      }
      const sessionId = /^\/upload\/session\/([^/]+)$/.exec(url.pathname)?.[1];
      if (req.method === "PUT" && sessionId && drive.sessions.has(sessionId)) {
        const meta = drive.sessions.get(sessionId)!;
        drive.sessions.delete(sessionId);
        const up: Upload = { name: meta.name, parents: meta.parents, bytes: body, auth: meta.auth };
        const id = `file-${drive.files.size + 1}`;
        drive.files.set(id, up);
        drive.uploads.push(up);
        return json(200, { id, name: meta.name, size: String(body.length), md5Checksum: "x" });
      }
      if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
        const boundary = /boundary=([^;]+)/.exec(String(req.headers["content-type"]))![1];
        const sep = Buffer.from(`--${boundary}\r\n`);
        const metaStart = body.indexOf(sep) + sep.length;
        const metaJsonStart = body.indexOf("\r\n\r\n", metaStart) + 4;
        const metaEnd = body.indexOf(Buffer.from(`\r\n--${boundary}\r\n`), metaJsonStart);
        const meta = JSON.parse(body.subarray(metaJsonStart, metaEnd).toString("utf8")) as {
          name: string;
          parents: string[];
        };
        const fileStart = body.indexOf("\r\n\r\n", metaEnd + 4) + 4;
        const fileEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
        const up: Upload = {
          ...meta,
          bytes: body.subarray(fileStart, fileEnd),
          auth: req.headers.authorization,
        };
        const id = `file-${drive.files.size + 1}`;
        drive.files.set(id, up);
        drive.uploads.push(up);
        return json(200, { id, name: meta.name, size: String(up.bytes.length), md5Checksum: "x" });
      }
      const fileId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
      if (req.method === "GET" && fileId) {
        const f = drive.files.get(fileId);
        return f
          ? json(200, { id: fileId, name: f.name, mimeType: "x", size: String(f.bytes.length) })
          : json(404, {});
      }
      return json(404, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
    });
  });
  return new Promise((r) =>
    driveServer.listen(0, "127.0.0.1", () => {
      driveBase = `http://127.0.0.1:${(driveServer.address() as AddressInfo).port}`;
      r();
    }),
  );
}

let app: Server;
let base = "";
let backupPath = "";
let runtimeToken = "";
let role = "admin";

beforeAll(async () => {
  await startFakeDrive();
  const runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime();
  const raw = runtime.getSqliteRuntime()!.conns.writer;
  const tenantId = randomUUID();
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'Drive Co', 'default')`)
    .run(tenantId);
  raw
    .prepare(`INSERT INTO settings (id, tenant_id, drive) VALUES (?, ?, ?)`)
    .run(
      randomUUID(),
      tenantId,
      JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: DEVICE }),
    );
  const { createAndVerifyBackup } = await import("@/infrastructure/backup/sqliteBackup.js");
  backupPath = (await createAndVerifyBackup({ kind: "automatic", appVersion: "e2e" })).path;

  const { wireDriveArchive } = await import("@/presentation/driveArchiveWiring.js");
  const { registerDesktopRuntimeRoutes } =
    await import("@/presentation/routes/desktopRuntime.route.js");
  const { sqliteDb } = await import("@/infrastructure/orm/sqlite/transaction.js");
  const wired = await wireDriveArchive({
    db: sqliteDb(),
    localDeviceId: DEVICE,
    baseUrl: driveBase,
  });

  const ex = express();
  ex.use(express.json());
  const runtimeRouter = express.Router();
  registerDesktopRuntimeRoutes(runtimeRouter);
  ex.use(runtimeRouter);
  // Stand-in for authMiddleware: the drive routes must read the REAL tenant context field.
  ex.use("/api", (req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId,
      userId: randomUUID(),
      userRole: role,
    };
    next();
  });
  ex.use("/api", wired.router);
  await new Promise<void>((r) => {
    app = ex.listen(0, "127.0.0.1", () => r());
  });
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  runtimeToken = createHash("sha256").update(process.env.APP_MASTER_KEY!).digest("hex");
});

afterAll(async () => {
  const { setLiveDriveToken } = await import("@/infrastructure/googledrive/driveClient.js");
  setLiveDriveToken(null);
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => driveServer.close(() => r()));
  const rt = (await import("@/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime();
  if (rt) (await import("@/infrastructure/orm/sqlite/connection.js")).closeSqlite(rt.conns);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const pushToken = (
  accessToken: string | null,
  headers = { "X-Motard-Runtime-Token": runtimeToken },
) =>
  call(
    "POST",
    "/api/desktop/runtime/drive-token",
    { accessToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    headers,
  );

/** The archive run continues in the background; wait until it has finished. */
async function waitForRunToFinish(runId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = (await call("GET", `/api/drive/archive/runs/${runId}`)).body as { state?: string };
    if (p.state && p.state !== "running") return;
    if (Date.now() > deadline) throw new Error(`the archive run ${runId} did not finish in time`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Drive archive end to end", () => {
  it("without a token from the shell nothing is connected and nothing uploads", async () => {
    const st = await call("GET", "/api/drive/status");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({
      connected: false,
      isPrimaryDevice: true,
      localDeviceId: DEVICE,
    });
    await call("POST", "/api/drive/sync-now");
    expect(drive.uploads).toHaveLength(0);
  });

  it("only the shell can hand over a token (runtime token), never the page", async () => {
    expect((await pushToken(TOKEN, { "X-Motard-Runtime-Token": "0".repeat(64) })).status).toBe(404);
    expect((await pushToken(TOKEN, {} as never)).status).toBe(404);
    expect((await call("GET", "/api/drive/status")).body.connected).toBe(false);
  });

  it("after the shell's push, a sync uploads the verified backup with its exact bytes", async () => {
    expect((await pushToken(TOKEN)).body).toMatchObject({ ok: true, connected: true });
    const r = await call("POST", "/api/drive/sync-now");
    expect(r.status).toBe(200);
    // The run continues in the BACKGROUND: the answer carries its id straight away, and the client
    // polls it. The route must not wait for the upload (it can take minutes).
    const started = r.body as { runId?: string | null; skipped?: string | null };
    expect(started.runId).toBeTruthy();
    await waitForRunToFinish(String(started.runId));
    const backup = drive.uploads.find((u) => u.name.endsWith(".zip"));
    // On failure, show the queue's recorded error for the backup job (the upload error is stored there).
    const q = (await call("GET", "/api/drive/queue")).body as {
      jobs?: Array<{ fileName: string; status: string; lastError: string | null }>;
    };
    const jobs = (q.jobs ?? [])
      .map((j) => `${j.fileName}:${j.status}:${j.lastError ?? "-"}`)
      .join(" | ");
    expect(
      backup,
      `uploads: ${drive.uploads.map((u) => u.name).join(", ")} | queue: ${jobs}`,
    ).toBeDefined();
    const onDisk = readFileSync(backupPath);
    expect(backup!.bytes.length).toBe(onDisk.length);
    expect(backup!.bytes.length).toBeGreaterThan(1000);
    expect(sha(backup!.bytes)).toBe(sha(onDisk));
    expect(backup!.auth).toBe(`Bearer ${TOKEN}`);
    expect(backup!.parents[0]).toMatch(/^fld-/); // filed inside the archive folder chain
    const st = await call("GET", "/api/drive/status");
    expect(st.body.connected).toBe(true);
    expect(st.body.lastUpload).toMatchObject({ section: "system_backups" });
    // A second sync does not upload the same backup again (deduped by content hash).
    const before = drive.uploads.length;
    await call("POST", "/api/drive/sync-now");
    expect(drive.uploads.filter((u) => u.name === backup!.name)).toHaveLength(1);
    expect(drive.uploads.length).toBe(before);
  });

  it("the run route rejects an unknown trigger or period instead of coercing it", async () => {
    const bogus = await call("POST", "/api/drive/archive/runs", { trigger: "bogus" });
    expect(bogus.status).toBe(400);
    const badPeriod = await call("POST", "/api/drive/archive/runs", { periodKey: "2026-13x" });
    expect(badPeriod.status).toBe(400);
  });

  it("the drive routes are the admin's (real tenantContext role)", async () => {
    role = "viewer";
    expect((await call("GET", "/api/drive/status")).status).toBe(403);
    role = "admin";
  });

  it("a disconnect (null) leaves the backend without a token", async () => {
    expect((await pushToken(null)).body).toMatchObject({ connected: false });
    expect((await call("GET", "/api/drive/status")).body.connected).toBe(false);
  });
});
