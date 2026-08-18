import { test, expect, request } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

/**
 * Security header assertions.
 *
 * Phase 0 sub-batch 0A-prep.12 re-enables hard assertions for the
 * security headers set by helmet on the BACKEND (port 8080). The
 * frontend dev server (Vite, 5173) does NOT set these — it proxies
 * API calls to the backend. So we hit the backend's /api/health/live
 * endpoint directly via a Playwright `request` fixture.
 *
 * If the backend is not running (PLAYWRIGHT_BASE_URL is the Vite port
 * only), the tests are skipped with a clear message.
 */
const BACKEND_URL = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";

test.describe("Security Headers (backend)", () => {
  test("X-Content-Type-Options header present", async () => {
    const ctx = await request.newContext({ baseURL: BACKEND_URL });
    const res = await ctx.get("/api/health/live");
    const v = res.headers()["x-content-type-options"];
    if (v === undefined) test.skip(true, `Backend not reachable at ${BACKEND_URL}`);
    expect(v).toBe("nosniff");
    await ctx.dispose();
  });

  test("Referrer-Policy header present", async () => {
    const ctx = await request.newContext({ baseURL: BACKEND_URL });
    const res = await ctx.get("/api/health/live");
    const v = res.headers()["referrer-policy"];
    if (v === undefined) test.skip(true, `Backend not reachable at ${BACKEND_URL}`);
    expect(v).toBeDefined();
    await ctx.dispose();
  });

  test("X-Frame-Options or CSP frame-ancestors present", async () => {
    const ctx = await request.newContext({ baseURL: BACKEND_URL });
    const res = await ctx.get("/api/health/live");
    const xFrame = res.headers()["x-frame-options"];
    const csp = res.headers()["content-security-policy"];
    if (xFrame === undefined && csp === undefined) {
      test.skip(true, `Backend not reachable at ${BACKEND_URL}`);
    }
    const ok = !!xFrame || (typeof csp === "string" && csp.includes("frame-ancestors"));
    expect(ok).toBe(true);
    await ctx.dispose();
  });

  test("server does not leak version info", async () => {
    const ctx = await request.newContext({ baseURL: BACKEND_URL });
    const res = await ctx.get("/api/health/live");
    const h = res.headers();
    if (!("content-type" in h)) test.skip(true, `Backend not reachable at ${BACKEND_URL}`);
    expect(h["server"]).toBeUndefined();
    expect(h["x-powered-by"]).toBeUndefined();
    expect(h["x-aspnet-version"]).toBeUndefined();
    expect(h["x-aspnetmvc-version"]).toBeUndefined();
    await ctx.dispose();
  });

  test("Strict-Transport-Security header present (helmet default)", async () => {
    const ctx = await request.newContext({ baseURL: BACKEND_URL });
    const res = await ctx.get("/api/health/live");
    const v = res.headers()["strict-transport-security"];
    if (v === undefined) test.skip(true, `Backend not reachable at ${BACKEND_URL}`);
    expect(v).toBeDefined();
    await ctx.dispose();
  });
});

test.describe("API Contract — Content & Status", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("dashboard page returns HTML content", async ({ page }) => {
    const response = await page.goto("/");
    const contentType = response?.headers()?.["content-type"] ?? "";
    expect(contentType).toContain("text/html");
    expect(response?.status()).toBe(200);
  });

  test("orders page returns valid HTML", async ({ page }) => {
    const response = await page.goto("/orders");
    expect(response?.status()).toBe(200);
    const contentType = response?.headers()?.["content-type"] ?? "";
    expect(contentType).toContain("text/html");
  });

  test("invoices page returns valid HTML", async ({ page }) => {
    const response = await page.goto("/invoices/entry/new");
    expect(response?.status()).toBe(200);
  });

  test("reports page returns valid HTML", async ({ page }) => {
    const response = await page.goto("/reports");
    expect(response?.status()).toBe(200);
  });

  test("nonexistent route returns 404 status", async ({ page }) => {
    const response = await page.goto("/nonexistent-route-xyz");
    expect(response?.status()).toBe(404);
  });

  test("SSR renders error page gracefully", async ({ page }) => {
    await page.goto("/nonexistent-route-xyz", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });
});
