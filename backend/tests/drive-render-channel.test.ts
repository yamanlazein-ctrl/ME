/**
 * Remediation Stage 3 — Task 3.9 (E-14): the render channel.
 *
 * The backend owns the documents, the shell owns the renderer, and neither can call the other:
 * the shell reaches the backend over the runtime pipe, and the backend has no channel to the shell.
 * So the request is queued in `motard_drive_renders`, PULLED by the shell, and the rendered file
 * comes back over the same route.
 *
 * These tests are the SHELL's side of that contract, written against the real routes: what the
 * shell pulls, and what the shell posts back. The Rust loop implements exactly this.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-render-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
process.env.DESKTOP_DEPLOY = "true";
process.env.APP_MASTER_KEY = "render-test-master-key";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-render-bk-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

const RUNTIME_TOKEN = createHash("sha256").update(process.env.APP_MASTER_KEY!).digest("hex");

let raw: import("better-sqlite3").Database;
let bridge: typeof import("../src/infrastructure/googledrive/renderBridge.js");
let db: unknown;

beforeAll(async () => {
  await import("../src/infrastructure/orm/sqlite/runtime.js").then((m) =>
    m.ensureSqliteRuntime({}),
  );
  const rt = (await import("../src/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime()!;
  raw = rt.conns.writer;
  db = rt.conns.writerDb;
  bridge = await import("../src/infrastructure/googledrive/renderBridge.js");
  const tenantId = randomUUID();
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'render', 'render-test')`)
    .run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`).run(randomUUID(), tenantId);
});

beforeEach(() => {
  raw.prepare(`DELETE FROM motard_drive_renders`).run();
});

describe("the render channel", () => {
  it("queues a request the shell can pull", async () => {
    const id = await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-1",
      format: "pdf",
      outName: "doc.pdf",
      paper: "A4",
      html: "<html><body>فاتورة</body></html>",
    });
    expect(id).toBeTruthy();

    const pending = await bridge.pendingRenders(db as never);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    // The shell needs the run (its staging directory), the format, the file name and the HTML.
    expect(pending[0].runId).toBe("run-1");
    expect(pending[0].format).toBe("pdf");
    expect(pending[0].outName).toBe("doc.pdf");
    expect(pending[0].paper).toBe("A4");
    expect(pending[0].html).toContain("فاتورة");
  });

  it("hands the shell only the PENDING requests", async () => {
    await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-1",
      format: "pdf",
      outName: "a.pdf",
      html: "<html></html>",
    });
    const second = await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-2",
      format: "png",
      outName: "b.png",
      html: "<html></html>",
    });
    expect(await bridge.pendingRenders(db as never)).toHaveLength(2);

    // The shell reports the first one: it must not be offered again.
    await bridge.completeRender(db as never, second, { path: "C:/x/b.png", sha256: "aa" });
    const left = await bridge.pendingRenders(db as never);
    expect(left).toHaveLength(1);
    expect(left[0].outName).toBe("a.pdf");
  });

  it("re-hashes the staged file instead of trusting the shell's hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motard-artifact-"));
    const file = join(dir, "doc.pdf");
    const bytes = Buffer.from("%PDF-1.4 real content");
    writeFileSync(file, bytes);
    const real = createHash("sha256").update(bytes).digest("hex");

    const id = await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-1",
      format: "pdf",
      outName: "doc.pdf",
      html: "<html></html>",
    });
    // The shell claims a DIFFERENT hash: the backend must not believe it.
    await bridge.completeRender(db as never, id, {
      path: file,
      sha256: "0".repeat(64),
      sizeBytes: 1,
    });

    const outcome = await bridge.awaitRender(db as never, id, 1_000);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.sha256).toBe(real);
      expect(outcome.sizeBytes).toBe(bytes.length);
    }
  });

  it("reports a failed render as failed, and a missing shell as absent", async () => {
    const id = await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-1",
      format: "pdf",
      outName: "doc.pdf",
      html: "<html></html>",
    });
    await bridge.completeRender(db as never, id, { error: "الخطأ" });
    const failed = await bridge.awaitRender(db as never, id, 1_000);
    expect(failed.kind).toBe("failed");

    // A request nobody picks up is "absent" — there is no shell on the other end. That is what
    // tells the archive to fall back to the CSV export instead of waiting for the full timeout.
    const orphan = await bridge.requestRender(db as never, {
      runId: "run-1",
      artifactId: "inv-2",
      format: "pdf",
      outName: "doc2.pdf",
      html: "<html></html>",
    });
    const absent = await bridge.awaitRender(db as never, orphan, 150);
    expect(absent.kind).toBe("absent");
  });
});
