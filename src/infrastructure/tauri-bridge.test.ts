import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: the bridge used to `import("@tauri-apps/api/core")` at runtime, which can never resolve inside
 * the desktop webview ("Failed to resolve module specifier") and broke every desktop-only feature.
 * It must call the IPC function Tauri injects on the window instead.
 */
describe("tauri-bridge IPC", () => {
  // The bridge caches the resolved `invoke` at module level — load a fresh copy per test.
  const load = async () => {
    vi.resetModules();
    return import("./tauri-bridge");
  };
  afterEach(() => vi.unstubAllGlobals());

  it("invokes commands through window.__TAURI_INTERNALS__.invoke", async () => {
    const invoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) =>
      cmd === "get_fingerprint"
        ? { hash: "h", hostname: "pc", os: "windows" }
        : { dataRoot: "C:\\data", profile: "release" },
    );
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const { getDesktopFingerprint, getDataRoot, requestFactoryReset } = await load();

    await expect(getDesktopFingerprint()).resolves.toEqual({
      hash: "h",
      hostname: "pc",
      os: "windows",
    });
    await expect(getDataRoot()).resolves.toMatchObject({ profile: "release" });
    await requestFactoryReset("احذف كل البيانات");
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "get_fingerprint",
      "get_data_root",
      "request_factory_reset",
    ]);
    // The typed phrase travels to the shell, which is the authority that checks it (DESK-006).
    expect(invoke.mock.calls[2][1]).toEqual({ confirm: "احذف كل البيانات" });
  });

  it("reports a clear error when the IPC function is missing", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { getDataRoot } = await load();
    await expect(getDataRoot()).rejects.toThrow(/IPC/);
  });

  it("stays a no-op on the plain web build", async () => {
    vi.stubGlobal("window", {});
    const { getDataRoot } = await load();
    await expect(getDataRoot()).resolves.toBeNull();
  });
});
