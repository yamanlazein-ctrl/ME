import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Relative to THIS file (M-08: "./tests/e2e" resolved to tests/e2e/tests/e2e and found nothing).
  // The cert-* suites need the disposable cert stack and run under playwright.cert.config.ts.
  testDir: ".",
  testIgnore: ["cert-*/**"],
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:8081",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "echo using-existing-server",
    url: "http://localhost:8081",
    reuseExistingServer: true,
    timeout: 5_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: [["html", { outputFolder: "test-results/report", open: "never" }], ["list"]],
});
