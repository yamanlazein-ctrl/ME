export function invoiceRemaining(total: number, paid: number, returns: number = 0): number {
  return Math.max(0, total - paid - returns);
}

export function partyRemaining(total: number, paid: number, returns: number = 0): number {
  return Math.max(0, total - paid - returns);
}
