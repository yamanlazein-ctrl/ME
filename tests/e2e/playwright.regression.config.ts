import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "regression-smoke.spec.ts",
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8081",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "echo using-existing-server",
    url: "http://localhost:8081",
    reuseExistingServer: true,
    timeout: 5_000,
  },
  reporter: [["list"]],
});
