/**
 * DriveClient tests against a mocked fetch: folder ops, multipart + resumable
 * upload, retry/backoff on transient errors, typed auth failures, and secret
 * redaction. No Google credentials involved.
 */
import { describe, it, expect, vi } from "vitest";
import { DriveClient, DriveAuthError, DriveError, redact } from "../src/infrastructure/googledrive/driveClient.js";

const TOKEN = () => Promise.resolve("test-access-token");

function ok(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

/** A fetch mock recording calls; handler maps (method, url) → Response. */
function mockFetch(handler: (method: string, url: string, body: unknown) => Response | Promise<Response>) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    let parsed: unknown;
    if (rawBody instanceof Uint8Array) parsed = rawBody;
    else if (typeof rawBody === "string") parsed = rawBody;
    const r = await handler(method, String(url), parsed);
    calls.push({ method, url: String(url), auth: headers.Authorization, body: parsed });
    return r;
  };
  return { impl: impl as typeof fetch, calls };
}

describe("DriveClient", () => {
  it("finds a child by exact name and sends the bearer token", async () => {
    const { impl, calls } = mockFetch((_m, url) => {
      expect(url).toContain("files?q=");
      return ok({ files: [{ id: "fld-1", name: "2026-10 — أكتوبر", mimeType: "application/vnd.google-apps.folder" }] });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const child = await client.findChild("root-id", "2026-10 — أكتوبر");
    expect(child?.id).toBe("fld-1");
    expect(calls[0].auth).toBe("Bearer test-access-token");
  });

  it("returns null when the child does not exist", async () => {
    const { impl } = mockFetch(() => ok({ files: [] }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    expect(await client.findChild("root", "missing")).toBeNull();
  });

  it("creates a folder with the folder MIME and parent", async () => {
    const { impl, calls } = mockFetch((_m, _u, body) => ok({ id: "new-1", name: "x", ...(body as object) }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const f = await client.createFolder("parent-1", "2026");
    expect(f.id).toBe("new-1");
    const sent = JSON.parse(String(calls[0].body));
    expect(sent.parents).toEqual(["parent-1"]);
    expect(sent.mimeType).toBe("application/vnd.google-apps.folder");
  });

  it("uploads small files as multipart and returns the file meta", async () => {
    const { impl, calls } = mockFetch(() => ok({ id: "up-1", name: "2026-10-05_INV.csv", size: "10" }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const meta = await client.uploadSmall("parent-1", "2026-10-05_INV.csv", "text/csv", new TextEncoder().encode("a,b\n1,2\n"));
    expect(meta.id).toBe("up-1");
    expect(calls[0].url).toContain("uploadType=multipart");
    const sent = new TextDecoder().decode(calls[0].body as Uint8Array);
    expect(sent).toContain("2026-10-05_INV.csv");
    expect(sent).toContain("text/csv");
  });

  it("completes a resumable upload via the session URL", async () => {
    const { impl, calls } = mockFetch((method, url) => {
      if (method === "POST" && url.includes("uploadType=resumable")) {
        return new Response(null, { status: 200, headers: { Location: "https://session.example/upload/1" } });
      }
      return ok({ id: "res-1", name: "backup.zip" });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const meta = await client.uploadResumable("p", "backup.zip", "application/zip", new Uint8Array(32));
    expect(meta.id).toBe("res-1");
    expect(calls.some((c) => c.url === "https://session.example/upload/1" && c.method === "PUT")).toBe(true);
  });

  it("retries transient 5xx with backoff then succeeds", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      if (attempts < 3) return new Response(JSON.stringify({ error: { errors: [{ reason: "backendError" }] } }), { status: 500 });
      return ok({ files: [] });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    expect(await client.findChild("p", "x")).toBeNull();
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable 4xx and throws DriveError", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      return new Response(JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }), { status: 404 });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    await expect(client.findChild("p", "x")).rejects.toThrow(DriveError);
    expect(attempts).toBe(1);
  });

  it("surfaces 401 as DriveAuthError immediately", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      return new Response("invalid credentials", { status: 401 });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    await expect(client.findChild("p", "x")).rejects.toBeInstanceOf(DriveAuthError);
    expect(attempts).toBe(1);
  });

  it("getFile returns null on 404 without throwing", async () => {
    const { impl } = mockFetch(() => new Response("not found", { status: 404 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    expect(await client.getFile("gone")).toBeNull();
  });

  it("ping returns the authorized account email", async () => {
    const { impl } = mockFetch(() => ok({ user: { emailAddress: "archive@example.com", displayName: "Archive" } }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const p = await client.ping();
    expect(p).toEqual({ ok: true, email: "archive@example.com" });
  });
});

describe("redact", () => {
  it("strips bearer tokens and token-shaped JSON values", () => {
    const dirty = 'Authorization: Bearer ya29.abc123 {"access_token":"secret","refresh_token":"r1","other":"keep"}';
    const clean = redact(dirty);
    expect(clean).not.toContain("ya29");
    expect(clean).not.toContain("secret");
    expect(clean).not.toContain("r1");
    expect(clean).toContain("keep");
  });

  // D-04: real Google access tokens contain '.', '_' and '-'; `[\w-]+` stopped at the first '.',
  // so "Bearer ya29.a0AfH6…" left everything after "ya29" in the log.
  it("redacts a real-shaped ya29 token completely", () => {
    const token = "ya29.a0AfH6SBC-secret_TOKEN.1234-xyz";
    for (const dirty of [`Authorization: Bearer ${token}`, `authorization: bearer ${token} trailing`, `Authorization:${token}`]) {
      const clean = redact(dirty);
      expect(clean).not.toContain("a0AfH6SBC");
      expect(clean).not.toContain("secret_TOKEN");
      expect(clean).not.toContain("1234-xyz");
    }
  });

  it("never lets error text carry the access token", async () => {
    const { impl } = mockFetch(() => new Response("quota exceeded for token", { status: 403 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 0 });
    try {
      await client.findChild("p", "x");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("test-access-token");
    }
  });
});
