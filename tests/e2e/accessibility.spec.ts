import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ADMIN = { email: "admin@erp.local", password: "admin123" };

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const emailInput = page.locator('input[placeholder="admin@erp.local"]');
  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  await emailInput.fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 30_000 });
}

// صفحات أساسية يُفحص عليها الوصولية. أضف المزيد حسب الحاجة.
const PAGES = ["/", "/invoices", "/orders", "/inventory"];

for (const path of PAGES) {
  test(`Accessibility — ${path} (no critical/serious violations)`, async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    const results = await new AxeBuilder({ page }).analyze();
    const blockers = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    expect(
      blockers.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`),
      `Critical/serious accessibility violations on ${path}`,
    ).toEqual([]);
  });
}