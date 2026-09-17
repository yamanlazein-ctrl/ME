import { CancelExpenseUseCase } from "@/application/expenses/CancelExpense";
import { CreateExpenseUseCase } from "@/application/expenses/CreateExpense";
import { ListExpensesUseCase } from "@/application/expenses/ListExpenses";

import {
  CreateFabricUseCase,
  CreateColorUseCase,
  CreateRollUseCase,
  ReserveStockUseCase,
  ListFabricsUseCase,
  ListColorsUseCase,
  ListRollsUseCase,
} from "@/application/use-cases/inventory";

import {
  CreateInvoiceUseCase,
  CancelInvoiceUseCase,
  ListInvoicesUseCase,
} from "@/application/use-cases/invoices";

import {
  CreateReceiptVoucherUseCase,
  CreatePaymentVoucherUseCase,
  CancelVoucherUseCase,
} from "@/application/use-cases/vouchers";

import {
  CreatePartyUseCase,
  ListPartiesUseCase,
  GetPartyBalanceUseCase,
} from "@/application/use-cases/parties";

import {
  CreateOrderUseCase,
  ListOrdersUseCase,
  CancelOrderUseCase,
  FulfillOrderUseCase,
} from "@/application/use-cases/orders";

import {
  ListReturnsUseCase,
  CreateReturnUseCase,
  CancelReturnUseCase,
} from "@/application/use-cases/returns";

import {
  CashboxStateUseCase,
  AddManualMovementUseCase,
  CloseDayUseCase,
  ListMovementsUseCase,
} from "@/application/use-cases/cashbox";

import { GetDashboardUseCase } from "@/application/use-cases/dashboard";
import { ListNotificationsUseCase } from "@/application/use-cases/notifications";
import { CreatePrintSendUseCase, ReceivePrintUseCase } from "@/application/use-cases/print-jobs";

/* ── Api repositories ───────────────────────────────────────────── */
import { ApiExpenseNamesRepository } from "./repositories/api/ApiExpenseNamesRepository";
import { ApiExpenseRepository } from "./repositories/api/ApiExpenseRepository";
import { ApiInventoryRepository } from "./repositories/api/ApiInventoryRepository";
import { ApiInvoiceRepository } from "./repositories/api/ApiInvoiceRepository";
import { ApiLedgerRepository } from "./repositories/api/ApiLedgerRepository";
import { ApiPartyRepository } from "./repositories/api/ApiPartyRepository";
import { ApiVoucherRepository } from "./repositories/api/ApiVoucherRepository";
import { ApiOrderRepository } from "./repositories/api/ApiOrderRepository";
import { ApiReturnRepository } from "./repositories/api/ApiReturnRepository";
import { ApiCashboxRepository } from "./repositories/api/ApiCashboxRepository";
import { ApiDashboardRepository } from "./repositories/api/ApiDashboardRepository";
import { ApiNotificationRepository } from "./repositories/api/ApiNotificationRepository";
import { ApiAuthRepository } from "./repositories/api/ApiAuthRepository";
import { ApiPrintJobRepository } from "./repositories/api/ApiPrintJobRepository";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { BaseHttpClient } from "./http";
import {
  authInterceptor,
  loggingInterceptor,
  tenantHeaderInterceptor,
  offlineModeInterceptor,
} from "./http/interceptors";
import { createTokenProvider } from "./auth/TokenProvider";
import {
  AuthApiService,
  AuditApiService,
  CashboxApiService,
  DashboardApiService,
  ExpenseApiService,
  InventoryApiService,
  InvoiceApiService,
  LedgerApiService,
  NotificationApiService,
  OrderApiService,
  PartyApiService,
  PrintJobApiService,
  ProfitApiService,
  ReturnApiService,
  SettingsApiService,
  StatementApiService,
  SyncConflictsApiService,
  VoucherApiService,
  FxApiService,
} from "./api";

const baseUrl = getApiBaseUrl();
const apiClient = new BaseHttpClient({ baseUrl, timeoutMs: 15_000 });
apiClient.addInterceptor(
  tenantHeaderInterceptor(() => {
    try {
      const t = localStorage.getItem("erp.auth.accessToken");
      if (t) {
        const payload = JSON.parse(atob(t.split(".")[1]));
        return payload.tenantId ?? null;
      }
    } catch {
      // Missing/corrupt token — no tenant header; auth interceptor handles auth.
    }
    return null;
  }),
);
apiClient.addInterceptor(authInterceptor(createTokenProvider()));
apiClient.addInterceptor(offlineModeInterceptor());
apiClient.addInterceptor(
  loggingInterceptor(() => {
    try {
      return localStorage.getItem("erp.auth.accessToken");
    } catch {
      return null;
    }
  }),
);

/* ── API repository instances ───────────────────────────────────── */
const expenseRepo = new ApiExpenseRepository(new ExpenseApiService(apiClient));
const expenseNamesRepo = new ApiExpenseNamesRepository(new ExpenseApiService(apiClient));
const inventoryRepo = new ApiInventoryRepository(new InventoryApiService(apiClient));
const invoiceRepo = new ApiInvoiceRepository(new InvoiceApiService(apiClient));
const invoiceApi = new InvoiceApiService(apiClient);
const auditApi = new AuditApiService(apiClient);
const ledgerRepo = new ApiLedgerRepository(new LedgerApiService(apiClient));
const partyRepo = new ApiPartyRepository(new PartyApiService(apiClient));
const voucherRepo = new ApiVoucherRepository(new VoucherApiService(apiClient));
const orderRepo = new ApiOrderRepository(new OrderApiService(apiClient));
const returnRepo = new ApiReturnRepository(new ReturnApiService(apiClient));
const cashboxRepo = new ApiCashboxRepository(new CashboxApiService(apiClient));
const settingsApi = new SettingsApiService(apiClient);
const statementApi = new StatementApiService(apiClient);
const profitApi = new ProfitApiService(apiClient);
const dashboardRepo = new ApiDashboardRepository(new DashboardApiService(apiClient));
const notificationRepo = new ApiNotificationRepository(new NotificationApiService(apiClient));
const syncConflictsApi = new SyncConflictsApiService(apiClient);
const printJobRepo = new ApiPrintJobRepository(new PrintJobApiService(apiClient));
const authRepo = new ApiAuthRepository(new AuthApiService(apiClient));
// Header reference-rate widget only (⛔ display-only — never billing logic).
const fxApi = new FxApiService(apiClient);

export const container = {
  auth: { repository: authRepo },

  expenses: {
    list: new ListExpensesUseCase(expenseRepo),
    create: new CreateExpenseUseCase(expenseRepo, expenseNamesRepo),
    cancel: new CancelExpenseUseCase(expenseRepo),
    names: expenseNamesRepo,
  },

  inventory: {
    get createFabric() {
      return new CreateFabricUseCase(inventoryRepo);
    },
    get createColor() {
      return new CreateColorUseCase(inventoryRepo);
    },
    get createRoll() {
      return new CreateRollUseCase(inventoryRepo);
    },
    get reserveStock() {
      return new ReserveStockUseCase(inventoryRepo);
    },
    get listFabrics() {
      return new ListFabricsUseCase(inventoryRepo);
    },
    get listColors() {
      return new ListColorsUseCase(inventoryRepo);
    },
    get listRolls() {
      return new ListRollsUseCase(inventoryRepo);
    },
    repository: inventoryRepo,
  },

  invoices: {
    list: new ListInvoicesUseCase(invoiceRepo),
    create: new CreateInvoiceUseCase(invoiceRepo),
    cancel: new CancelInvoiceUseCase(invoiceRepo),
    get repository() {
      return invoiceRepo;
    },
    get api() {
      return invoiceApi;
    },
    get ledger() {
      return ledgerRepo;
    },
  },

  audit: {
    get api() {
      return auditApi;
    },
  },

  parties: {
    get list() {
      return new ListPartiesUseCase(partyRepo);
    },
    get create() {
      return new CreatePartyUseCase(partyRepo);
    },
    get balance() {
      return new GetPartyBalanceUseCase(ledgerRepo);
    },
    repository: partyRepo,
  },

  vouchers: {
    get createReceipt() {
      return new CreateReceiptVoucherUseCase(voucherRepo, ledgerRepo);
    },
    get createPayment() {
      return new CreatePaymentVoucherUseCase(voucherRepo, ledgerRepo);
    },
    get cancel() {
      return new CancelVoucherUseCase(voucherRepo, ledgerRepo);
    },
    repository: voucherRepo,
  },

  orders: {
    get list() {
      return new ListOrdersUseCase(orderRepo);
    },
    get create() {
      return new CreateOrderUseCase(orderRepo);
    },
    get cancel() {
      return new CancelOrderUseCase(orderRepo);
    },
    get fulfill() {
      return new FulfillOrderUseCase(orderRepo);
    },
    repository: orderRepo,
  },

  returns: {
    get list() {
      return new ListReturnsUseCase(returnRepo);
    },
    get create() {
      return new CreateReturnUseCase(returnRepo);
    },
    get cancel() {
      return new CancelReturnUseCase(returnRepo, ledgerRepo);
    },
  },

  cashbox: {
    state: new CashboxStateUseCase(cashboxRepo),
    addMovement: new AddManualMovementUseCase(cashboxRepo),
    closeDay: new CloseDayUseCase(cashboxRepo),
    movements: new ListMovementsUseCase(cashboxRepo),
  },

  dashboard: {
    get: new GetDashboardUseCase(dashboardRepo),
  },

  settings: {
    api: settingsApi,
  },

  fx: {
    // Reference USD→SYP badge in the header. ⛔ Display-only: must never be
    // consumed by invoice/voucher forms or any exchangeRate field.
    api: fxApi,
  },

  statement: {
    api: statementApi,
  },

  profit: {
    api: profitApi,
  },

  notifications: {
    list: new ListNotificationsUseCase(notificationRepo),
  },

  syncConflicts: {
    api: syncConflictsApi,
  },

  printJobs: {
    get send() {
      return new CreatePrintSendUseCase(printJobRepo);
    },
    get receive() {
      return new ReceivePrintUseCase(printJobRepo);
    },
    repository: printJobRepo,
  },
} as const;

export type Container = typeof container;
