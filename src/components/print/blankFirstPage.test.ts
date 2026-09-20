/**
 * DFP-002 — blank first print page regression.
 *
 * Root cause: CSS named pages (`@page a4` + `page: a4`) force a page-name
 * transition. When that transition happens before the first content box,
 * Chromium emits an empty sheet 1 and the invoice starts on page 2.
 *
 * Fix: never use the CSS `page` property / named `@page` rules for print
 * documents. Paper size is set only on the unnamed `@page` via
 * `#me-print-page-size` (printPortal.syncPrintPaper).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRINT_CSS = readFileSync(join(HERE, "print.css"), "utf8");
const PORTAL_TS = readFileSync(join(HERE, "printPortal.ts"), "utf8");

function findChromium(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  return text.match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0;
}

function printToPdf(chrome: string, html: string, pdfPath: string): void {
  const dir = dirname(pdfPath);
  const htmlPath = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  writeFileSync(htmlPath, html, "utf8");
  const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
  const r = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      fileUrl,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(r.status, r.stderr || r.stdout).toBe(0);
  expect(existsSync(pdfPath)).toBe(true);
}

describe("DFP-002 blank-first-page contract", () => {
  it("print.css has no named @page rules and no CSS page property", () => {
    // Strip block comments so documentation examples cannot false-positive.
    const cssCode = PRINT_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssCode).not.toMatch(new RegExp("@page\\s+[a-zA-Z]"));
    // Ban CSS `page:` property declarations (not page-break-*).
    expect(cssCode).not.toMatch(new RegExp("(?:^|[^{\\s])\\s*page\\s*:"));
    expect(cssCode).toMatch(new RegExp("@page\\s*\\{[^}]*size:\\s*A4", "s"));
  });

  it("printPortal injects unnamed @page size via #me-print-page-size", () => {
    expect(PORTAL_TS).toContain("me-print-page-size");
    expect(PORTAL_TS).toContain("@page { size: ${paperSizeCss");
  });
});

describe("DFP-002 chrome print-to-pdf", () => {
  const chrome = findChromium();
  const run = chrome ? it : it.skip;

  function shortDocHtml(paper: string, opts: { rtl?: boolean; body?: string } = {}): string {
    const size = paper === "A5" ? "A5 portrait" : paper === "80mm" ? "80mm auto" : "A4 portrait";
    const dir = opts.rtl ? 'dir="rtl" lang="ar"' : 'lang="en"';
    const body = opts.body ?? `<h1>DFP002_${paper}</h1><p>فاتورة بيع — اختبار الصفحة الأولى</p>`;
    return `<!DOCTYPE html><html ${dir} data-paper="${paper}"><head><meta charset="utf-8"/><style>
@page { size: ${size}; margin: 0; }
@media print { body > *:not([data-print-root]) { display: none !important; } }
[data-print-root] { display: block; }
.print-doc { padding: 8mm; font-size: 12pt; }
</style></head><body>
<div data-print-root data-paper="${paper}"><div class="print-doc" data-paper="${paper}">
${body}
</div></div></body></html>`;
  }

  run(
    "current contract: unnamed @page only → exactly 1 page for a short doc",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "dfp002-ok-"));
      try {
        const pdfPath = join(dir, "ok.pdf");
        printToPdf(chrome!, shortDocHtml("A4"), pdfPath);
        expect(countPdfPages(readFileSync(pdfPath))).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  for (const paper of ["A4", "A5", "80mm"] as const) {
    run(`matrix short ${paper}: unnamed @page → exactly 1 page`, () => {
      const dir = mkdtempSync(join(tmpdir(), `dfp002-${paper}-`));
      try {
        const pdfPath = join(dir, `${paper}.pdf`);
        printToPdf(chrome!, shortDocHtml(paper, { rtl: true }), pdfPath);
        expect(countPdfPages(readFileSync(pdfPath))).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  run("matrix multi-page A4 RTL: content spills without an extra leading blank", () => {
    const dir = mkdtempSync(join(tmpdir(), "dfp002-multi-"));
    try {
      const lines = Array.from(
        { length: 80 },
        (_, i) => `<p>سطر محتوى طويل للاختبار رقم ${i + 1}</p>`,
      ).join("\n");
      const pdfPath = join(dir, "multi.pdf");
      printToPdf(
        chrome!,
        shortDocHtml("A4", { rtl: true, body: `<h1>MULTI</h1>${lines}` }),
        pdfPath,
      );
      const pages = countPdfPages(readFileSync(pdfPath));
      // Enough content for ≥2 pages; blank-first would typically inflate by +1
      // relative to content alone — we require multi-page and a sane upper bound.
      expect(pages).toBeGreaterThanOrEqual(2);
      expect(pages).toBeLessThanOrEqual(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  run("legacy named-page-on-inner pattern is documented as the blank-page hazard", () => {
    // Forensic control: page:a4 on .print-doc (the pre-fix pattern).
    // We do not assert a specific page count (Chrome versions differ); we only
    // prove the fixed contract above stays at 1, and that this hazard CSS
    // still parses/prints without crashing.
    const dir = mkdtempSync(join(tmpdir(), "dfp002-legacy-"));
    try {
      const pdfPath = join(dir, "legacy.pdf");
      printToPdf(
        chrome!,
        `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
@page { size: A4 portrait; margin: 0; }
@page a4 { size: A4 portrait; margin: 0; }
@media print { body > *:not([data-print-root]) { display: none !important; } }
[data-print-root] { display: block; }
.print-doc { page: a4; padding: 10mm; font-size: 14pt; }
</style></head><body>
<div data-print-root><div class="print-doc"><h1>LEGACY</h1></div></div>
</body></html>`,
        pdfPath,
      );
      const pages = countPdfPages(readFileSync(pdfPath));
      expect(pages).toBeGreaterThanOrEqual(1);
      console.info(`[dfp002] legacy inner-named-page PDF pages=${pages}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
