import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8081";

export default defineConfig({
  timeout: 120_000,
  retries: 0,
  fullyParallel: true,
  workers: 4,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "cert-route",
      testDir: "./tests/e2e/cert-route",
      testMatch: "*.spec.ts",
      timeout: 300_000,
    },
    {
      name: "cert-ui",
      testDir: "./tests/e2e/cert-ui",
      testMatch: "*.spec.ts",
      timeout: 600_000,
      dependencies: ["cert-route"],
    },
    {
      name: "cert-financial",
      testDir: "./tests/e2e/cert-financial",
      testMatch: "*.spec.ts",
      timeout: 900_000,
      dependencies: ["cert-ui"],
    },
    {
      name: "cert-report",
      testDir: "./tests/e2e/cert-report",
      testMatch: "*.spec.mjs",
      dependencies: ["cert-financial"],
    },
  ],
});
