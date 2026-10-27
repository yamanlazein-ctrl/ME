// One place for React Query keys, so a financial write can invalidate everything it changes (FR-09, FR-13).
export const queryKeys = {
  dashboard: ["dashboard"] as const,
  parties: ["parties"] as const,
  party: (id: string) => ["parties", id] as const,
  statement: (id: string) => ["statements", id] as const,
  cashbox: ["cashbox"] as const,
  inventory: ["inventory"] as const,
  fabricStock: (q: string) => ["inventory", "fabrics", q] as const,
  colorStock: (fabricId: string) => ["inventory", "colors", fabricId] as const,
  colorRolls: (colorId: string) => ["inventory", "rolls", colorId] as const,
  roll: (rollId: string) => ["inventory", "roll", rollId] as const,
  countSheet: (year: number, q: string) => ["inventory", "count", year, q] as const,
  invoices: ["invoices"] as const,
  invoice: (id: string) => ["invoices", id] as const,
  sync: ["sync"] as const,
};
