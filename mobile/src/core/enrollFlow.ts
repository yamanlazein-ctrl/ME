// The enrol screen's logic apart from the UI: parse the QR payload, classify failures, run enrol + resumable first download.
import { EnrollmentRefusedError } from "./enrollment";
import { InsufficientStorageError } from "./firstDownload";

export type EnrollError = "invalidCode" | "network" | "lowStorage" | "other";

export const ENROLL_ERROR_TEXT: Record<EnrollError, string> = {
  invalidCode: "رمز التسجيل غير صالح",
  network: "سيتابع عند عودة الاتصال",
  lowStorage: "المساحة المتاحة على الهاتف لا تكفي للتحميل الأول",
  other: "تعذّر إكمال التسجيل",
};

/** BC-4: the QR holds `{ "hub": "<url>", "code": "<enrolment code>" }`. */
export function parseEnrollQr(text: string): { hub: string; code: string } | null {
  try {
    const v = JSON.parse(text) as { hub?: unknown; code?: unknown };
    if (typeof v.hub === "string" && typeof v.code === "string" && v.hub && v.code) {
      return { hub: v.hub, code: v.code };
    }
  } catch {
    // not JSON
  }
  return null;
}

export function classifyEnrollError(error: unknown): EnrollError {
  if (error instanceof InsufficientStorageError) return "lowStorage";
  if (error instanceof EnrollmentRefusedError) {
    return error.stage === "reach" || error.stage === "url" ? "network" : "invalidCode";
  }
  if (error instanceof TypeError) return "network"; // fetch failure
  return "other";
}
