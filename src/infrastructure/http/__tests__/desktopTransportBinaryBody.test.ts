import { describe, it, expect } from "vitest";
import { installDesktopTransport } from "@/infrastructure/http/desktopTransport";
import { pickBackupFile } from "@/infrastructure/tauri-bridge";

/**
 * The restore-fails-with-a-valid-file regression (backup hand-off over the desktop bridge).
 *
 * The desktop SPA has no HTTP origin: every `/api/*` call goes Tauri IPC → Rust → named pipe, and the
 * pipe's request body is a `String` (`desktop/src-tauri/src/runtime/pipe.rs`: `PipeRequest.body`). A
 * `File` cannot cross it. The transport used to convert every non-string body to `null` SILENTLY, so
 * `fetch("/api/backup/verify", { body: file })` reached the server as ZERO bytes, `receiveUpload`
 * answered "لم يصل أي ملف", and the UI showed the generic "ملف غير صالح" for a perfectly valid archive.
 *
 * These tests pin the fix: a dropped body is a typed, actionable TRANSPORT error — never a silent empty
 * request — and the restore path the desktop actually uses is the shell's native picker plus the
 * by-path endpoints, which carry no binary over the bridge at all.
 */

type DesktopGlobal = typeof globalThis & { window?: unknown; fetch?: unknown };

/** Recorded `invoke` calls, so a test can assert exactly which command ran with which arguments. */
let invocations: Array<{ cmd: string; args?: Record<string, unknown> }>;
/** What the fake sidecar's `api` command answers. */
let apiAnswer: { status: number; headers: [string, string][]; body: string; error?: string | null };
/** Resolves the picked archive for the fake native picker (null = the user cancelled). */
let picked: { path: string; sizeBytes: number; sha256: string } | null;

function defineGlobal(name: "window" | "fetch", value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installDesktopWindow(): void {
  const win = {
    fetch: (): never => {
      throw new Error("the asset protocol fetch must not be used for /api/*");
    },
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        invocations.push({ cmd, args });
        if (cmd === "api") return { ...apiAnswer, elapsedUs: 10 };
        if (cmd === "pick_backup_file") return picked;
        throw new Error(`unexpected command ${cmd}`);
      },
    },
  };
  defineGlobal("window", win);
  installDesktopTransport();
}

function desktopFetch(): typeof fetch {
  const g = globalThis as DesktopGlobal;
  if (!g.window) throw new Error("fake desktop window is not installed");
  return (g.window as { fetch: typeof fetch }).fetch;
}

describe("a File body over the desktop bridge is a typed transport error, not a silent empty request", () => {
  it("refuses a File body instead of posting zero bytes", async () => {
    invocations = [];
    apiAnswer = { status: 200, headers: [["content-type", "application/json"]], body: "{}" };
    installDesktopWindow();

    // The exact call the restore card used to make. It must NOT reach the sidecar: an empty POST is
    // what the server interpreted as a corrupt archive.
    await expect(
      desktopFetch()("/api/backup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new File([new Uint8Array([1, 2, 3, 4])], "MotardERP-Backup.zip"),
      }),
    ).rejects.toThrow(/لا يمكن إرسال بيانات ثنائية/);

    expect(invocations, "nothing was sent, so the server could not mistake it for a damaged file").toHaveLength(0);
  });

  it("still sends a JSON string body normally (every ordinary mutation is unaffected)", async () => {
    invocations = [];
    apiAnswer = { status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ ok: true }) };
    installDesktopWindow();

    const res = await desktopFetch()("/api/parties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "زبون" }),
    });

    expect(res.status).toBe(200);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].args?.req).toMatchObject({ method: "POST", path: "/api/parties", body: '{"name":"زبون"}' });
  });
});

describe("the desktop restore hand-off", () => {
  it("picks the archive in the native dialog and asks for it by path — no binary over the bridge", async () => {
    invocations = [];
    apiAnswer = { status: 200, headers: [["content-type", "application/json"]], body: "{}" };
    picked = { path: "C:\\Users\\Taw\\Downloads\\MotardERP-Backup-2026-10-07.zip", sizeBytes: 4091968, sha256: "e21382f3c44c14d2e609cbda43c3bce346da715a4e17112087917be2369712a1" };
    installDesktopWindow();

    const chosen = await pickBackupFile();
    expect(chosen?.path).toContain("MotardERP-Backup-2026-10-07.zip");

    // The restore then posts a SMALL JSON body carrying the path + the shell's own size/sha256, which
    // the server re-verifies from the file's bytes before opening the archive.
    const res = await desktopFetch()("/api/backup/restore-path?confirm=replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: chosen!.path, sha256: chosen!.sha256, sizeBytes: chosen!.sizeBytes }),
    });

    expect(res.status).toBe(200);
    const apiCalls = invocations.filter((i) => i.cmd === "api");
    expect(apiCalls).toHaveLength(1);
    const sent = apiCalls[0].args?.req as { method: string; path: string; body: string };
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/api/backup/restore-path?confirm=replace");
    expect(JSON.parse(sent.body)).toMatchObject({ path: picked!.path, sha256: picked!.sha256, sizeBytes: picked!.sizeBytes });
    // The bridge carried a few hundred bytes of JSON, never 4 MB of zip.
    expect(sent.body.length).toBeLessThan(1000);
  });

  it("resolves null when the operator cancels the dialog, changing nothing", async () => {
    invocations = [];
    apiAnswer = { status: 200, headers: [], body: "{}" };
    picked = null;
    installDesktopWindow();

    await expect(pickBackupFile()).resolves.toBeNull();
    expect(invocations.filter((i) => i.cmd === "api")).toHaveLength(0);
  });
});
