import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { getQueryClient } from "@/infrastructure/queryClient";
import { refreshInventory } from "@/presentation/hooks/useInventory";
import {
  archiveDocumentPdf,
  ensureDocumentFolders,
  isTauri,
  type ArchiveDocType,
} from "@/infrastructure/tauri-bridge";

/**
 * Unified print portal.
 *
 * Renders the document node into a detached [data-print-root] container
 * appended directly to <body>, then triggers window.print(). print.css hides
 * every body sibling except [data-print-root] during @media print, so only
 * the document is printed — never the app shell.
 *
 * IMPORTANT: React 18/19 `createRoot().render()` is ASYNC — the DOM is not
 * committed until a microtask/task later. Calling window.print() before the
 * commit produces a BLANK WHITE PAGE. We therefore wrap the render in
 * `flushSync()` so the document is fully committed to the DOM before the
 * print dialog opens.
 *
 * Issue 12: when running inside Tauri, also archives a PDF (or HTML fallback)
 * into Desktop/أقمشة ومنسوجات/<doc-type>/ after the DOM commit.
 */

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;
let activeFingerprint: string | null = null;
/** Saved so we can blank document.title during print (kills browser header text). */
let previousDocumentTitle: string | null = null;

export type PrintArchiveMeta = {
  docType: ArchiveDocType;
  /** Base filename without extension — e.g. company_date_SALE-2026-0001 */
  fileStem: string;
};

const PRINT_PAGE_STYLE_ID = "me-print-page-size";

function paperSizeCss(paper: string): string {
  switch (paper) {
    case "A5":
      return "A5 portrait";
    case "80mm":
      return "80mm auto";
    default:
      return "A4 portrait";
  }
}

/**
 * DFP-002: drive paper size via the unnamed `@page` rule only.
 * Injecting/updating a single style tag avoids CSS named-page transitions that
 * Chromium turns into a blank first sheet.
 */
function syncPrintPaper(container: HTMLElement): void {
  const docEl = container.querySelector(".print-doc");
  const paper =
    (docEl instanceof HTMLElement && docEl.dataset.paper) || container.dataset.paper || "A4";
  container.dataset.paper = paper;
  document.documentElement.dataset.paper = paper;

  let styleEl = document.getElementById(PRINT_PAGE_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = PRINT_PAGE_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: ${paperSizeCss(paper)}; margin: 0; }`;
}

function clearPrintPaper(): void {
  document.documentElement.removeAttribute("data-paper");
  document.getElementById(PRINT_PAGE_STYLE_ID)?.remove();
}

function cleanup() {
  if (activeRoot) {
    try {
      activeRoot.unmount();
    } catch {
      /* already unmounted */
    }
    activeRoot = null;
  }
  if (activeContainer) {
    activeContainer.remove();
    activeContainer = null;
  }
  activeFingerprint = null;
  clearPrintPaper();
}

function afterPrint() {
  if (previousDocumentTitle !== null) {
    document.title = previousDocumentTitle;
    previousDocumentTitle = null;
  }
  cleanup();
}

export function installPrintHandler() {
  if ((window as unknown as { __printHandlerInstalled?: boolean }).__printHandlerInstalled) return;
  (window as unknown as { __printHandlerInstalled?: boolean }).__printHandlerInstalled = true;
  window.addEventListener("afterprint", afterPrint);
}

/**
 * Inline every reachable stylesheet rule so headless Chrome `file://` PDF
 * export still has CSS (linked Vite/asset URLs often fail offline).
 * Issue 15: prefer Windows system Arabic fonts over Google Fonts (unavailable offline).
 */
function collectInlineCss(): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        chunks.push(rule.cssText);
      }
    } catch {
      /* cross-origin sheet — skip */
    }
  }
  return chunks.join("\n");
}

const ARCHIVE_ARABIC_FONT_CSS = `
  /* Issue 15 — headless PDF: system Arabic fonts (no Google Fonts dependency) */
  [data-print-root],
  [data-print-root] * {
    font-family: "Segoe UI", "Tahoma", "Arial Unicode MS", "Arial", sans-serif !important;
  }
  .pd-amount, .print-total-row .pd-amount, .print-company-contact-line {
    direction: ltr;
    unicode-bidi: plaintext;
  }
`;

/** Build a standalone HTML snapshot of the print root (RTL + inlined styles). */
function buildArchiveHtml(container: HTMLElement, title?: string): string {
  const inline = collectInlineCss();
  const safeTitle = (title || "archive").replace(/[<>&"]/g, "");
  const paper =
    container.dataset.paper ||
    (container.querySelector(".print-doc") as HTMLElement | null)?.dataset.paper ||
    "A4";
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-paper="${paper}">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
${inline}
</style>
<style>
  /* Unnamed @page only (DFP-002) — size matches the printed paper setting. */
  @page { size: ${paperSizeCss(paper)}; margin: 0; }
  body { background: #fff; margin: 0; }
  [data-print-root] { display: block !important; position: static !important; left: auto !important; width: 100% !important; max-width: none !important; }
  ${ARCHIVE_ARABIC_FONT_CSS}
</style>
</head>
<body>
${container.outerHTML}
</body>
</html>`;
}

async function archiveIfDesktop(container: HTMLElement, meta?: PrintArchiveMeta): Promise<void> {
  if (!isTauri() || !meta) return;
  try {
    await ensureDocumentFolders();
    const html = buildArchiveHtml(container, meta.fileStem);
    const res = await archiveDocumentPdf(meta.docType, meta.fileStem, html);
    if (res?.path) {
      console.info("[print-archive]", res.format, res.path);
    }
  } catch (e) {
    console.warn("[print-archive] failed:", e);
  }
}

/** Render `node` into the print portal and open the OS print dialog.
 *  `fingerprint` (optional) identifies the data/filters the snapshot was
 *  rendered from — see printDataChanged().
 *  `archive` (optional, Tauri only) drops a PDF into the Desktop archive. */
export function printDocument(
  node: ReactNode,
  fingerprint?: string,
  archive?: PrintArchiveMeta,
): void {
  cleanup();
  installPrintHandler();
  activeFingerprint = fingerprint ?? null;

  const container = document.createElement("div");
  container.setAttribute("data-print-root", "true");
  document.body.appendChild(container);

  activeContainer = container;
  const root = createRoot(container);
  activeRoot = root;

  // Wait for inventory colours/fabrics/rolls before painting the print DOM —
  // otherwise every colour cell resolves to "—" (looks like one wrong colour).
  void (async () => {
    try {
      await refreshInventory();
      flushSync(() => {
        root.render(createElement(QueryClientProvider, { client: getQueryClient() }, node));
      });
    } catch (e) {
      cleanup();
      console.error("[print] failed to render document:", e);
      setTimeout(() => {
        window.alert("تعذّر عرض مستند الطباعة. راجع سجل الأخطاء.");
      }, 0);
      return;
    }

    window.setTimeout(() => {
      // Paper must be stamped before archive HTML snapshot AND before print().
      syncPrintPaper(container);
      void archiveIfDesktop(container, archive).finally(() => {
        // Strip any leftover inline geometry so print.css owns width 100%.
        // A fixed mm width here used to make Chrome shrink-to-fit and leave
        // a huge empty band beside the invoice.
        // Keep data-paper — required for named @page alignment (DFP-002).
        container.style.cssText = "";
        syncPrintPaper(container);
        if (previousDocumentTitle === null) {
          previousDocumentTitle = document.title;
        }
        document.title = "\u00a0";
        window.print();
      });
    }, 200);
  })();
}

/** Issue 12: print (optional) and always archive on desktop when meta is set. */
export function printOrArchive(
  node: ReactNode,
  archive: PrintArchiveMeta,
  thenPrint: boolean,
): void {
  if (thenPrint) {
    printDocument(node, undefined, archive);
  } else {
    archiveDocument(node, archive);
  }
}

/**
 * Issue 12: archive without opening the print dialog (used on save).
 * Renders `node` off-screen, writes PDF/HTML to Desktop folders, then cleans up.
 */
export function archiveDocument(node: ReactNode, archive: PrintArchiveMeta): void {
  if (!isTauri()) return;

  const container = document.createElement("div");
  container.setAttribute("data-print-root", "true");
  container.style.cssText = "position:fixed;left:-100vw;top:0;width:100%;";
  document.body.appendChild(container);
  const root = createRoot(container);

  window.setTimeout(() => {
    void (async () => {
      try {
        await refreshInventory();
        flushSync(() => {
          root.render(createElement(QueryClientProvider, { client: getQueryClient() }, node));
        });
        syncPrintPaper(container);
      } catch (e) {
        console.warn("[print-archive] render failed:", e);
        try {
          root.unmount();
        } catch {
          /* ignore */
        }
        container.remove();
        clearPrintPaper();
        return;
      }
      void archiveIfDesktop(container, archive).finally(() => {
        try {
          root.unmount();
        } catch {
          /* ignore */
        }
        container.remove();
        clearPrintPaper();
      });
    })();
  }, 200);
}

/**
 * #8: call whenever the underlying data/filters change while a print snapshot
 * may still be open. If nothing is open → no-op. If the fingerprint matches
 * the one the snapshot was rendered from → no-op. Otherwise the stale print
 * document is closed immediately with a clear message, so the printed copy
 * can never silently contradict the filtered screen data.
 */
export function printDataChanged(fingerprint: string): void {
  if (!activeRoot) return;
  if (activeFingerprint !== null && fingerprint === activeFingerprint) return;
  cleanup();
  toast.info(
    "تغيّرت فلاتر/بيانات الطباعة وأُغلقت نافذة الطباعة — أعد فتح «طباعة / PDF» لعرض النسخة المحدثة.",
  );
}
