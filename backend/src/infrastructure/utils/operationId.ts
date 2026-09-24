import { createHash } from "node:crypto";

/**
 * Derive a stable per-document operation id from one request-level
 * Idempotency-Key. A request that writes several documents of the same kind
 * (e.g. multi-invoice settlement → N vouchers) must not stamp the same
 * client_operation_id on each of them (unique per tenant), but a retry of the
 * same request must still collide on the same derived ids.
 */
export function deriveOperationId(
  base: string | null | undefined,
  salt: string,
): string | null {
  if (!base) return null;
  const h = createHash("sha256").update(`${base}:${salt}`).digest("hex");
  // RFC-4122 layout (version 5-like, variant 10xx) so it validates as uuid.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
