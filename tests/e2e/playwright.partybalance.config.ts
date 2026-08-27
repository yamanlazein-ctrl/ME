import { defineConfig } from "@playwright/test";

/**
 * خصّيص لحارس «رصيد الطرف غير الموحّد».
 * يشغّل spec واحداً ضد خوادم حية (الواجهة 5173 / الخلفية 8080) — لا يبدأ خوادم
 * بنفسه، فلا يعتمد على أي webServer. كل القيم قابلة للتجاوز عبر متغيرات البيئة.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "party-balance-consistency.spec.ts",
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.ERP_FRONTEND_URL ?? "http://localhost:5173",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: [["list"]],
});