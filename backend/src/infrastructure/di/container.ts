import { db } from "../orm/drizzle.js";
import { redis, RedisTokenDenylist } from "../auth/TokenDenylist.js";
import { JwtSigner } from "../auth/JwtSigner.js";
import { Argon2PasswordHasher } from "../auth/PasswordHasher.js";
import { config } from "../config/env.js";
import { PostgresPartyRepository } from "../repositories/PostgresPartyRepository.js";
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
import { PostgresNotificationRepository } from "../repositories/PostgresNotificationRepository.js";
import type { INotificationRepository } from "../../application/ports/INotificationRepository.js";
import { PostgresSettingsRepository } from "../repositories/PostgresSettingsRepository.js";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import { PostgresDashboardRepository } from "../repositories/PostgresDashboardRepository.js";
import type { IDashboardRepository } from "../../application/ports/IDashboardRepository.js";
import { PostgresAuthRepository } from "../repositories/PostgresAuthRepository.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
import { PostgresCompanyRepository } from "../repositories/PostgresCompanyRepository.js";
import type { ICompanyRepository } from "../../application/ports/ICompanyRepository.js";
import { PostgresInvitationRepository } from "../repositories/PostgresInvitationRepository.js";
import type { IInvitationRepository } from "../../application/ports/IInvitationRepository.js";
import { PostgresLicenseRepository } from "../repositories/PostgresLicenseRepository.js";
import type { ILicenseRepository } from "../../application/ports/ILicenseRepository.js";
import { PostgresTenantRepository } from "../repositories/PostgresTenantRepository.js";
import type { ITenantRepository } from "../../application/ports/ITenantRepository.js";
import { PostgresInstallationStateRepository } from "../repositories/PostgresInstallationStateRepository.js";
import type { IInstallationStateRepository } from "../../application/ports/IInstallationStateRepository.js";
import { PostgresSecretsRepository } from "../repositories/PostgresSecretsRepository.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import { AesGcmSecretStore, decodeMasterKey } from "../secrets/AesGcmSecretStore.js";
import { NodeFingerprintProvider } from "../fingerprint/NodeFingerprintProvider.js";
import type { IMachineFingerprintProvider } from "../../application/ports/IMachineFingerprintProvider.js";
import { InstallationIdStorage } from "../installation/InstallationIdStorage.js";
import type { IInstallationIdStorage } from "../installation/InstallationIdStorage.js";
import { SelfHostedLicenseProvider } from "../license/SelfHostedLicenseProvider.js";
import type { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import { LicenseTokenSigner } from "../auth/LicenseTokenSigner.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";
import { generateKeyPairSync } from "node:crypto";
import type { JWK } from "jose";
import { logger } from "../config/logger.js";

export interface Container {
  db: typeof db;
  jwtSigner: JwtSigner;
  passwordHasher: Argon2PasswordHasher;
  tokenDenylist: RedisTokenDenylist;
  authRepo: IAuthRepository;
  partyRepo: IPartyRepository;
  fabricRepo: IFabricRepository;
  colorRepo: IColorRepository;
  rollRepo: IRollRepository;
  stockMovementRepo: IStockMovementRepository;
  orderRepo: IOrderRepository;
  invoiceRepo: IInvoiceRepository;
  auditRepo: IAuditRepository;
  voucherRepo: IVoucherRepository;
  ledgerRepo: ILedgerRepository;
  statementRepo: IStatementRepository;
  returnRepo: IReturnRepository;
  cashboxRepo: ICashboxRepository;
  expenseRepo: IExpenseRepository;
  printJobRepo: IPrintJobRepository;
  notificationRepo: INotificationRepository;
  settingsRepo: ISettingsRepository;
  dashboardRepo: IDashboardRepository;
  companyRepo: ICompanyRepository;
  invitationRepo: IInvitationRepository;
  licenseRepo: ILicenseRepository;
  tenantRepo: ITenantRepository;
  installationStateRepo: IInstallationStateRepository;
  secretCipher: ISecretCipher;
  secretsRepo: ISecretsRepository;
  fingerprintProvider: IMachineFingerprintProvider;
  installationIdStorage: IInstallationIdStorage;
  licenseTokenSigner: ILicenseTokenSigner;
  licenseProvider: ILicenseProvider;
}

export function buildContainer(): Container {
  const jwtSigner = new JwtSigner();
  const passwordHasher = new Argon2PasswordHasher();
  const tokenDenylist = new RedisTokenDenylist(redis);

  const authRepo = new PostgresAuthRepository(db);
  const partyRepo = new PostgresPartyRepository(db);
  const fabricRepo = new PostgresFabricRepository(db);
  const colorRepo = new PostgresColorRepository(db);
  const rollRepo = new PostgresRollRepository(db);
  const stockMovementRepo = new PostgresStockMovementRepository(db);
  const orderRepo = new PostgresOrderRepository(db);
  const invoiceRepo = new PostgresInvoiceRepository(db);
  const auditRepo = new PostgresAuditRepository(db);
  const voucherRepo = new PostgresVoucherRepository(db);
  const ledgerRepo = new PostgresLedgerRepository(db);
  const statementRepo = new PostgresStatementRepository(db);
  const returnRepo = new PostgresReturnRepository(db);
  const cashboxRepo = new PostgresCashboxRepository(db);
  const expenseRepo = new PostgresExpenseRepository(db);
  const printJobRepo = new PostgresPrintJobRepository(db);
  const notificationRepo = new PostgresNotificationRepository(db);
  const settingsRepo = new PostgresSettingsRepository(db);
  const dashboardRepo = new PostgresDashboardRepository(db);

  // ── Phase 0 sub-batch extensions ──
  const companyRepo = new PostgresCompanyRepository(db);
  const invitationRepo = new PostgresInvitationRepository(db);
  const licenseRepo = new PostgresLicenseRepository(db);
  const tenantRepo = new PostgresTenantRepository(db);
  const installationStateRepo = new PostgresInstallationStateRepository(db);

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

  return {
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
    notificationRepo,
    settingsRepo,
    dashboardRepo,
    companyRepo,
    invitationRepo,
    licenseRepo,
    tenantRepo,
    installationStateRepo,
    secretCipher,
    secretsRepo,
    fingerprintProvider,
    installationIdStorage,
    licenseTokenSigner,
    licenseProvider,
  };
}

/**
 * Build the license token signer for a customer install.
 *
 * - When `LICENSE_SIGNING_KEY` is set (self-hosted single process), both
 *   sign + verify work (PEM form).
 * - When only the PUBLIC key is set (separate License Server), the
 *   customer install can verify but not sign.
 * - When neither is set, generate an ephemeral keypair in dev so the app
 *   boots; a warning is logged. In production this MUST be configured.
 */
function buildLicenseTokenSignerForInstall(): LicenseTokenSigner {
  if (config.LICENSE_SIGNING_KEY) {
    return LicenseTokenSigner.fromPems(
      config.LICENSE_SIGNING_KEY,
      config.LICENSE_SIGNING_PUBLIC_KEY ?? "",
    );
  }
  if (config.LICENSE_SIGNING_PUBLIC_KEY) {
    return LicenseTokenSigner.fromPems(null, config.LICENSE_SIGNING_PUBLIC_KEY);
  }
  logger.warn(
    "LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY not set; generating an ephemeral " +
      "keypair (NOT for production — license offline tokens will not survive restarts)",
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privJwk = privateKey.export({ format: "jwk" }) as JWK;
  const pubJwk = publicKey.export({ format: "jwk" }) as JWK;
  return new LicenseTokenSigner(privJwk, pubJwk);
}
