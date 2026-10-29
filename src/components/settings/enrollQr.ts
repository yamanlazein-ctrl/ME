/**
 * The text encoded in the device-enrollment QR (desktop shows it, the phone scans it):
 * `motard-enroll://v1?u=<hub url>&c=<enrollment code>`. Carries only what the phone would
 * otherwise type by hand — the hub URL and the short-lived, limited-use enrollment code.
 */
const SCHEME = "motard-enroll://v1";

export function buildEnrollPayload(hubUrl: string, code: string): string {
  const q = new URLSearchParams({ u: hubUrl.trim().replace(/\/+$/, ""), c: code.trim() });
  return `${SCHEME}?${q.toString()}`;
}

/** Inverse of `buildEnrollPayload`; null for anything that is not a Motard enrollment QR. */
export function parseEnrollPayload(text: string): { hubUrl: string; code: string } | null {
  if (!text.startsWith(`${SCHEME}?`)) return null;
  const q = new URLSearchParams(text.slice(SCHEME.length + 1));
  const hubUrl = q.get("u");
  const code = q.get("c");
  return hubUrl && code && /^https?:\/\//i.test(hubUrl) ? { hubUrl, code } : null;
}
