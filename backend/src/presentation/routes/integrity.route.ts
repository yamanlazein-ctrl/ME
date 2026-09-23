import { Router, type Request, type Response } from "express";
import {
  acceptBaseline,
  collectCounts,
  getSafeModeStatus,
  readManifest,
  writeManifestAtomic,
} from "../../infrastructure/integrity/dataIntegrityManifest.js";
import type { TenantContext } from "../../domain/types/index.js";

export function createIntegrityRouter(auth: (req: Request, res: Response, next: () => void) => void): Router {
  const router = Router();

  router.get("/integrity/status", auth, async (_req: Request, res: Response) => {
    const status = getSafeModeStatus();
    const manifest = await readManifest();
    res.json({
      ...status,
      lastSuccessfulBackupAt: manifest?.lastSuccessfulBackupAt ?? null,
      lastVerifiedAt: manifest?.lastVerifiedAt ?? null,
      lastKnownCounts: manifest?.lastKnownCounts ?? null,
      tenantId: manifest?.tenantId ?? null,
    });
  });

  router.post("/integrity/accept-baseline", auth, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (ctx?.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    const manifest = await readManifest();
    if (!manifest) {
      res.status(409).json({ code: "MANIFEST_REQUIRED", message: "لا توجد بصمة سابقة لقبولها" });
      return;
    }
    const { pool } = await import("../../infrastructure/orm/drizzle.js");
    const { counts, databaseSizeBytes } = await collectCounts(pool, ctx.tenantId);
    acceptBaseline();
    await writeManifestAtomic({
      ...manifest,
      tenantId: ctx.tenantId,
      lastKnownCounts: counts,
      lastKnownDatabaseSizeBytes: databaseSizeBytes,
      lastBootDecision: "BASELINE_ACCEPTED",
      lastVerifiedAt: new Date().toISOString(),
      resetAuthorized: false,
      restoreInProgress: null,
    });
    res.json({ ok: true, counts });
  });

  router.post("/integrity/authorize-reset", auth, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (ctx?.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    const manifest = await readManifest();
    if (manifest) {
      await writeManifestAtomic({ ...manifest, resetAuthorized: true });
    } else {
      // Write a minimal authorize flag so Rust factory-reset path can proceed.
      await writeManifestAtomic({
        version: 1,
        installationId: "",
        tenantId: ctx.tenantId,
        schemaJournalIdx: 0,
        lastKnownCounts: {
          tenants: 0,
          users: 0,
          parties: 0,
          invoices: 0,
          invoiceLines: 0,
          rolls: 0,
          ledgerEntries: 0,
          vouchers: 0,
          returns: 0,
          syncOutboxPending: 0,
        },
        lastKnownDatabaseSizeBytes: 0,
        lastVerifiedAt: new Date().toISOString(),
        lastSuccessfulBackupAt: null,
        lastBootDecision: "RESET_AUTHORIZED",
        resetAuthorized: true,
        restoreInProgress: null,
      });
    }
    res.json({ ok: true, resetAuthorized: true });
  });

  return router;
}
