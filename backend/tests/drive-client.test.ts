/**
 * DriveClient tests against a mocked fetch: folder ops, multipart + resumable
 * upload, retry/backoff on transient errors, typed auth failures, and secret
 * redaction. No Google credentials involved.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DriveClient,
  DriveAuthError,
  DriveError,
  redact,
} from "../src/infrastructure/googledrive/driveClient.js";

const TOKEN = () => Promise.resolve("test-access-token");

function ok(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

/** A fetch mock recording calls; handler maps (method, url) → Response. */
function mockFetch(
  handler: (method: string, url: string, body: unknown) => Response | Promise<Response>,
) {
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
      return ok({
        files: [
          { id: "fld-1", name: "2026-10 — أكتوبر", mimeType: "application/vnd.google-apps.folder" },
        ],
      });
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
    const { impl, calls } = mockFetch((_m, _u, body) =>
      ok({ id: "new-1", name: "x", ...(body as object) }),
    );
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const f = await client.createFolder("parent-1", "2026");
    expect(f.id).toBe("new-1");
    const sent = JSON.parse(String(calls[0].body));
    expect(sent.parents).toEqual(["parent-1"]);
    expect(sent.mimeType).toBe("application/vnd.google-apps.folder");
  });

  it("uploads small files as multipart and returns the file meta", async () => {
    const { impl, calls } = mockFetch(() =>
      ok({ id: "up-1", name: "2026-10-05_INV.csv", size: "10" }),
    );
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const meta = await client.uploadSmall(
      "parent-1",
      "2026-10-05_INV.csv",
      "text/csv",
      new TextEncoder().encode("a,b\n1,2\n"),
    );
    expect(meta.id).toBe("up-1");
    expect(calls[0].url).toContain("uploadType=multipart");
    const sent = new TextDecoder().decode(calls[0].body as Uint8Array);
    expect(sent).toContain("2026-10-05_INV.csv");
    expect(sent).toContain("text/csv");
  });

  it("completes a resumable upload via the session URL", async () => {
    const { impl, calls } = mockFetch((method, url) => {
      if (method === "POST" && url.includes("uploadType=resumable")) {
        return new Response(null, {
          status: 200,
          headers: { Location: "https://session.example/upload/1" },
        });
      }
      return ok({ id: "res-1", name: "backup.zip" });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const meta = await client.uploadResumable(
      "p",
      "backup.zip",
      "application/zip",
      new Uint8Array(32),
    );
    expect(meta.id).toBe("res-1");
    expect(
      calls.some((c) => c.url === "https://session.example/upload/1" && c.method === "PUT"),
    ).toBe(true);
  });

  it("retries transient 5xx with backoff then succeeds", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      if (attempts < 3)
        return new Response(JSON.stringify({ error: { errors: [{ reason: "backendError" }] } }), {
          status: 500,
        });
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
      return new Response(JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }), {
        status: 404,
      });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    await expect(client.findChild("p", "x")).rejects.toThrow(DriveError);
    expect(attempts).toBe(1);
  });

  it("retries a 401 once with a freshly read token, then surfaces DriveAuthError", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      return new Response("invalid credentials", { status: 401 });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    await expect(client.findChild("p", "x")).rejects.toBeInstanceOf(DriveAuthError);
    // The shell pushes a fresh access token every 20 seconds, so a 401 usually means the token was
    // rotated underneath us. The client re-reads it and retries ONCE; a second 401 is a real
    // refusal (a revoked token) and is surfaced.
    expect(attempts).toBe(2);
  });

  it("succeeds on the retry when the token was rotated", async () => {
    let attempts = 0;
    const { impl } = mockFetch(() => {
      attempts++;
      if (attempts === 1) return new Response("invalid credentials", { status: 401 });
      return ok({ files: [{ id: "f1", name: "n", mimeType: "x" }] });
    });
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, maxRetries: 4 });
    expect((await client.findByAppKey("k"))?.id).toBe("f1");
    expect(attempts).toBe(2);
  });

  it("getFile returns null on 404 without throwing", async () => {
    const { impl } = mockFetch(() => new Response("not found", { status: 404 }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    expect(await client.getFile("gone")).toBeNull();
  });

  it("ping returns the authorized account email", async () => {
    const { impl } = mockFetch(() =>
      ok({ user: { emailAddress: "archive@example.com", displayName: "Archive" } }),
    );
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    const p = await client.ping();
    expect(p).toEqual({ ok: true, email: "archive@example.com" });
  });

  it("escapes a backslash and a quote in a child name", async () => {
    const { impl, calls } = mockFetch(() => ok({ files: [] }));
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl });
    await client.findChild("root", "a\\b'c");
    const q = decodeURIComponent(calls[0].url.split("q=")[1].split("&")[0]);
    expect(q).toContain("name = 'a\\\\b\\'c'");
  });
});

/** A fetch that answers after `delayMs`, unless the request's abort signal fires first. */
function slowFetch(delayMs: number, response: () => Response): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(response()), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
}

describe("DriveClient transfer timeout", () => {
  // The abort signal bounds the WHOLE transfer. A flat request timeout aborted every upload slower
  // than it, so a large backup on a slow line never reached Drive. A body gets time proportional to
  // its size (floor 32 KiB/s): 1 MiB may take ~32 s, far longer than the 150 ms used here.
  const MiB = new Uint8Array(1024 * 1024);

  it("lets a large multipart upload outlast the base request timeout", async () => {
    const client = new DriveClient({
      token: TOKEN,
      fetchImpl: slowFetch(150, () => ok({ id: "big-1", name: "b.zip" })),
      timeoutMs: 50,
      maxRetries: 0,
    });
    const meta = await client.uploadSmall("p", "b.zip", "application/zip", MiB);
    expect(meta.id).toBe("big-1");
  });

  it("lets a large resumable PUT outlast the base request timeout", async () => {
    const slowPut = slowFetch(150, () => ok({ id: "res-big", name: "b.zip" }));
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(null, {
          status: 200,
          headers: { Location: "https://session.example/upload/2" },
        });
      }
      return slowPut(url, init);
    }) as typeof fetch;
    const client = new DriveClient({ token: TOKEN, fetchImpl: impl, timeoutMs: 50, maxRetries: 0 });
    const meta = await client.uploadResumable("p", "b.zip", "application/zip", MiB);
    expect(meta.id).toBe("res-big");
  });

  it("still times out a request without a body at the base timeout", async () => {
    const client = new DriveClient({
      token: TOKEN,
      fetchImpl: slowFetch(150, () => ok({ files: [] })),
      timeoutMs: 50,
      maxRetries: 0,
    });
    await expect(client.findChild("p", "x")).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("redact", () => {
  it("strips bearer tokens and token-shaped JSON values", () => {
    const dirty =
      'Authorization: Bearer ya29.abc123 {"access_token":"secret","refresh_token":"r1","other":"keep"}';
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
    for (const dirty of [
      `Authorization: Bearer ${token}`,
      `authorization: bearer ${token} trailing`,
      `Authorization:${token}`,
    ]) {
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
