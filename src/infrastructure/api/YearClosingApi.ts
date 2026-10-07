import { container } from "@/infrastructure/container";

/**
 * Client for the year-end closing + physical count endpoints.
 *
 * The closing figures are ALL server-computed (PostgreSQL SUMs, keyset
 * pagination) and come back ready to render — the screen never pulls a ledger
 * or a stock list to work the arithmetic out itself.
 */

export type YearStatus = "open" | "counting" | "ready" | "closed";

export type YearRow = { year: number; status: YearStatus; closedAt: string | null };

export type ClosingPreview = {
  year: number;
  periodStart: string;
  periodEnd: string;
  status: YearStatus;
  /** Per currency — never merged into one number. */
  closingCashbox: Record<string, number>;
  closingInventoryValue: Record<string, number>;
  counts: {
    rolls: number;
    counted: number;
    pending: number;
    posted: number;
    withVariance: number;
    gainsKg: number;
    lossesKg: number;
  };
  /** Non-empty ⇒ the close button stays disabled. */
  blockers: string[];
};

export type CountLine = {
  countId: string | null;
  rollId: string;
  rollNo: string;
  fabricName: string;
  colorName: string;
  bookKg: number;
  bookPieces: number;
  countedKg: number | null;
  countedPieces: number | null;
  diffKg: number | null;
  diffPieces: number | null;
  /** Stock moved since the count (live − book at count): posting asks for a re-count. */
  movedKg: number | null;
  movedPieces: number | null;
  pricePerKg: number;
  currency: string;
  status: string;
};

export type CountSheetFilter = {
  cursor?: string | null;
  q?: string;
  status?: "uncounted" | "counted" | "variance" | "posted";
  since?: string;
  includeEmpty?: boolean;
  limit?: number;
};

export type CloseResult = {
  year: number;
  status: "closed";
  closedAt: string;
  closingCashbox: Record<string, number>;
  carriedParties: Record<string, number>;
  inventoryVariance: { gainsKg: number; lossesKg: number; netKg: number; lines: number };
  closingInventoryValue: Record<string, number>;
};

export function listYears(): Promise<YearRow[]> {
  return container.http.get<YearRow[]>("/api/financial-years").then((r) => r.data);
}

export function getClosingPreview(year: number): Promise<ClosingPreview> {
  return container.http
    .get<ClosingPreview>(`/api/financial-years/${year}/closing-preview`)
    .then((r) => r.data);
}

export function beginCounting(year: number): Promise<{ year: number; status: string }> {
  return container.http
    .post<{ year: number; status: string }>("/api/financial-years/begin-counting", { year })
    .then((r) => r.data);
}

/** Keyset-paginated: only one page of rolls is ever held in the WebView. */
export function getCountSheet(
  year: number,
  filter: CountSheetFilter = {},
): Promise<{ lines: CountLine[]; nextCursor: string | null; total: number }> {
  const params: Record<string, string> = { year: String(year) };
  if (filter.cursor) params.cursor = filter.cursor;
  if (filter.q?.trim()) params.q = filter.q.trim();
  if (filter.status) params.status = filter.status;
  if (filter.since) params.since = filter.since;
  if (filter.includeEmpty) params.includeEmpty = "1";
  if (filter.limit) params.limit = String(filter.limit);
  return container.http
    .get<{ lines: CountLine[]; nextCursor: string | null; total: number }>(
      "/api/financial-years/count-sheet",
      { params },
    )
    .then((r) => r.data);
}

export function recordCount(input: {
  year: number;
  rollId: string;
  countedKg: number | null;
  countedPieces?: number | null;
  reason?: string;
}): Promise<{ rollId: string; diffKg: number | null }> {
  return container.http
    .post<{ rollId: string; diffKg: number | null }>("/api/financial-years/counts", input)
    .then((r) => r.data);
}

export function postVariance(
  countId: string,
): Promise<{ rollId: string; diffKg: number; movementId: string | null }> {
  return container.http
    .post<{ rollId: string; diffKg: number; movementId: string | null }>(
      "/api/financial-years/counts/post",
      { countId },
    )
    .then((r) => r.data);
}

export function closeYear(year: number, reason?: string): Promise<CloseResult> {
  return container.http
    .post<CloseResult>("/api/financial-years/close", {
      year,
      confirm: "إقفال",
      ...(reason ? { reason } : {}),
    })
    .then((r) => r.data);
}

export function reopenYear(year: number, reason: string): Promise<{ year: number; status: string }> {
  return container.http
    .post<{ year: number; status: string }>("/api/financial-years/reopen", { year, reason })
    .then((r) => r.data);
}
