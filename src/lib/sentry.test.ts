import { describe, it, expect, vi, beforeEach } from "vitest";

const { init, captureException } = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/react", () => ({ init, captureException }));

import { initSentry } from "./sentry";

const DSN = "https://public@o0.ingest.sentry.io/0";

describe("initSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { location: { pathname: "/" } });
  });

  it("stays off without a DSN", () => {
    expect(initSentry({})).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("stays off on the desktop build (offline-first; its CSP allows no external connect)", () => {
    expect(initSentry({ VITE_SENTRY_DSN: DSN, VITE_DESKTOP_DEPLOY: "true" })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("starts on the web build with the DSN and no PII, and feeds reportError's hook", () => {
    expect(initSentry({ VITE_SENTRY_DSN: DSN, MODE: "production" })).toBe(true);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: DSN, environment: "production", sendDefaultPii: false }),
    );
    const err = new Error("boom");
    window.__errorReporter?.captureException?.(err, { route: "/x" });
    expect(captureException).toHaveBeenCalledWith(err, { extra: { route: "/x" } });
  });
});
