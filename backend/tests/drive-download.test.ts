/**
 * Remediation Stage 2 — Task 2.14 (C-13): the read half of the Drive archive.
 *
 * Until now the Drive client could only WRITE. There was no `alt=media` anywhere in the codebase,
 * so a file that had been uploaded could never be fetched back. That made the Drive archive a
 * write-only sink: the database backup uploaded there could not be used to recover a lost
 * installation, and the Smart Merge restore (Stage 4) has nothing to restore FROM.
 *
 * These tests drive the real client against a mocked fetch: the bytes must land on disk, the
 * streamed hash must be checked, and a mismatch must never produce the final file.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DriveClient, DriveError } from "../src/infrastructure/googledrive/driveClient.js";

const TOKEN = () => Promise.resolve("test-access-token");

function mockFetch(handler: (method: string, url: string) => Response | Promise<Response>) {
  const calls: Array<{ method: string; url: string }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url) });
    return handler(method, String(url));
  };
  return { impl: impl as typeof fetch, calls };
}

const PAYLOAD = "PK a database backup that is long enough to span a few chunks";
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

describe("DriveClient.downloadToFile", () => {
  it("streams the file to disk and reports its hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motard-dl-"));
    const out = join(dir, "backup.zip");
    const { impl, calls } = mockFetch((_m, url) => {
      expect(url).toContain("alt=media");
      return new Response(PAYLOAD, { status: 200 });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const r = await client.downloadToFile("file-1", out, PAYLOAD_SHA);
    expect(r.path).toBe(out);
    expect(r.sha256).toBe(PAYLOAD_SHA);
    expect(r.size).toBe(Buffer.byteLength(PAYLOAD));
    expect(readFileSync(out, "utf8")).toBe(PAYLOAD);
    expect(calls[0].method).toBe("GET");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to produce the final file when the content does not match the expected hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motard-dl-"));
    const out = join(dir, "backup.zip");
    const { impl } = mockFetch(() => new Response(PAYLOAD, { status: 200 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    await expect(client.downloadToFile("file-1", out, "0".repeat(64))).rejects.toBeInstanceOf(
      DriveError,
    );
    // The partial file is removed: a truncated download must never become the backup.
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the file when no expected hash is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motard-dl-"));
    const out = join(dir, "backup.zip");
    const { impl } = mockFetch(() => new Response(PAYLOAD, { status: 200 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const r = await client.downloadToFile("file-1", out);
    expect(r.sha256).toBe(PAYLOAD_SHA);
    expect(existsSync(out)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces a missing file as a typed error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motard-dl-"));
    const out = join(dir, "backup.zip");
    const { impl } = mockFetch(() => new Response("not found", { status: 404 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    await expect(client.downloadToFile("gone", out)).rejects.toBeInstanceOf(DriveError);
    expect(existsSync(out)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
