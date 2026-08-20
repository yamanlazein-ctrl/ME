import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getIdempotencyKey, readCached, writeCached, tryClaim } from "./idempotency.middleware.js";
import { NotFoundError } from "../../../domain/errors/index.js";

/**
 * Wrap a POST handler so that requests with an `Idempotency-Key` header are
 * cached. Replays within the TTL return the cached response without running
 * the handler again.
 *
 * Tenant scoping: the key is scoped to the tenant from `req.tenantContext` so
 * cross-tenant collisions are impossible.
 *
 * I3 fix: the key is claimed ATOMICALLY (tryClaim, SET NX) before the handler
 * runs, so two concurrent in-flight requests with the same key do not both
 * execute — the loser gets a 409 duplicate-in-flight response.
 */
export function idempotency(...methods: string[]): RequestHandler {
  const allowed = new Set(methods.map((m) => m.toUpperCase()));
  return async (req: Request, res: Response, next: NextFunction) => {
    // Fix C-6 (forensic audit 2026-08-15): track whether the client actually
    // asked for idempotency protection (sent a valid key), captured outside
    // the try block so the catch below can tell "nothing to protect" apart
    // from "protection was requested and the storage layer just broke".
    let requestedProtection = false;
    try {
      if (!allowed.has(req.method.toUpperCase())) {
        return next();
      }
      const key = getIdempotencyKey(req);
      if (!key) {
        return next(); // no key, no idempotency — treat as fresh request
      }
      requestedProtection = true;
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        // No tenant context — skip idempotency (middleware order issue)
        return next();
      }
      const cached = await readCached(tenantId, req.method, req.path, key);
      if (cached && cached.status > 0) {
        res
          .status(cached.status)
          .setHeader("Content-Type", cached.contentType)
          .setHeader("Idempotency-Replay", "true")
          .send(cached.body);
        return;
      }
      // Atomically claim the key before running the handler (I3 fix). If another
      // concurrent request already claimed it, refuse as a duplicate in-flight.
      const claimed = await tryClaim(tenantId, req.method, req.path, key);
      if (!claimed) {
        res.status(409).json({
          code: "DUPLICATE_IN_FLIGHT",
          message: "طلب مكرر قيد المعالجة",
          statusCode: 409,
        });
        return;
      }
      // Patch res.json to capture the response body and persist it.
      const originalJson = res.json.bind(res);
      let capturedBody: string | null = null;
      let capturedStatus = res.statusCode;
      let capturedContentType = "application/json; charset=utf-8";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).json = (body: unknown) => {
        try {
          capturedBody = JSON.stringify(body);
          capturedContentType = "application/json; charset=utf-8";
        } catch {
          capturedBody = null;
        }
        return originalJson(body);
      };
      res.on("finish", () => {
        capturedStatus = res.statusCode;
        if (capturedBody !== null && res.statusCode < 500) {
          // Only cache 2xx/3xx/4xx — never cache 5xx (so retries can succeed)
          void writeCached(
            tenantId,
            req.method,
            req.path,
            key,
            capturedStatus,
            capturedBody,
            capturedContentType,
          ).catch(() => {
            // best-effort cache write
          });
        }
      });
      next();
    } catch (e) {
      // Fix C-6: this used to unconditionally call next() on ANY error —
      // "if idempotency storage is broken, still serve the request" — which
      // is the third fail-open layer (on top of the in-memory Map fallback
      // fixed in idempotency.middleware.ts): even a total storage outage
      // (Redis down AND Postgres unreachable) let every write through
      // completely unprotected, silently.
      //
      // A request that never asked for idempotency (no key sent) has
      // nothing to protect and must proceed normally — failing closed here
      // would break every plain POST whenever storage hiccups, for zero
      // benefit. But a request that DID send an Idempotency-Key is
      // explicitly asking "do not double-apply this financial write if I
      // retry" — silently downgrading that promise to "best effort, no
      // guarantee" without telling the caller defeats the entire point of
      // sending the header. Fail closed for that case: reject with 503 so
      // the client's own retry logic (which is presumably why it sent an
      // idempotency key in the first place) waits and retries, rather than
      // racing an unprotected duplicate write.
      if (requestedProtection) {
        res.status(503).json({
          code: "IDEMPOTENCY_STORAGE_UNAVAILABLE",
          message: "تعذّر ضمان عدم تكرار الطلب حالياً — يرجى إعادة المحاولة",
          statusCode: 503,
        });
        return;
      }
      next();
    }
  };
}

// Maintain a reference so the symbol is not tree-shaken
export const _notFoundMarker = new NotFoundError("idempotency");
