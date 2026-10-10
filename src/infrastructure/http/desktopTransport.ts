/**
 * Phase 1 — the desktop API transport.
 *
 * What changed
 * ------------
 * Before, the desktop window was a web page loaded from
 * `http://127.0.0.1:<port>/`, and every API call was an ordinary `fetch` to a
 * local web server. That made the whole application depend on a TCP port: when
 * the bundled server died, WebView2 put its own "can't reach this page" screen
 * in front of the user — a page that names an internet problem the machine does
 * not have and offers nothing to click.
 *
 * Now the SPA is embedded in the binary and served over Tauri's own asset
 * protocol, so it has no HTTP origin at all. `/api/*` leaves the page through
 * the Tauri IPC bridge instead: React → `invoke("api")` → Rust → a Windows
 * named pipe → the same Express app. No port, no localhost, no CORS, and no
 * navigation that can fail.
 *
 * Why patch `fetch` rather than change every call site
 * ----------------------------------------------------
 * The app makes its API calls through `fetch` in a few dozen places. One
 * installed wrapper covers all of them, including anything added later, and it
 * is the SAME seam the migration plan promised. The web build is untouched:
 * without Tauri the original `fetch` is used unchanged, so the hosted product
 * keeps talking to its real API over HTTP.
 */

import { apiRequest, isTauri } from "@/infrastructure/tauri-bridge";

// The bridge speaks JSON to the Express app, so a successful response has to
// carry that content type for the app's existing parsing to work unchanged.
const BRIDGE_CONTENT_TYPE = "application/json";

const INSTALLED = "__motardDesktopTransport";

type PatchedWindow = Window & {
  [INSTALLED]?: boolean;
  __motardApiUnavailable?: boolean;
};

/**
 * True when this document is served by the Tauri asset protocol. Exported as a
 * named check because several callers need to branch on the runtime, and a
 * call site reading `isTauri()` inline would not say "is this the DESKTOP build".
 */
export function isDesktopRuntime(): boolean {
  return isTauri();
}

function toBridgeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  // Only a string body can cross the bridge intact: `PipeRequest.body` is a `String`, so binary or a
  // `File`/`Blob`/`FormData` would be corrupted or silently lost.
  //
  // Silently sending `null` instead was the bug behind "restore always fails with ملف غير صالح": a
  // backup upload posted `body: file`, the body vanished, the server saw zero bytes and reported a
  // damaged archive for a file that was perfectly valid. A dropped body is a TRANSPORT failure, so it
  // is now a typed, actionable error the caller can render — never a silent empty request. Binary
  // payloads must go through the shell (see `pickBackupFile` / `saveBackupFile`), which is the same
  // arrangement the outbound backup already uses.
  const raw = init?.body;
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    const kind = raw instanceof Blob ? "file/blob" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(
      `لا يمكن إرسال بيانات ثنائية (${kind}) عبر قناة سطح المكتب — استخدم حوار اختيار الملف في البرنامج.`,
    );
  }
  const body = typeof raw === "string" ? raw : null;
  const headers: Record<string, string> = {};
  const source = init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined);
  if (source) {
    new Headers(source).forEach((value, key) => {
      headers[key] = value;
    });
  }
  return { method: (method || "GET").toUpperCase(), path: url, body, headers };
}

/**
 * Install the bridge. Idempotent, and a no-op outside the desktop shell.
 *
 * Must run before the first API call. `src/router.tsx` calls it at module
 * scope, which is before any route component renders and therefore before any
 * query fires.
 */
export function installDesktopTransport(): void {
  if (typeof window === "undefined" || !isTauri()) return;
  const w = window as PatchedWindow;
  if (w[INSTALLED]) return;
  w[INSTALLED] = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only same-document API traffic moves to the bridge. Everything else —
    // assets, blobs, the IPC channel — keeps using the browser's own fetch.
    if (!url.startsWith("/api") && !url.startsWith("./api")) return original(input, init);

    const res = await apiRequest(toBridgeRequest(input, init));
    if (res.error) {
      // A dead sidecar is a TYPED error the app's existing error handling
      // already renders as a normal state. It is deliberately not a synthetic
      // "network error page" and never a thrown-away rejection: the operator
      // sees whatever the app shows for a failed request, and the supervisor
      // owns recovery.
      w.__motardApiUnavailable = true;
      throw new Error(
        `الخادم المحلي غير متاح (${res.error}) — يمكن إعادة المحاولة.`,
        { cause: res.error },
      );
    }
    w.__motardApiUnavailable = false;
    // Headers are forwarded, not just the body: the app's session layer reads
    // `Set-Cookie` and its license layer reads `X-License-Grace`, and both
    // arrive as plain headers over the pipe.
    const outHeaders = new Headers();
    for (const [name, value] of res.headers ?? []) outHeaders.append(name, value);
    if (!outHeaders.has("content-type")) outHeaders.set("content-type", BRIDGE_CONTENT_TYPE);
    // A 204/205/304 response is a "null body status" per the Fetch standard:
    // constructing a Response for one with a NON-null body throws
    // `TypeError: Response constructor: Invalid response status code 204`
    // (verified on Chromium/WebView2 and undici; Bun is the only lenient one).
    // That throw used to escape the patched fetch, get wrapped as a NETWORK
    // error, and be retried — so a DELETE that had ALREADY committed was sent a
    // second time with the same OCC token and the replay tripped the version
    // check. The operator then saw "تم تعديل بيانات العميل من جلسة أخرى" for a
    // delete that had actually succeeded. Every mutating endpoint that answers
    // 204 (party/supplier/fabric/color/roll delete, cashbox, logout) was
    // affected. The pipe always hands back a `String`, so the empty 204 body
    // must be normalised to `null` here, at the only place that knows the
    // status.
    const nullBodyStatus = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBodyStatus ? null : res.body, {
      status: res.status,
      headers: outHeaders,
    });
  };
}

/** True when the last API call failed because the local server was gone. */
export function isApiUnavailable(): boolean {
  return typeof window !== "undefined" && Boolean((window as PatchedWindow).__motardApiUnavailable);
}
