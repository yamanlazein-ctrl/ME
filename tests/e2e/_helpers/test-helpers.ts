import { type Page, expect } from "@playwright/test";

/**
 * Shared test utilities for certification specs.
 */

export const CONSOLE_NOISE = ["favicon", "Failed to load resource", "net::ERR_"];

/**
 * Collect console errors during the callback and return the filtered list.
 * Filters out known noise (favicon, resource load failures, net::ERR_).
 */
export async function captureConsoleErrors(
  page: Page,
  fn: () => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  const handler = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") errors.push(msg.text());
  };
  page.on("console", handler);
  await fn();
  page.off("console", handler);
  return errors.filter((e) => !CONSOLE_NOISE.some((s) => e.includes(s)));
}

/**
 * Assert the body is not a white screen (has children and text).
 */
export async function assertNotWhiteScreen(page: Page): Promise<void> {
  const white = await page.evaluate(() => {
    const b = document.body;
    return !b || b.children.length === 0 || b.innerText.trim().length === 0;
  });
  expect(white).toBe(false);
}

/**
 * Wait for the app to be stable after navigation.
 */
export async function waitForStable(page: Page, ms = 2000): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Navigate and check the route: loads without crash, no white screen, no console errors.
 */
export async function assertRouteOk(
  page: Page,
  path: string,
): Promise<{ errors: string[]; status: number | null }> {
  const errors = await captureConsoleErrors(page, async () => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForStable(page);
  });
  await assertNotWhiteScreen(page);
  const status = await page.evaluate(() => {
    // @ts-expect-error SPA may not set this
    return (window as Record<string, unknown>).__pageStatus ?? null;
  });
  return { errors, status };
}

/**
 * Get the backend URL from env or default.
 */
export function backendUrl(): string {
  return process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";
}
