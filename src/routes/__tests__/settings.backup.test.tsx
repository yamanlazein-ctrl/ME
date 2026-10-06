/**
 * T100 (specs/001-desktop-sqlite-engine, U-2 / I-11): the full-backup download.
 *
 *   - Without Tauri (web / cloud) the path is unchanged: POST /api/backup/full, the zip is saved by an
 *     anchor download named from Content-Disposition, and no desktop command is called.
 *   - Inside Tauri the zip never crosses the text-only bridge: the server is asked for the VERIFIED
 *     file's identity and the shell's save_backup_file must return the same size + sha256.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deliverFullBackup } from "@/lib/fullBackupDelivery";

type Clicked = { href: string; download: string };

function browserStubs() {
  const clicked: Clicked[] = [];
  const doc = {
    createElement: () => {
      const a = {
        href: "",
        download: "",
        click: () => clicked.push({ href: a.href, download: a.download }),
      };
      return a;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:zip", revokeObjectURL: () => {} });
  return clicked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("full backup — web path (no Tauri) is unchanged", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {}); // a browser window with no Tauri internals
  });

  it("streams /api/backup/full and saves it through an anchor download", async () => {
    const clicked = browserStubs();
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([80, 75, 3, 4, 1, 2, 3]), {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="MotardERP-Backup-2026-10-04.zip"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await deliverFullBackup("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/backup/full");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(clicked).toEqual([{ href: "blob:zip", download: "MotardERP-Backup-2026-10-04.zip" }]);
    expect(out).toEqual({ name: "MotardERP-Backup-2026-10-04.zip", sizeBytes: 7, verified: false });
  });

  it("surfaces the server's error message", async () => {
    browserStubs();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "نسخة احتياطية قيد التشغيل" }), { status: 429 }),
      ),
    );
    await expect(deliverFullBackup(null)).rejects.toThrow("نسخة احتياطية قيد التشغيل");
  });
});

describe("full backup — desktop path (Tauri)", () => {
  const meta = {
    status: "VERIFIED",
    fileName: "MotardERP-Backup-2026-10-04.zip",
    path: "C:\\root\\backups\\manual-x.zip",
    sizeBytes: 1234,
    sha256: "ab".repeat(32),
  };
  // one mock for the whole block: the bridge caches the injected invoke after the first call
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(meta), { status: 200 })),
    );
  });

  it("asks for the VERIFIED file's identity and saves it through the shell", async () => {
    invoke.mockResolvedValue({ path: "D:\\saved.zip", sizeBytes: 1234, sha256: "ab".repeat(32) });
    const out = await deliverFullBackup("tok");
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("/api/backup/full?deliver=metadata");
    expect(invoke).toHaveBeenCalledWith("save_backup_file", {
      sourcePath: meta.path,
      expectedSha256: meta.sha256,
      expectedSize: 1234,
      suggestedName: meta.fileName,
    });
    expect(out).toEqual({
      name: "D:\\saved.zip",
      sizeBytes: 1234,
      sha256: "ab".repeat(32),
      verified: true,
    });
  });

  it("a cancelled save dialog is not an error", async () => {
    invoke.mockResolvedValue(null);
    expect(await deliverFullBackup("tok")).toBeNull();
  });

  it("never reports success when the saved copy does not match", async () => {
    invoke.mockResolvedValue({ path: "D:\\saved.zip", sizeBytes: 1234, sha256: "cd".repeat(32) });
    await expect(deliverFullBackup("tok")).rejects.toThrow("لا يطابق");
  });
});
