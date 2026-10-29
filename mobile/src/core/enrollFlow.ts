// The enrol screen's logic apart from the UI: parse the QR payload, classify failures, run enrol + resumable first download.
import { EnrollmentRefusedError } from "./enrollment";
import { InsufficientStorageError } from "./firstDownload";

export type EnrollError =
  "invalidUrl" | "invalidCode" | "network" | "lowStorage" | "stuck" | "other";

export const ENROLL_ERROR_TEXT: Record<EnrollError, string> = {
  invalidUrl:
    "عنوان المركز غير صالح. اكتبه كما يظهر في برنامج الحاسوب، مثل https://example.onrender.com",
  invalidCode: "رمز التسجيل غير صالح",
  network: "تعذّر الوصول إلى المركز. تحقق من العنوان ومن اتصال الإنترنت",
  lowStorage: "المساحة المتاحة على الهاتف لا تكفي للتحميل الأول",
  stuck:
    "تعذّر تطبيق بعض العمليات القادمة من المركز. اضغط «إعادة المحاولة»، وإن تكرر ذلك فأبلغ الدعم",
  other: "تعذّر إكمال التسجيل",
};

/**
 * BC-4: the QR holds `{ "hub": "<url>", "code": "<enrolment code>" }`. Two simpler spellings are accepted too:
 * `motard://enroll?hub=<url>&code=<code>` and `<url>|<code>`.
 */
export function parseEnrollQr(text: string): { hub: string; code: string } | null {
  const raw = text.trim();
  try {
    const v = JSON.parse(raw) as { hub?: unknown; code?: unknown };
    if (typeof v.hub === "string" && typeof v.code === "string" && v.hub && v.code) {
      return { hub: v.hub.trim(), code: v.code.trim() };
    }
  } catch {
    // not JSON
  }
  const link = /^motard:\/\/enroll\?(.*)$/i.exec(raw);
  if (link) {
    const q = new URLSearchParams(link[1]);
    const hub = q.get("hub")?.trim();
    const code = q.get("code")?.trim();
    if (hub && code) return { hub, code };
  }
  const bar = raw.indexOf("|");
  if (bar > 0 && /^https?:\/\//i.test(raw)) {
    const hub = raw.slice(0, bar).trim();
    const code = raw.slice(bar + 1).trim();
    if (hub && code) return { hub, code };
  }
  return null;
}

export function classifyEnrollError(error: unknown): EnrollError {
  if (error instanceof InsufficientStorageError) return "lowStorage";
  if (error instanceof EnrollmentRefusedError) {
    if (error.stage === "url") return "invalidUrl";
    return error.stage === "reach" ? "network" : "invalidCode";
  }
  if (error instanceof TypeError) return "network"; // fetch failure
  return "other";
}

/**
 * The hub's own reason when it refused the code (expired, used up, device limit, no licence…): those texts are written
 * for the user on the hub, so they are shown as they are instead of one generic line. Null for anything else.
 */
export function hubRefusalText(error: unknown): string | null {
  if (
    error instanceof EnrollmentRefusedError &&
    (error.stage === "login" || error.stage === "role")
  ) {
    return error.message.trim() || null;
  }
  return null;
}

/**
 * The hub address as typed or scanned, made usable: spaces and trailing slashes removed, https:// added when no scheme
 * was typed. Null when it still is not an http(s) address.
 */
export function normalizeHubUrl(raw: string): string | null {
  let t = raw.trim().replace(/\s+/g, "").replace(/\/+$/, "");
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (
      !u.hostname.includes(".") &&
      u.hostname !== "localhost" &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
    ) {
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

/**
 * A free cloud server (Render) sleeps and needs up to a minute to wake: the shared pairing code gives the hub 6 s. Wait
 * for /api/health/live first, polling until `budgetMs`, so the first try does not fail as "unreachable". True = awake.
 */
export async function wakeHub(
  url: string,
  deps: { fetch: typeof fetch; now(): number; sleep(ms: number): Promise<void> },
  budgetMs = 75_000,
): Promise<boolean> {
  const deadline = deps.now() + budgetMs;
  while (deps.now() < deadline) {
    try {
      const res = await deps.fetch(`${url}/api/health/live`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return true;
    } catch {
      // asleep or offline: try again until the budget is spent
    }
    await deps.sleep(3_000);
  }
  return false;
}
