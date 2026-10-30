// One place for React Query keys, so a financial write can invalidate everything it changes (FR-09, FR-13).
export const queryKeys = {
  dashboard: ["dashboard"] as const,
  parties: ["parties"] as const,
  party: (id: string) => ["parties", id] as const,
  statement: (id: string) => ["statements", id] as const,
  cashbox: ["cashbox"] as const,
  inventory: ["inventory"] as const,
  countSheet: (year: number, q: string) => ["inventory", "count", year, q] as const,
  stockFabrics: (q: string, filter: string, category: string | null) =>
    ["inventory", "stock", q, filter, category ?? ""] as const,
  stockCategories: ["inventory", "categories"] as const,
  stockLots: (q: string) => ["inventory", "lot-search", q] as const,
  stockFabric: (id: string) => ["inventory", "fabric", id] as const,
  stockColor: (id: string) => ["inventory", "color", id] as const,
  stockLot: (id: string) => ["inventory", "lot", id] as const,
  invoices: ["invoices"] as const,
  invoice: (id: string) => ["invoices", id] as const,
  sync: ["sync"] as const,
};
