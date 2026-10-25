// One place for React Query keys, so a financial write can invalidate everything it changes (FR-09, FR-13).
export const queryKeys = {
  dashboard: ["dashboard"] as const,
  parties: ["parties"] as const,
  party: (id: string) => ["parties", id] as const,
  statement: (id: string) => ["statements", id] as const,
  cashbox: ["cashbox"] as const,
  inventory: ["inventory"] as const,
  invoices: ["invoices"] as const,
  invoice: (id: string) => ["invoices", id] as const,
  sync: ["sync"] as const,
};
