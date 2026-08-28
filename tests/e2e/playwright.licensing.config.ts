import { defineConfig } from "@playwright/test";

/**
 * حارس «قفل الترخيص» الدائم.
 * اختبار API + قاعدة بيانات ضد الخلفية الحية (8080) — لا يحتاج متصفحاً ولا واجهة.
 * لا يبدأ خوادم بنفسه (لا webServer). كل القيم قابلة للتجاوز عبر متغيرات البيئة.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "licensing-lock-in.spec.ts",
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.ERP_BACKEND_URL ?? "http://127.0.0.1:8080",
    screenshot: "off",
    trace: "off",
  },
  projects: [{ name: "api", use: {} }],
  reporter: [["list"]],
});
