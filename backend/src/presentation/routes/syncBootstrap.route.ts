/**
 * REPAIR-029 — hub snapshot / bootstrap / compaction (design stubs).
 * Compaction stays disabled until §19 Q22 (legal retention) has an owner.
 */
import type { Router, Request, Response, RequestHandler } from "express";

export function registerSyncBootstrapRoutes(
  router: Router,
  auth: RequestHandler,
): void {
  /** Returns 501 until hub snapshot pipeline is enabled post-Q22. */
  router.get("/sync/bootstrap", auth, (_req: Request, res: Response) => {
    res.status(501).json({
      code: "SYNC_BOOTSTRAP_NOT_ENABLED",
      message:
        "Hub bootstrap snapshot is designed but not enabled — see docs/decisions.md (REPAIR-029). Q22 retention owner required before compaction.",
      design: {
        sinceSeq: "query param",
        response: "{ snapshot, cursor, watermark }",
        compaction: "disabled until Q22",
      },
    });
  });

  router.get("/sync/snapshot-watermark", auth, (_req: Request, res: Response) => {
    res.status(501).json({
      code: "SYNC_WATERMARK_NOT_ENABLED",
      message: "Snapshot watermark not published yet (REPAIR-029).",
    });
  });
}
