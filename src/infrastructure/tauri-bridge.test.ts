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
    const invoke = vi.fn(async (cmd: string) =>
      cmd === "get_fingerprint"
        ? { hash: "h", hostname: "pc", os: "windows" }
        : "https://hub.example",
    );
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const { getDesktopFingerprint, getHubUrl, requestFactoryReset } = await load();

    await expect(getDesktopFingerprint()).resolves.toEqual({
      hash: "h",
      hostname: "pc",
      os: "windows",
    });
    await expect(getHubUrl()).resolves.toBe("https://hub.example");
    await requestFactoryReset();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "get_fingerprint",
      "get_hub_url",
      "request_factory_reset",
    ]);
  });

  it("reports a clear error when the IPC function is missing", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { getHubUrl } = await load();
    await expect(getHubUrl()).rejects.toThrow(/IPC/);
  });

  it("stays a no-op on the plain web build", async () => {
    vi.stubGlobal("window", {});
    const { getHubUrl } = await load();
    await expect(getHubUrl()).resolves.toBe("");
  });
});
