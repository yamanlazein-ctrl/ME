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
import { LicenseTokenSigner } from "../auth/LicenseTokenSigner.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { logger } from "../config/logger.js";

export interface Container {
  db: typeof db;
  jwtSigner: JwtSigner;
  passwordHasher: Argon2PasswordHasher;
  tokenDenylist: TokenDenylist;
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
  profitRepo: IProfitRepository;
  userRepo: IUserRepository;
  companyRepo: ICompanyRepository;
  invitationRepo: IInvitationRepository;
  licenseRepo: ILicenseRepository;
  tenantRepo: ITenantRepository;
  installationStateRepo: IInstallationStateRepository;
  secretCipher: ISecretCipher;
  secretsRepo: ISecretsRepository;
  syncDeviceRepo: ISyncDeviceRepository;
  syncOutboxRepo: ISyncOutboxRepository;
  syncInboxRepo: ISyncInboxRepository;
  documentNumberBlockRepo: IDocumentNumberBlockRepository;
  syncResourceClaimRepo: ISyncResourceClaimRepository;
  fingerprintProvider: IMachineFingerprintProvider;
  installationIdStorage: IInstallationIdStorage;
  licenseTokenSigner: ILicenseTokenSigner;
  licenseProvider: ILicenseProvider;
}

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
  const notificationRepo = new PostgresNotificationRepository(db);
  const settingsRepo = new PostgresSettingsRepository(dbx);
  const dashboardRepo = new PostgresDashboardRepository(db);
  const profitRepo = new PostgresProfitRepository(db);
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
    profitRepo,
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

/**
 * Build the license token signer for a customer install.
 *
 * - When `LICENSE_SIGNING_KEY` is set (self-hosted single process), both
 *   sign + verify work (PEM form). `LICENSE_SIGNING_PUBLIC_KEY` is optional:
 *   the public key is derived from the private key when absent.
 * - When only the PUBLIC key is set (separate License Server), the
 *   customer install can verify but not sign.
 * - When neither is set, **auto-generate and persist** a new keypair to
 *   `backend/.env` so subsequent restarts reuse the same key (offline
 *   license tokens survive restarts). Production requires the key to be
 *   pre-set (see env.ts) — auto-persist only happens in non-production.
 */
function buildLicenseTokenSignerForInstall(): LicenseTokenSigner {
  // `.trim()` so a blank/whitespace-only env value counts as absent rather
  // than reaching the PEM parser with nothing usable.
  if (config.LICENSE_SIGNING_KEY?.trim()) {
    return LicenseTokenSigner.fromPems(
      config.LICENSE_SIGNING_KEY,
      config.LICENSE_SIGNING_PUBLIC_KEY ?? "",
    );
  }
  if (config.LICENSE_SIGNING_PUBLIC_KEY?.trim()) {
    return LicenseTokenSigner.fromPems(null, config.LICENSE_SIGNING_PUBLIC_KEY);
  }

  // ── Auto-persist: generate a keypair, save to .env, use it ──
  // Production refuses to boot without the key (see env.ts), so we only
  // reach here in development/test. Instead of an ephemeral key (lost on
  // every restart), generate ONCE and write it to `backend/.env` so every
  // subsequent boot reuses the same persistent key. This prevents offline
  // license tokens from silently becoming invalid after a server restart.
  //
  // DESKTOP_DEPLOY hard-disables this branch: the desktop client must never
  // mint or persist a PRIVATE signing key (D3 — the private key stays only on
  // the license server). In this mode the public key alone is expected; if it
  // is absent too, env.ts has already refused to boot, so we never reach here
  // with a writable private key in a desktop install.
  if (config.DESKTOP_DEPLOY) {
    throw new Error(
      "DESKTOP_DEPLOY requires LICENSE_SIGNING_PUBLIC_KEY to be set — the desktop client " +
        "must not generate or persist a private signing key. Provide the public key only.",
    );
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const pubPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();
  const oneLine = (pem: string) => pem.replace(/\n/g, "\\n");

  // Derive backend/.env path relative to this source file.
  // container.ts lives at backend/src/infrastructure/di/, so THREE levels up
  // reach backend/ (unlike license-server.ts at backend/src/scripts/, which
  // needs only two).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", "..", "..", ".env");
  const envBlock = [
    "",
    "# ── License signing keypair (Ed25519) — auto-generated once, DO NOT regenerate ──",
    "# Rotating these invalidates every offline license token already issued.",
    `LICENSE_SIGNING_KEY="${oneLine(privPem)}"`,
    `LICENSE_SIGNING_PUBLIC_KEY="${oneLine(pubPem)}"`,
    "",
  ].join("\n");

  // Append to .env only if LICENSE_SIGNING_KEY is not already present.
  try {
    if (!existsSync(envPath) || !/^\s*LICENSE_SIGNING_KEY\s*=/m.test(readFileSync(envPath, "utf8"))) {
      appendFileSync(envPath, envBlock, "utf8");
      logger.info(
        { envPath },
        "LICENSE_SIGNING_KEY not set — generated a persistent Ed25519 keypair and appended to .env. " +
          "Future restarts will reuse this key. Production environments must define their own key explicitly.",
      );
    }
  } catch (err) {
    logger.warn({ err, envPath }, "Failed to persist LICENSE_SIGNING_KEY to .env — using in-memory key only");
  }

  // Set the keys in process.env so the rest of the boot (and any
  // sibling processes) see them immediately.
  process.env.LICENSE_SIGNING_KEY = privPem.replace(/\n/g, "\\n");
  process.env.LICENSE_SIGNING_PUBLIC_KEY = pubPem.replace(/\n/g, "\\n");

  const privJwk = privateKey.export({ format: "jwk" }) as JWK;
  const pubJwk = publicKey.export({ format: "jwk" }) as JWK;
  return new LicenseTokenSigner(privJwk, pubJwk);
}
