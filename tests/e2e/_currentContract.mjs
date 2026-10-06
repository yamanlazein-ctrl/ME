/**
 * Request adapter for the legacy API e2e scripts (written 2026-09-18), bringing
 * their calls up to the API contract that landed afterwards — without touching
 * any assertion:
 *   - REPAIR-008: financial mutations require an `Idempotency-Key` (else 428).
 *   - bf340593:  every non-USD document carries `exchangeRate` (units per 1 USD).
 *   - optimistic concurrency: `/:id/cancel` requires `expectedVersion`.
 */
import { randomUUID } from "node:crypto";

export const E2E_SYP_RATE = 15000;

/**
 * @param {string} url absolute request URL
 * @param {string} method HTTP method
 * @param {unknown} body parsed JSON body (or undefined)
 * @param {(url: string) => Promise<any>} getJson fetches a resource with the same auth
 * @returns {Promise<{ body: unknown, headers: Record<string, string> }>}
 */
export async function adaptRequest(url, method, body, getJson) {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET") return { body, headers: {} };
  const headers = { "Idempotency-Key": randomUUID() };
  let b = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : body;
  if (b && typeof b === "object" && typeof b.currency === "string" && b.currency !== "USD" && b.exchangeRate == null) {
    b.exchangeRate = E2E_SYP_RATE;
  }
  const cancel = /^(.*\/[a-z-]+\/[0-9a-f-]{36})\/cancel$/i.exec(url.split("?")[0]);
  if (cancel && (b == null || typeof b === "object") && (b?.expectedVersion == null)) {
    const cur = await getJson(cancel[1]).catch(() => null);
    const version = (cur?.data ?? cur)?.version;
    if (typeof version === "number") b = { ...(b ?? {}), expectedVersion: version };
  }
  return { body: b, headers };
}
