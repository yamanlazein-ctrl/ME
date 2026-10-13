import { Router, type Request, type Response } from "express";
import {
  acceptBaseline,
  collectCounts,
  getSafeModeStatus,
  readManifest,
  writeManifestAtomic,
} from "../../infrastructure/integrity/dataIntegrityManifest.js";
import type { TenantContext } from "../../domain/types/index.js";
import { hasAdminPrivileges } from "../../infrastructure/http/middleware/rbac.middleware.js";
import { takeHubFingerprint } from "../../infrastructure/integrity/hubFingerprint.js";
import { cutoverPreflight } from "../../infrastructure/integrity/cutoverPreflight.js";

export function createIntegrityRouter(
  auth: (req: Request, res: Response, next: () => void) => void,
  deps?: Parameters<typeof cutoverPreflight>[0],
): Router {
  const router = Router();

  // MIG-04: data fingerprint of this company (compare old vs new server before switching DNS).
  router.get("/integrity/fingerprint", auth, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (!ctx || !hasAdminPrivileges(ctx.userRole)) {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    res.json(await takeHubFingerprint(ctx.tenantId));
  });

  // MIG-08: secrets / licence / CORS / device-credential readiness of THIS host.
  router.get("/integrity/cutover-preflight", auth, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (!ctx || !hasAdminPrivileges(ctx.userRole)) {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    if (!deps) {
      res.status(501).json({ code: "NOT_AVAILABLE", message: "غير متاح" });
      return;
    }
    res.json(await cutoverPreflight(deps, ctx.tenantId));
  });

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
    if (!ctx || !hasAdminPrivileges(ctx.userRole)) {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    const manifest = await readManifest();
    if (!manifest) {
      res.status(409).json({ code: "MANIFEST_REQUIRED", message: "لا توجد بصمة سابقة لقبولها" });
      return;
    }
    const sqlite = (await import("../../infrastructure/orm/engine.js")).getEngine() === "sqlite";
    const pool = sqlite
      ? (await import("../../infrastructure/orm/sqlite/queryable.js")).sqliteReaderQueryable()
      : (await import("../../infrastructure/orm/pgLazy.js")).pgPool();
    const { counts, databaseSizeBytes } = await collectCounts(
      await pool,
      ctx.tenantId,
      sqlite ? "sqlite" : "postgres",
    );
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
    if (!ctx || !hasAdminPrivileges(ctx.userRole)) {
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
