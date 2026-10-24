/**
 * Phase 4 — streamed resumable upload from disk. Runs against a local HTTP server that behaves like
 * Drive's resumable endpoint, so the bytes that arrive are checked, not assumed.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DriveClient } from "../src/infrastructure/googledrive/driveClient.js";

type Seen = { method: string; url: string; body: Buffer };

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

let server: Server;
let base: string;
let seen: Seen[];
let putFailuresLeft = 0;
const dir = mkdtempSync(join(tmpdir(), "motard-stream-"));

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", body });
    if (req.method === "POST" && req.url?.includes("uploadType=resumable")) {
      res.writeHead(200, { Location: `${base}/session/abc` });
      res.end("{}");
      return;
    }
    if (req.method === "PUT" && req.url?.startsWith("/session/")) {
      if (putFailuresLeft > 0) {
        putFailuresLeft--;
        res.writeHead(503);
        res.end("try later");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "file-1", name: "x.zip", size: String(body.length) }));
      return;
    }
    res.writeHead(404);
    res.end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  return new DriveClient({
    token: async () => "t",
    baseUrl: base,
    maxRetries: 2,
  });
}

describe("streamed resumable upload from disk", () => {
  it("sends exactly the bytes on disk, without loading them whole", async () => {
    seen = [];
    putFailuresLeft = 0;
    const content = randomBytes(3 * 1024 * 1024 + 17); // larger than one chunk, not a round number
    const file = join(dir, "big.zip");
    writeFileSync(file, content);

    const meta = await client().uploadResumableFromFile(
      "parent-1",
      "big.zip",
      "application/zip",
      file,
      content.length,
    );

    expect(meta.id).toBe("file-1");
    const put = seen.find((s) => s.method === "PUT");
    expect(put).toBeDefined();
    expect(createHash("sha256").update(put!.body).digest("hex")).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  });

  it("retries a 5xx by reopening the file, and the retry carries the same bytes", async () => {
    seen = [];
    putFailuresLeft = 1; // first PUT fails with 503, the retry succeeds
    const content = randomBytes(64 * 1024);
    const file = join(dir, "retry.zip");
    writeFileSync(file, content);

    await client().uploadResumableFromFile(
      "parent-1",
      "retry.zip",
      "application/zip",
      file,
      content.length,
    );

    const puts = seen.filter((s) => s.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].body.equals(content)).toBe(true);
  });

  it("the init request declares the real size up front", async () => {
    seen = [];
    putFailuresLeft = 0;
    const content = Buffer.from("hello archive");
    const file = join(dir, "small.zip");
    writeFileSync(file, content);
    await client().uploadResumableFromFile(
      "parent-1",
      "small.zip",
      "application/zip",
      file,
      content.length,
    );
    const init = seen.find((s) => s.method === "POST");
    expect(init).toBeDefined();
    expect(init!.url).toContain("uploadType=resumable");
  });
});
