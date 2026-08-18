import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
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
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  reporter: [
    ["html", { outputFolder: "test-results/report", open: "never" }],
    ["list"],
  ],
});