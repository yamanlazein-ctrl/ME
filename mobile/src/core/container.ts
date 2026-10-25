// Phone composition root (replaces backend/src/infrastructure/di/sqliteContainer.ts, which also wires
// JwtSigner, Argon2, licensing and the Node fingerprint). It wires only the repositories the phone needs,
// over the same handles sqliteContainer.ts uses, and never imports sqliteContainer.ts.
import { sqliteDb, sqliteIndependentDb } from "@backend/infrastructure/orm/sqlite/transaction";
import { SqlitePartyRepository } from "@backend/infrastructure/repositories/sqlite/SqlitePartyRepository";
import { SqliteFabricRepository } from "@backend/infrastructure/repositories/sqlite/SqliteFabricRepository";
import { SqliteColorRepository } from "@backend/infrastructure/repositories/sqlite/SqliteColorRepository";
import { SqliteRollRepository } from "@backend/infrastructure/repositories/sqlite/SqliteRollRepository";
import { SqliteStockMovementRepository } from "@backend/infrastructure/repositories/sqlite/SqliteStockMovementRepository";
import { SqliteOrderRepository } from "@backend/infrastructure/repositories/sqlite/SqliteOrderRepository";
import { SqliteInvoiceRepository } from "@backend/infrastructure/repositories/sqlite/SqliteInvoiceRepository";
import { SqliteAuditRepository } from "@backend/infrastructure/repositories/sqlite/SqliteAuditRepository";
import { SqliteVoucherRepository } from "@backend/infrastructure/repositories/sqlite/SqliteVoucherRepository";
import { SqliteLedgerRepository } from "@backend/infrastructure/repositories/sqlite/SqliteLedgerRepository";
import { SqliteStatementRepository } from "@backend/infrastructure/repositories/sqlite/SqliteStatementRepository";
import { SqliteReturnRepository } from "@backend/infrastructure/repositories/sqlite/SqliteReturnRepository";
import { SqliteCashboxRepository } from "@backend/infrastructure/repositories/sqlite/SqliteCashboxRepository";
import { SqliteExpenseRepository } from "@backend/infrastructure/repositories/sqlite/SqliteExpenseRepository";
import { SqlitePrintJobRepository } from "@backend/infrastructure/repositories/sqlite/SqlitePrintJobRepository";
import { SqliteSearchRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSearchRepository";
import { SqliteReportsRepository } from "@backend/infrastructure/repositories/sqlite/SqliteReportsRepository";
import { SqliteNotificationRepository } from "@backend/infrastructure/repositories/sqlite/SqliteNotificationRepository";
import { SqliteSettingsRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSettingsRepository";
import { SqliteDashboardRepository } from "@backend/infrastructure/repositories/sqlite/SqliteDashboardRepository";
import { SqliteProfitRepository } from "@backend/infrastructure/repositories/sqlite/SqliteProfitRepository";
import { SqliteDocumentTrackRepository } from "@backend/infrastructure/repositories/sqlite/SqliteDocumentTrackRepository";
import { SqliteUserRepository } from "@backend/infrastructure/repositories/sqlite/SqliteUserRepository";
import { SqliteCompanyRepository } from "@backend/infrastructure/repositories/sqlite/SqliteCompanyRepository";
import { SqliteSyncDeviceRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSyncDeviceRepository";
import { SqliteSyncOutboxRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSyncOutboxRepository";
import { SqliteSyncInboxRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSyncInboxRepository";
import { SqliteDocumentNumberBlockRepository } from "@backend/infrastructure/repositories/sqlite/SqliteDocumentNumberBlockRepository";
import { SqliteSyncResourceClaimRepository } from "@backend/infrastructure/repositories/sqlite/SqliteSyncResourceClaimRepository";

export function buildPhoneRepositories() {
  const dbx = sqliteDb(); // joins the active transaction
  const db = sqliteIndependentDb(); // independent commit
  return {
    db: dbx,
    partyRepo: new SqlitePartyRepository(dbx),
    fabricRepo: new SqliteFabricRepository(dbx),
    colorRepo: new SqliteColorRepository(dbx),
    rollRepo: new SqliteRollRepository(dbx),
    stockMovementRepo: new SqliteStockMovementRepository(db),
    orderRepo: new SqliteOrderRepository(dbx),
    invoiceRepo: new SqliteInvoiceRepository(dbx),
    auditRepo: new SqliteAuditRepository(db),
    voucherRepo: new SqliteVoucherRepository(dbx),
    ledgerRepo: new SqliteLedgerRepository(dbx),
    statementRepo: new SqliteStatementRepository(dbx),
    returnRepo: new SqliteReturnRepository(dbx),
    cashboxRepo: new SqliteCashboxRepository(dbx),
    expenseRepo: new SqliteExpenseRepository(dbx),
    printJobRepo: new SqlitePrintJobRepository(dbx),
    searchRepo: new SqliteSearchRepository(dbx),
    reportsRepo: new SqliteReportsRepository(dbx),
    notificationRepo: new SqliteNotificationRepository(db),
    settingsRepo: new SqliteSettingsRepository(dbx),
    dashboardRepo: new SqliteDashboardRepository(db),
    profitRepo: new SqliteProfitRepository(db),
    documentTrackRepo: new SqliteDocumentTrackRepository(db),
    userRepo: new SqliteUserRepository(dbx),
    companyRepo: new SqliteCompanyRepository(db),
    syncDeviceRepo: new SqliteSyncDeviceRepository(db),
    syncOutboxRepo: new SqliteSyncOutboxRepository(dbx),
    syncInboxRepo: new SqliteSyncInboxRepository(db),
    documentNumberBlockRepo: new SqliteDocumentNumberBlockRepository(db),
    syncResourceClaimRepo: new SqliteSyncResourceClaimRepository(db),
  };
}

export type PhoneRepositories = ReturnType<typeof buildPhoneRepositories>;
