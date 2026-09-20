// Inline SSR helpers to avoid Vite module-runner deadlocks while optimizeDeps
// is still bundling sibling files (fetchModule timeouts on error-*.ts).

import { memoizeUntilRejected } from "./lib/memoizeUntilRejected.js";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

// F03 (Phase 1 audit): see memoizeUntilRejected.ts — a transient import
// failure (the known Vite module-runner race noted above) must not poison
// every request until the process restarts. A rejection here now clears
// the cache so the next request gets a fresh import attempt.
const getServerEntry = memoizeUntilRejected<ServerEntry>(() =>
  import("@tanstack/react-start/server-entry").then((m) => (m.default ?? m) as ServerEntry),
);

function renderErrorPage(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>خطأ في التشغيل</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{font-family:Tahoma,Segoe UI,sans-serif;margin:0;background:#0f1115;color:#f3f4f6;
       display:flex;min-height:100vh;align-items:center;justify-content:center}
  .box{max-width:28rem;padding:1.5rem;border:1px solid #333;border-radius:12px;background:#171a21}
  h1{font-size:1.15rem;margin:0 0 .5rem}
  p{margin:0;color:#9ca3af;font-size:.9rem;line-height:1.5}
</style>
</head>
<body>
  <div class="box">
    <h1>تعذّر عرض الصفحة</h1>
    <p>حدث خطأ أثناء تحميل واجهة التطوير. حدّث الصفحة بعد بضع ثوانٍ.</p>
  </div>
</body>
</html>`;
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
