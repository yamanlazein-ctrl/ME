import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFingerprintProvider, TauriDesktopFingerprintProvider, TauriMobileFingerprintProvider } from "@/infrastructure/fingerprint/NodeFingerprintProvider";
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

  it("DFP-039 canonical envelope hash is stable for a known vector", async () => {
    const provider = new NodeFingerprintProvider();
    const input = {
      platform: "node" as const,
      version: 1,
      signals: {
        cpu_model: "x",
        hostname: "h",
        platform_release: "win32 10",
      },
    };
    expect(await provider.compute(input)).toBe(
      "6caa9e386ac42f8a20edb067201db3d1784c14f3fd8b6e9ed977f9cd10a05481",
    );
    expect(await provider.compute({ ...input, platform: "tauri-desktop" })).toBe(
      "d8c84ceade7eb700c75a2f606c5aa4ac8184ac57942dcb7792e48ca8da88d59f",
    );
  });

  it("DFP-039 platform providers are reachable and share the algorithm", async () => {
    for (const Provider of [TauriDesktopFingerprintProvider, TauriMobileFingerprintProvider]) {
      const provider = new Provider();
      const input = await provider.collect();
      expect(input.platform).toMatch(/^tauri-/);
      expect(await provider.compute(input)).toMatch(/^[0-9a-f]{64}$/);
      expect((await provider.getMetadata(input)).hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("DFP-039 missing signals still hash from present keys only", async () => {
    const provider = new NodeFingerprintProvider();
    const minimal = {
      platform: "node" as const,
      version: 1,
      signals: { hostname: "only-host" },
    };
    const hash = await provider.compute(minimal);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const meta = await provider.getMetadata(minimal);
    expect(meta.signals).toEqual(["hostname"]);
    expect(meta.confidence).toBe("low");
  });

  it("DFP-039 hardware-change policy: signal change ⇒ new fingerprint (re-activation)", async () => {
    // Product policy: when durable signals change (MAC/machine_id/hostname),
    // the hash changes and the device must re-activate — we never rewrite
    // history to keep a stale binding.
    const provider = new NodeFingerprintProvider();
    const before = {
      platform: "node" as const,
      version: 1,
      signals: {
        hostname: "desk-a",
        primary_mac: "aa:bb:cc:dd:ee:ff",
        machine_id: "mid-1",
      },
    };
    const afterNicSwap = {
      ...before,
      signals: { ...before.signals, primary_mac: "11:22:33:44:55:66" },
    };
    const h1 = await provider.compute(before);
    const h2 = await provider.compute(afterNicSwap);
    expect(h1).not.toBe(h2);
    expect(await provider.getMetadata(before)).toMatchObject({ confidence: "high" });
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
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
