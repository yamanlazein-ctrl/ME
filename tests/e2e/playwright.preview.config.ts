import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "print-preview-snap.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8081",
    screenshot: "on",
    trace: "on-first-retry",
    headless: true,
  },
});
