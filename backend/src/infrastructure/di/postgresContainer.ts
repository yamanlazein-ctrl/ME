/**
 * PostgreSQL wiring of the DI container (cloud, and DB_ENGINE=postgres). Moved verbatim from
 * container.ts (specs/001-desktop-sqlite-engine T053+) so a SQLite process never evaluates it:
 * container.ts loads this module only when DB_ENGINE=postgres.
 */
import type { Container } from "./container.js";
import { db } from "../orm/drizzle.js";
import { ambientDb } from "../orm/ambient-tx.js";
import { redis, DbTokenDenylist, RedisTokenDenylist, CompositeTokenDenylist } from "../auth/TokenDenylist.js";
import type { TokenDenylist } from "../auth/TokenDenylist.js";
import { JwtSigner } from "../auth/JwtSigner.js";
import { Argon2PasswordHasher } from "../auth/PasswordHasher.js";
import { config } from "../config/env.js";
import { PostgresPartyRepository } from "../repositories/PostgresPartyRepository.js";
import type { IUserRepository } from "../../application/ports/IUserRepository.js";
import { PostgresUserRepository } from "../repositories/PostgresUserRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import { PostgresFabricRepository } from "../repositories/PostgresFabricRepository.js";
import type { IFabricRepository } from "../../application/ports/IFabricRepository.js";
import { PostgresColorRepository } from "../repositories/PostgresColorRepository.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import { PostgresRollRepository } from "../repositories/PostgresRollRepository.js";
import type { IRollRepository } from "../../application/ports/IRollRepository.js";
import { PostgresStockMovementRepository } from "../repositories/PostgresStockMovementRepository.js";
import type { IStockMovementRepository } from "../../application/ports/IStockMovementRepository.js";
import { PostgresOrderRepository } from "../repositories/PostgresOrderRepository.js";
import type { IOrderRepository } from "../../application/ports/IOrderRepository.js";
import { PostgresInvoiceRepository } from "../repositories/PostgresInvoiceRepository.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import { PostgresAuditRepository } from "../repositories/PostgresAuditRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import { PostgresVoucherRepository } from "../repositories/PostgresVoucherRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import { PostgresLedgerRepository } from "../repositories/PostgresLedgerRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import { PostgresStatementRepository } from "../repositories/PostgresStatementRepository.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import { PostgresReturnRepository } from "../repositories/PostgresReturnRepository.js";
import type { IReturnRepository } from "../../application/ports/IReturnRepository.js";
import { PostgresCashboxRepository } from "../repositories/PostgresCashboxRepository.js";
import type { ICashboxRepository } from "../../application/ports/ICashboxRepository.js";
import { PostgresExpenseRepository } from "../repositories/PostgresExpenseRepository.js";
import type { IExpenseRepository } from "../../application/ports/IExpenseRepository.js";
import { PostgresPrintJobRepository } from "../repositories/PostgresPrintJobRepository.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import { PostgresSearchRepository } from "../repositories/PostgresSearchRepository.js";
import type { ISearchRepository } from "../../application/ports/ISearchRepository.js";
import { PostgresReportsRepository } from "../repositories/PostgresReportsRepository.js";
import type { IReportsRepository } from "../../application/ports/IReportsRepository.js";
import { PostgresHealthRepository } from "../repositories/PostgresHealthRepository.js";
import type { IHealthRepository } from "../../application/ports/IHealthRepository.js";
import { PostgresNotificationRepository } from "../repositories/PostgresNotificationRepository.js";
import type { INotificationRepository } from "../../application/ports/INotificationRepository.js";
import { PostgresSettingsRepository } from "../repositories/PostgresSettingsRepository.js";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import { PostgresDashboardRepository } from "../repositories/PostgresDashboardRepository.js";
import type { IDashboardRepository } from "../../application/ports/IDashboardRepository.js";
import { PostgresProfitRepository } from "../repositories/PostgresProfitRepository.js";
import type { IProfitRepository } from "../../application/ports/IProfitRepository.js";
import { PostgresAuthRepository } from "../repositories/PostgresAuthRepository.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
import { PostgresCompanyRepository } from "../repositories/PostgresCompanyRepository.js";
import type { ICompanyRepository } from "../../application/ports/ICompanyRepository.js";
import { PostgresInvitationRepository } from "../repositories/PostgresInvitationRepository.js";
import { PostgresDocumentTrackRepository } from "../repositories/PostgresDocumentTrackRepository.js";
import type { IInvitationRepository } from "../../application/ports/IInvitationRepository.js";
import { PostgresLicenseRepository } from "../repositories/PostgresLicenseRepository.js";
import type { ILicenseRepository } from "../../application/ports/ILicenseRepository.js";
import { PostgresTenantRepository } from "../repositories/PostgresTenantRepository.js";
import type { ITenantRepository } from "../../application/ports/ITenantRepository.js";
import { PostgresInstallationStateRepository } from "../repositories/PostgresInstallationStateRepository.js";
import type { IInstallationStateRepository } from "../../application/ports/IInstallationStateRepository.js";
import { PostgresSecretsRepository } from "../repositories/PostgresSecretsRepository.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import { PostgresSyncDeviceRepository } from "../repositories/PostgresSyncDeviceRepository.js";
import type { ISyncDeviceRepository } from "../../application/ports/ISyncDeviceRepository.js";
import { PostgresSyncOutboxRepository } from "../repositories/PostgresSyncOutboxRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import { PostgresSyncInboxRepository } from "../repositories/PostgresSyncInboxRepository.js";
import type { ISyncInboxRepository } from "../../application/ports/ISyncInboxRepository.js";
import { PostgresDocumentNumberBlockRepository } from "../repositories/PostgresDocumentNumberBlockRepository.js";
import type { IDocumentNumberBlockRepository } from "../../application/ports/IDocumentNumberBlockRepository.js";
import { PostgresSyncResourceClaimRepository } from "../repositories/PostgresSyncResourceClaimRepository.js";
import type { ISyncResourceClaimRepository } from "../../application/ports/ISyncResourceClaimRepository.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import { AesGcmSecretStore, decodeMasterKey } from "../secrets/AesGcmSecretStore.js";
import { NodeFingerprintProvider } from "../fingerprint/NodeFingerprintProvider.js";
import type { IMachineFingerprintProvider } from "../../application/ports/IMachineFingerprintProvider.js";
import { InstallationIdStorage } from "../installation/InstallationIdStorage.js";
import type { IInstallationIdStorage } from "../installation/InstallationIdStorage.js";
import { SelfHostedLicenseProvider } from "../license/SelfHostedLicenseProvider.js";
import type { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import { buildLicenseTokenSignerForInstall } from "./licenseTokenSignerForInstall.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";
import { logger } from "../config/logger.js";


export function buildContainer(): Container {
  const jwtSigner = new JwtSigner();
  const passwordHasher = new Argon2PasswordHasher();
  // Revocation is durable in PostgreSQL (always present — desktop ships its own
  // DB and has no Redis). Redis, when configured, is a fast path in front of it.
  const tokenDenylist = new CompositeTokenDenylist(
    new DbTokenDenylist(),
    redis ? new RedisTokenDenylist(redis) : null,
  );

  const authRepo = new PostgresAuthRepository(db);
  // F-07 (Transactional Outbox): these repositories receive an ambient-aware
  // proxy instead of the raw pool handle. When a route wraps its work in
  // `withTenantTx`, `this.db.transaction(...)` inside these repos becomes a
  // SAVEPOINT on the route's transaction, so the business write and the
  // `sync_outbox` insert share ONE commit/rollback boundary. Outside such a
  // route the proxy is a transparent pass-through to `db` (no behaviour change).
  //
  // Every repository whose write is enqueued as a sync unit in the SAME route
  // transaction must be proxied — otherwise its statements run on a DIFFERENT
  // pooled connection and commit independently of the outbox row, which is the
  // silent-fork defect F-07 exists to prevent (found live in the ledger,
  // cashbox, statement/settlement, settings and company routes).
  //
  // Deliberately NOT proxied: auditRepo and every other repository. Audit rows
  // are written fire-and-forget (they must never abort a business transaction),
  // and unrelated repos have no outbox coupling to make atomic.
  const dbx = ambientDb(db);
  const partyRepo = new PostgresPartyRepository(dbx);
  const fabricRepo = new PostgresFabricRepository(dbx);
  const colorRepo = new PostgresColorRepository(dbx);
  const rollRepo = new PostgresRollRepository(dbx);
  const stockMovementRepo = new PostgresStockMovementRepository(db);
  const orderRepo = new PostgresOrderRepository(dbx);
  const invoiceRepo = new PostgresInvoiceRepository(dbx);
  const auditRepo = new PostgresAuditRepository(db);
  const voucherRepo = new PostgresVoucherRepository(dbx);
  const ledgerRepo = new PostgresLedgerRepository(dbx);
  const statementRepo = new PostgresStatementRepository(dbx);
  const returnRepo = new PostgresReturnRepository(dbx);
  const cashboxRepo = new PostgresCashboxRepository(dbx);
  const expenseRepo = new PostgresExpenseRepository(dbx);
  const printJobRepo = new PostgresPrintJobRepository(dbx);
  const searchRepo = new PostgresSearchRepository(dbx);
  const reportsRepo = new PostgresReportsRepository(dbx);
  const healthRepo = new PostgresHealthRepository(dbx);
  const notificationRepo = new PostgresNotificationRepository(db);
  const settingsRepo = new PostgresSettingsRepository(dbx);
  const dashboardRepo = new PostgresDashboardRepository(db);
  const profitRepo = new PostgresProfitRepository(db);
  const documentTrackRepo = new PostgresDocumentTrackRepository(db);
  const userRepo = new PostgresUserRepository(db);

  // ── Phase 0 sub-batch extensions ──
  // The company profile is enqueued as a sync unit by PUT /api/company/profile.
  // It needs no proxy: PostgresCompanyRepository opens its own transaction via
  // `withTenantTx`, which joins the caller's ambient transaction as a savepoint
  // (see drizzle.ts). It must NOT be moved to the raw handle.
  const companyRepo = new PostgresCompanyRepository(db);
  const invitationRepo = new PostgresInvitationRepository(db);
  const licenseRepo = new PostgresLicenseRepository(db);
  const tenantRepo = new PostgresTenantRepository(db);
  const installationStateRepo = new PostgresInstallationStateRepository(db);
  const syncDeviceRepo = new PostgresSyncDeviceRepository(db);
  // Outbox inserts must land on the caller's transaction (F-07).
  const syncOutboxRepo = new PostgresSyncOutboxRepository(dbx);
  const syncInboxRepo = new PostgresSyncInboxRepository(db);
  const documentNumberBlockRepo = new PostgresDocumentNumberBlockRepository(db);
  const syncResourceClaimRepo = new PostgresSyncResourceClaimRepository(db);

  // Fail fast when the master key is missing/invalid (Task 1.1).
  const masterKey = decodeMasterKey(config.APP_MASTER_KEY);
  if (!masterKey) {
    logger.fatal(
      { hasMasterKey: !!config.APP_MASTER_KEY },
      "APP_MASTER_KEY is missing or not a valid 32-byte base64 value. Refusing to boot.",
    );
    throw new Error(
      "APP_MASTER_KEY must be set to a base64-encoded 32-byte value. Set the env var and restart.",
    );
  }
  const secretCipher: ISecretCipher = new AesGcmSecretStore(masterKey);
  const secretsRepo: ISecretsRepository = new PostgresSecretsRepository(secretCipher, db);

  const fingerprintProvider: IMachineFingerprintProvider = new NodeFingerprintProvider();
  const installationIdStorage: IInstallationIdStorage = new InstallationIdStorage();
  const licenseTokenSigner = buildLicenseTokenSignerForInstall();
  const licenseProvider: ILicenseProvider = new SelfHostedLicenseProvider(licenseTokenSigner, db);

  const built: Container = {
    db,
    jwtSigner,
    passwordHasher,
    tokenDenylist,
    authRepo,
    partyRepo,
    fabricRepo,
    colorRepo,
    rollRepo,
    stockMovementRepo,
    orderRepo,
    invoiceRepo,
    auditRepo,
    voucherRepo,
    ledgerRepo,
    statementRepo,
    returnRepo,
    cashboxRepo,
    expenseRepo,
    printJobRepo,
    searchRepo,
    reportsRepo,
    healthRepo,
    notificationRepo,
    settingsRepo,
    dashboardRepo,
    profitRepo,
    documentTrackRepo,
    userRepo,
    companyRepo,
    invitationRepo,
    licenseRepo,
    tenantRepo,
    installationStateRepo,
    secretCipher,
    secretsRepo,
    syncDeviceRepo,
    syncOutboxRepo,
    syncInboxRepo,
    documentNumberBlockRepo,
    syncResourceClaimRepo,
    fingerprintProvider,
    installationIdStorage,
    licenseTokenSigner,
    licenseProvider,
  };
  return built;
}

