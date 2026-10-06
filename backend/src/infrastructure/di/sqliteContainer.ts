/**
 * SQLite wiring of the DI container (desktop, DB_ENGINE=sqlite — specs/001-desktop-sqlite-engine S4).
 *
 * Mirrors postgresContainer.ts one-to-one with the Sqlite* twins. Handle choice reproduces the PG
 * transaction topology exactly:
 *   - repositories PG builds on the ambient proxy (`dbx`, joins the route transaction) get
 *     `sqliteDb()` — the active transaction when there is one;
 *   - repositories PG builds on the raw pool (`db`, independent connection: audit, notifications,
 *     dashboard, users, licensing…) get `sqliteIndependentDb()` — reads on the reader, writes
 *     autonomous (they survive a route rollback, as an independent PG commit does).
 * The SQLite runtime is booted (migrations + fingerprint) before any member is used.
 */
import type { Container } from "./container.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { IMachineFingerprintProvider } from "../../application/ports/IMachineFingerprintProvider.js";
import type { IInstallationIdStorage } from "../../application/ports/IInstallationIdStorage.js";
import type { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import { redis, DbTokenDenylist, RedisTokenDenylist, CompositeTokenDenylist } from "../auth/TokenDenylist.js";
import { JwtSigner } from "../auth/JwtSigner.js";
import { Argon2PasswordHasher } from "../auth/PasswordHasher.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AesGcmSecretStore, decodeMasterKey } from "../secrets/AesGcmSecretStore.js";
import { NodeFingerprintProvider } from "../fingerprint/NodeFingerprintProvider.js";
import { DesktopInstallationIdStorage, InstallationIdStorage, desktopDataRoot } from "../installation/InstallationIdStorage.js";
import { SelfHostedLicenseProvider } from "../license/SelfHostedLicenseProvider.js";
import { buildLicenseTokenSignerForInstall } from "./licenseTokenSignerForInstall.js";
import { ensureSqliteRuntime } from "../orm/sqlite/runtime.js";
import { sqliteDb, sqliteIndependentDb } from "../orm/sqlite/transaction.js";
import { SqliteAuthRepository } from "../repositories/sqlite/SqliteAuthRepository.js";
import { SqlitePartyRepository } from "../repositories/sqlite/SqlitePartyRepository.js";
import { SqliteFabricRepository } from "../repositories/sqlite/SqliteFabricRepository.js";
import { SqliteColorRepository } from "../repositories/sqlite/SqliteColorRepository.js";
import { SqliteRollRepository } from "../repositories/sqlite/SqliteRollRepository.js";
import { SqliteStockMovementRepository } from "../repositories/sqlite/SqliteStockMovementRepository.js";
import { SqliteOrderRepository } from "../repositories/sqlite/SqliteOrderRepository.js";
import { SqliteInvoiceRepository } from "../repositories/sqlite/SqliteInvoiceRepository.js";
import { SqliteAuditRepository } from "../repositories/sqlite/SqliteAuditRepository.js";
import { SqliteVoucherRepository } from "../repositories/sqlite/SqliteVoucherRepository.js";
import { SqliteLedgerRepository } from "../repositories/sqlite/SqliteLedgerRepository.js";
import { SqliteStatementRepository } from "../repositories/sqlite/SqliteStatementRepository.js";
import { SqliteReturnRepository } from "../repositories/sqlite/SqliteReturnRepository.js";
import { SqliteCashboxRepository } from "../repositories/sqlite/SqliteCashboxRepository.js";
import { SqliteExpenseRepository } from "../repositories/sqlite/SqliteExpenseRepository.js";
import { SqlitePrintJobRepository } from "../repositories/sqlite/SqlitePrintJobRepository.js";
import { SqliteSearchRepository } from "../repositories/sqlite/SqliteSearchRepository.js";
import { SqliteReportsRepository } from "../repositories/sqlite/SqliteReportsRepository.js";
import { SqliteHealthRepository } from "../repositories/sqlite/SqliteHealthRepository.js";
import { SqliteNotificationRepository } from "../repositories/sqlite/SqliteNotificationRepository.js";
import { SqliteSettingsRepository } from "../repositories/sqlite/SqliteSettingsRepository.js";
import { SqliteDashboardRepository } from "../repositories/sqlite/SqliteDashboardRepository.js";
import { SqliteProfitRepository } from "../repositories/sqlite/SqliteProfitRepository.js";
import { SqliteDocumentTrackRepository } from "../repositories/sqlite/SqliteDocumentTrackRepository.js";
import { SqliteUserRepository } from "../repositories/sqlite/SqliteUserRepository.js";
import { SqliteCompanyRepository } from "../repositories/sqlite/SqliteCompanyRepository.js";
import { SqliteInvitationRepository } from "../repositories/sqlite/SqliteInvitationRepository.js";
import { SqliteLicenseRepository } from "../repositories/sqlite/SqliteLicenseRepository.js";
import { SqliteTenantRepository } from "../repositories/sqlite/SqliteTenantRepository.js";
import { SqliteInstallationStateRepository } from "../repositories/sqlite/SqliteInstallationStateRepository.js";
import { SqliteSecretsRepository } from "../repositories/sqlite/SqliteSecretsRepository.js";
import { SqliteSyncDeviceRepository } from "../repositories/sqlite/SqliteSyncDeviceRepository.js";
import { SqliteSyncOutboxRepository } from "../repositories/sqlite/SqliteSyncOutboxRepository.js";
import { SqliteSyncInboxRepository } from "../repositories/sqlite/SqliteSyncInboxRepository.js";
import { SqliteDocumentNumberBlockRepository } from "../repositories/sqlite/SqliteDocumentNumberBlockRepository.js";
import { SqliteSyncResourceClaimRepository } from "../repositories/sqlite/SqliteSyncResourceClaimRepository.js";

// Boot before the first request can reach a repository (desktop: runDesktopMigrations already did).
await ensureSqliteRuntime();

export function buildContainer(): Container {
  const jwtSigner = new JwtSigner();
  const passwordHasher = new Argon2PasswordHasher();
  const tokenDenylist = new CompositeTokenDenylist(
    new DbTokenDenylist(),
    redis ? new RedisTokenDenylist(redis) : null,
  );

  const dbx = sqliteDb(); // PG: ambientDb(db) — joins the route transaction
  const db = sqliteIndependentDb(); // PG: raw pool db — independent commit

  const authRepo = new SqliteAuthRepository(db);
  const partyRepo = new SqlitePartyRepository(dbx);
  const fabricRepo = new SqliteFabricRepository(dbx);
  const colorRepo = new SqliteColorRepository(dbx);
  const rollRepo = new SqliteRollRepository(dbx);
  const stockMovementRepo = new SqliteStockMovementRepository(db);
  const orderRepo = new SqliteOrderRepository(dbx);
  const invoiceRepo = new SqliteInvoiceRepository(dbx);
  const auditRepo = new SqliteAuditRepository(db);
  const voucherRepo = new SqliteVoucherRepository(dbx);
  const ledgerRepo = new SqliteLedgerRepository(dbx);
  const statementRepo = new SqliteStatementRepository(dbx);
  const returnRepo = new SqliteReturnRepository(dbx);
  const cashboxRepo = new SqliteCashboxRepository(dbx);
  const expenseRepo = new SqliteExpenseRepository(dbx);
  const printJobRepo = new SqlitePrintJobRepository(dbx);
  const searchRepo = new SqliteSearchRepository(dbx);
  const reportsRepo = new SqliteReportsRepository(dbx);
  const healthRepo = new SqliteHealthRepository(dbx);
  const notificationRepo = new SqliteNotificationRepository(db);
  const settingsRepo = new SqliteSettingsRepository(dbx);
  const dashboardRepo = new SqliteDashboardRepository(db);
  const profitRepo = new SqliteProfitRepository(db);
  const documentTrackRepo = new SqliteDocumentTrackRepository(db);
  const userRepo = new SqliteUserRepository(db);
  const companyRepo = new SqliteCompanyRepository(db);
  const invitationRepo = new SqliteInvitationRepository(db);
  const licenseRepo = new SqliteLicenseRepository(db);
  const tenantRepo = new SqliteTenantRepository(db);
  const installationStateRepo = new SqliteInstallationStateRepository(db);
  const syncDeviceRepo = new SqliteSyncDeviceRepository(db);
  const syncOutboxRepo = new SqliteSyncOutboxRepository(dbx);
  const syncInboxRepo = new SqliteSyncInboxRepository(db);
  const documentNumberBlockRepo = new SqliteDocumentNumberBlockRepository(db);
  const syncResourceClaimRepo = new SqliteSyncResourceClaimRepository(db);

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
  const secretsRepo: ISecretsRepository = new SqliteSecretsRepository(secretCipher, db);

  const fingerprintProvider: IMachineFingerprintProvider = new NodeFingerprintProvider();
  // D-2 (T088): on the desktop the installation id is per Windows user, in the per-user data root,
  // linked to the device-binding id. A non-desktop SQLite process (tests, tools) keeps the default.
  const installationIdStorage: IInstallationIdStorage =
    config.DESKTOP_DEPLOY && config.SQLITE_PATH
      ? new DesktopInstallationIdStorage(desktopDataRoot(config.SQLITE_PATH), config.MOTARD_INSTALLATION_ID)
      : new InstallationIdStorage();
  const licenseTokenSigner = buildLicenseTokenSignerForInstall();
  // Single source for both engines: tables resolved per engine (orm/engineSchema.ts).
  const licenseProvider: ILicenseProvider = new SelfHostedLicenseProvider(
    licenseTokenSigner,
    db as unknown as import("../orm/drizzle.js").DB,
  );

  return {
    db: dbx as unknown as Container["db"],
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
}
