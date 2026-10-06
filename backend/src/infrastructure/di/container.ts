/**
 * DI container (specs/001-desktop-sqlite-engine T030/T053): one interface, two wirings.
 *   - DB_ENGINE=postgres → postgresContainer.ts (today's wiring, unchanged);
 *   - DB_ENGINE=sqlite   → sqliteContainer.ts (Sqlite* twins).
 * The chosen wiring is loaded with a dynamic import, so a SQLite process never evaluates the
 * PostgreSQL layer (FR-040) and vice versa.
 */
import { getEngine } from "../orm/engine.js";
import type { IUserRepository } from "../../application/ports/IUserRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IFabricRepository } from "../../application/ports/IFabricRepository.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import type { IRollRepository } from "../../application/ports/IRollRepository.js";
import type { IStockMovementRepository } from "../../application/ports/IStockMovementRepository.js";
import type { IOrderRepository } from "../../application/ports/IOrderRepository.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import type { IReturnRepository } from "../../application/ports/IReturnRepository.js";
import type { ICashboxRepository } from "../../application/ports/ICashboxRepository.js";
import type { IExpenseRepository } from "../../application/ports/IExpenseRepository.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import type { ISearchRepository } from "../../application/ports/ISearchRepository.js";
import type { IReportsRepository } from "../../application/ports/IReportsRepository.js";
import type { IHealthRepository } from "../../application/ports/IHealthRepository.js";
import type { INotificationRepository } from "../../application/ports/INotificationRepository.js";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import type { IDashboardRepository } from "../../application/ports/IDashboardRepository.js";
import type { IProfitRepository } from "../../application/ports/IProfitRepository.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
import type { ICompanyRepository } from "../../application/ports/ICompanyRepository.js";
import type { IInvitationRepository } from "../../application/ports/IInvitationRepository.js";
import type { ILicenseRepository } from "../../application/ports/ILicenseRepository.js";
import type { ITenantRepository } from "../../application/ports/ITenantRepository.js";
import type { IInstallationStateRepository } from "../../application/ports/IInstallationStateRepository.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { ISyncDeviceRepository } from "../../application/ports/ISyncDeviceRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { ISyncInboxRepository } from "../../application/ports/ISyncInboxRepository.js";
import type { IDocumentNumberBlockRepository } from "../../application/ports/IDocumentNumberBlockRepository.js";
import type { ISyncResourceClaimRepository } from "../../application/ports/ISyncResourceClaimRepository.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import type { IMachineFingerprintProvider } from "../../application/ports/IMachineFingerprintProvider.js";
import type { IInstallationIdStorage } from "../installation/InstallationIdStorage.js";
import type { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";
import type { JWK } from "jose";
import type { JwtSigner } from "../auth/JwtSigner.js";
import type { Argon2PasswordHasher } from "../auth/PasswordHasher.js";
import type { TokenDenylist } from "../auth/TokenDenylist.js";
import type { IDocumentTrackRepository } from "../../application/ports/IDocumentTrackRepository.js";

export interface Container {
  /** The engine's Drizzle handle: PG `db` (drizzle.ts) or the ambient SQLite handle (sqliteDb()). */
  db: import("../orm/drizzle.js").DB;
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
  searchRepo: ISearchRepository;
  reportsRepo: IReportsRepository;
  healthRepo: IHealthRepository;
  notificationRepo: INotificationRepository;
  settingsRepo: ISettingsRepository;
  dashboardRepo: IDashboardRepository;
  profitRepo: IProfitRepository;
  documentTrackRepo: IDocumentTrackRepository;
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

const wiring =
  getEngine() === "sqlite" ? await import("./sqliteContainer.js") : await import("./postgresContainer.js");

export function buildContainer(): Container {
  return wiring.buildContainer();
}
