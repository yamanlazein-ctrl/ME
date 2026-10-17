// Task 3: normal startup must not expose technical step names or raw data paths.
// The boot page may show the version and data folder only on the recovery screen.
//
//   node --test desktop-app/scripts/boot-screen.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = join(APP, "src-tauri", "pages");
const html = readFileSync(join(PAGES, "boot.html"), "utf8");
const js = readFileSync(join(PAGES, "boot.js"), "utf8");

// Internal step names set by boot.rs; they must never reach the starting screen.
const TECHNICAL_STEPS = [
  "إنشاء قاعدة بيانات الشركة",
  "تشغيل الخادم المحلي",
  "فحص قاعدة البيانات",
  "فتح مفاتيح التثبيت",
  "نسخ احتياطي قبل التحديث",
  "نقل بيانات الشركة الحالية جانباً",
  "بدء التشغيل",
];

// The starting section is everything between id="starting" and the recovery section.
function startingSection() {
  const start = html.indexOf('id="starting"');
  const end = html.indexOf('id="recovery"');
  assert.ok(start > 0 && end > start, "boot.html must contain starting and recovery sections");
  return html.slice(start, end);
}

test("starting section shows no technical step text", () => {
  const section = startingSection();
  for (const step of TECHNICAL_STEPS) {
    assert.ok(!section.includes(step), `starting screen must not show "${step}"`);
  }
  assert.ok(!/id="step"/.test(section), "starting screen must not render the raw step element");
});

test("data folder and version are not in the starting section", () => {
  const section = startingSection();
  assert.ok(!section.includes('id="root"'), "data path must not render during startup");
  assert.ok(!section.includes('id="ver"'), "version must not render during startup");
  assert.ok(!section.includes("مجلد البيانات"), "data folder label must not render during startup");
});

test("footer diagnostics live inside the recovery section only", () => {
  const recoveryStart = html.indexOf('id="recovery"');
  const footerIdx = html.indexOf("<footer>");
  assert.ok(footerIdx > recoveryStart, "footer must come after the recovery section opens");
  const recoveryEnd = html.indexOf("</section>", recoveryStart);
  assert.ok(footerIdx < recoveryEnd, "footer must be inside the recovery section");
});

test("boot.js fills the step, version and data path only for recovery", () => {
  assert.ok(!/\$\("step"\)/.test(js), "boot.js must not write the step text");
  const verIdx = js.indexOf('$("root").textContent');
  const recoveryGate = js.indexOf('st.phase === "recovery"');
  assert.ok(
    verIdx > 0 && recoveryGate > 0 && recoveryGate < verIdx,
    "root/ver must be gated on recovery",
  );
});
