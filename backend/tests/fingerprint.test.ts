import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFingerprintProvider } from "@/infrastructure/fingerprint/NodeFingerprintProvider";
import { InstallationIdStorage } from "@/infrastructure/installation/InstallationIdStorage";

describe("NodeFingerprintProvider", () => {
  it("collects at least the hostname signal on every platform", async () => {
    const provider = new NodeFingerprintProvider();
    const input = await provider.collect();
    expect(input.platform).toBe("node");
    expect(input.version).toBe(1);
    expect(input.signals.hostname).toBeDefined();
    expect(input.signals.hostname.length).toBeGreaterThan(0);
  });

  it("computes a deterministic SHA-256 hex of length 64", async () => {
    const provider = new NodeFingerprintProvider();
    const input = await provider.collect();
    const hash = await provider.compute(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across re-collection of the same host", async () => {
    const provider = new NodeFingerprintProvider();
    const a = await provider.collect();
    const b = await provider.collect();
    const ha = await provider.compute(a);
    const hb = await provider.compute(b);
    // Hostname + MAC + machine_id are stable; the hashes match.
    expect(ha).toBe(hb);
  });

  it("returns metadata with the correct confidence and signal list", async () => {
    const provider = new NodeFingerprintProvider();
    const input = await provider.collect();
    const meta = await provider.getMetadata(input);
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.platform).toBe("node");
    expect(meta.version).toBe(1);
    expect(meta.signals.length).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(meta.confidence);
  });
});

describe("InstallationIdStorage", () => {
  let dir: string;
  let storage: InstallationIdStorage;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "erp-install-id-"));
    path = join(dir, "install-id");
    storage = new InstallationIdStorage(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no file exists", async () => {
    expect(await storage.read()).toBeNull();
  });

  it("readOrCreate generates and persists a UUID", async () => {
    const id1 = await storage.readOrCreate();
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(id1);
  });

  it("readOrCreate is idempotent", async () => {
    const id1 = await storage.readOrCreate();
    const id2 = await storage.readOrCreate();
    expect(id1).toBe(id2);
  });

  it("write overwrites the previous id", async () => {
    await storage.readOrCreate();
    const newId = "11111111-2222-3333-4444-555555555555";
    await storage.write(newId);
    expect(await storage.read()).toBe(newId);
  });
});
