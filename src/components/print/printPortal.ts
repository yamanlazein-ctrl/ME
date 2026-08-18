import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getQueryClient } from "@/infrastructure/queryClient";

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
 */

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

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
}

function afterPrint() {
  cleanup();
}

export function installPrintHandler() {
  if ((window as unknown as { __printHandlerInstalled?: boolean }).__printHandlerInstalled) return;
  (window as unknown as { __printHandlerInstalled?: boolean }).__printHandlerInstalled = true;
  window.addEventListener("afterprint", afterPrint);
}

/** Render `node` into the print portal and open the OS print dialog. */
export function printDocument(node: ReactNode): void {
  cleanup();
  installPrintHandler();

  const container = document.createElement("div");
  container.setAttribute("data-print-root", "true");
  document.body.appendChild(container);

  activeContainer = container;
  const root = createRoot(container);
  activeRoot = root;

  // Synchronously commit the document to the DOM so window.print() never
  // captures an empty page. This is the fix for "blank white page on print".
  // The document templates use React Query hooks (e.g. useVouchersList), so
  // we render inside a QueryClientProvider sharing the app's client — the
  // detached root would otherwise throw "No QueryClient set" and print blank.
  //
  // If the template throws during render, we must not leave a blank
  // [data-print-root] container behind — clean it up and surface the error
  // so the user is not left staring at a white page.
  try {
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

  // Give the browser a tick to lay out / load images, then open the dialog.
  window.setTimeout(() => {
    window.print();
  }, 200);
}
