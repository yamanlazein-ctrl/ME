/**
 * Pure page-size and font CSS for printed and archived documents. Dependency-free on purpose: the
 * Phase 3 archive builders import it without loading the print portal (React DOM, query client,
 * stores).
 *
 * Its home is `@erp/shared` because BOTH engines need it: the frontend's print portal (which
 * re-exports it from `src/components/print/archivePageCss.ts`) and the backend, which builds the
 * archived documents. One copy of each rule, so a printed page and an archived PDF cannot drift.
 */

/** `@page size` for a paper setting. A4/A5 take the orientation; an 80mm receipt roll has none. */
export function paperSizeCss(paper: string, orientation = "portrait"): string {
  const side = orientation === "landscape" ? "landscape" : "portrait";
  switch (paper) {
    case "A5":
      return `A5 ${side}`;
    case "80mm":
      return "80mm auto"; // a receipt roll has no orientation
    default:
      return `A4 ${side}`;
  }
}

/**
 * The unnamed `@page` rule for a print job. Margin is 0 and every page-margin box is empty, so the
 * browser/WebView cannot print its URL, date/time or page number on the sheet (Issue 2).
 */
export function pageRuleCss(paper: string, orientation = "portrait"): string {
  const empty = [
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ]
    .map((box) => `@${box} { content: none; }`)
    .join(" ");
  return `@page { size: ${paperSizeCss(paper, orientation)}; margin: 0; ${empty} }`;
}

/**
 * Arabic font rules for headless archive PDFs (system fonts, no network). Shared with the existing
 * archive HTML so every archived document uses the same rules.
 */
export const ARCHIVE_ARABIC_FONT_CSS = `
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
