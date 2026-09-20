import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiBaseUrl, getRuntimeApiBaseUrl, setRuntimeApiBaseUrl } from "./api-base-url";

describe("getApiBaseUrl desktop deploy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      localStorage.removeItem("erp.runtime.apiBaseUrl");
    } catch {
      /* ignore */
    }
  });

  it("stays on the local API after a hub URL is saved in localStorage", () => {
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "true");
    vi.stubEnv("VITE_API_BASE_URL", "/api");
    try {
      localStorage.setItem("erp.runtime.apiBaseUrl", "https://hub.example.com");
    } catch {
      /* ignore */
    }
    setRuntimeApiBaseUrl("https://hub.example.com");
    expect(getRuntimeApiBaseUrl()).toBe("");
    // Desktop uses same-origin SSR proxy; hub URL must not redirect API traffic.
    expect(getApiBaseUrl()).toBe("");
  });
});
