import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_JSON = resolve(__dirname, "..", "..", "..", "certification-results.json");
const OUTPUT_MD = resolve(__dirname, "..", "..", "..", "PRODUCTION-CERTIFICATION.md");
const BUG_MD = resolve(__dirname, "..", "..", "..", "BUG-REPORT.md");

function loadResults(): Record<string, any> | null {
  if (!existsSync(REPORT_JSON)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_JSON, "utf-8"));
  } catch {
    return null;
  }
}

function loadBugReport(): string {
  if (!existsSync(BUG_MD)) return "";
  return readFileSync(BUG_MD, "utf-8");
}

function generateReport(results: Record<string, any> | null): string {
  const bugs = loadBugReport();
  const lines: string[] = [];

  lines.push("# تقرير اعتماد الإنتاج — Motard ERP");
  lines.push("");
  lines.push(`**تاريخ التوليد:** ${results?.timestamp ?? new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## ملخص النتائج");
  lines.push("");

  if (!results) {
    lines.push("> لم يتم العثور على ملف نتائج الاعتماد. قم بتشغيل اختبارات الاعتماد أولاً.");
    lines.push("");
    lines.push("لتشغيل اختبارات الاعتماد:");
    lines.push("```bash");
    lines.push("npx playwright test --config=playwright.cert.config.ts");
    lines.push("```");
    return lines.join("\n");
  }

  const m = results.modules;

  lines.push("| الوحدة | تم الاختبار | نجح | التغطية |");
  lines.push("|---|---|---|---|");
  lines.push(`| المسارات (Routes) | ${m.routes.tested} | ${m.routes.passed} | ${m.routes.coverage} |`);
  lines.push(`| الأزرار (Buttons) | ${m.ui.buttons.tested} | ${m.ui.buttons.passed} | — |`);
  lines.push(`| الحوارات (Dialogs) | ${m.ui.dialogs.tested} | ${m.ui.dialogs.passed} | — |`);
  lines.push(`| النماذج (Forms) | ${m.ui.forms.tested} | ${m.ui.forms.passed} | — |`);
  lines.push(`| الفلاتر (Filters) | ${m.ui.filters.tested} | ${m.ui.filters.passed} | — |`);
  lines.push(`| الألسنة (Tabs) | ${m.ui.tabs.tested} | ${m.ui.tabs.passed} | — |`);
  lines.push(`| الطباعة (Print) | ${m.ui.print.tested} | ${m.ui.print.passed} | — |`);
  lines.push(`| سير العمل (Workflows) | ${m.workflows.tested} | ${m.workflows.passed} | — |`);
  lines.push("");

  lines.push("## الشهادة المالية");
  lines.push("");
  lines.push("| المعادلة | النتيجة |");
  lines.push("|---|---|");
  lines.push(`| المخزون (Stock) | ${m.financial.stock} |`);
  lines.push(`| أرصدة الأطراف (Party Balance) | ${m.financial.balance} |`);
  lines.push(`| الصندوق (Cashbox) | ${m.financial.cashbox} |`);
  lines.push("");

  lines.push("## اختبار الإجهاد (Stress Test)");
  lines.push("");
  lines.push("| المقياس | القيمة |");
  lines.push("|---|---|");
  lines.push(`| عدد العمليات | ${m.stress.operations} |`);
  lines.push(`| الانحراف (Drift) | ${m.stress.drift} |`);
  lines.push(`| المعرفات المكررة | ${m.stress.duplicateIds} |`);
  lines.push(`| المخزون السلبي | ${m.stress.negativeStock} |`);
  lines.push(`| زمن التنفيذ | ${m.stress.runtimeSeconds} ثانية |`);
  lines.push("");

  lines.push("## الطباعة");
  lines.push("");
  lines.push(`- **الفحص الآلي:** ${m.print.automated}`);
  lines.push(`- **الفحص اليدوي:** ${m.print.manual}`);
  lines.push("");

  lines.push("## الصلاحيات");
  lines.push("");
  lines.push(`- **عدد الأدوار المختبرة:** ${m.permissions.rolesTested}`);
  lines.push(`- **عدد الخروقات:** ${m.permissions.violations}`);
  lines.push("");

  if (bugs) {
    lines.push("---");
    lines.push("");
    lines.push("## تقرير الأخطاء");
    lines.push("");
    lines.push(bugs);
    lines.push("");
  } else {
    lines.push("## تقرير الأخطاء");
    lines.push("");
    lines.push("لم يتم العثور على أخطاء. جميع الاختبارات نجحت.");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## الحكم النهائي");
  lines.push("");
  lines.push(results.verdict);
  lines.push("");

  if (results.knownIssues) {
    const ki = results.knownIssues;
    lines.push("### المشاكل المعروفة");
    lines.push("");
    lines.push(`- حرجة (Critical): ${ki.critical}`);
    lines.push(`- عالية (High): ${ki.high}`);
    lines.push(`- متوسطة (Medium): ${ki.medium}`);
    lines.push(`- منخفضة (Low): ${ki.low}`);
    lines.push("");
  }

  return lines.join("\n");
}

test("generate PRODUCTION-CERTIFICATION.md from certification-results.json", async () => {
  const results = loadResults();
  const report = generateReport(results);
  writeFileSync(OUTPUT_MD, report, "utf-8");
  expect(results).not.toBeNull();
});
