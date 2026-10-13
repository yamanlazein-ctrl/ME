/**
 * MIG-04 — pure comparison of two hub fingerprints (no database, no configuration), shared by the
 * server module (hubFingerprint.ts) and the CLI (scripts/compare-hub-fingerprints.mts).
 */
export type HubFingerprint = {
  tenantId: string;
  engine: string;
  takenAt: string;
  tables: Record<string, { rows: number; sha256: string }>;
  balances: Array<{ partyId: string; currency: string; balance: string }>;
  stock: Array<{ rollId: string; remainingKg: string; remainingPieces: string }>;
  stream: { headAppliedSeq: number | null; inboxByStatus: Record<string, number> };
};

/** Changes with every sign-in: a difference is reported as a warning, not a failure. */
const VOLATILE = new Set(["audit_logs"]);

/**
 * Old vs new server. `ok` only when every verified table, every balance, every roll and the
 * stream head match exactly — both servers must be frozen while their fingerprints are taken, so
 * any difference (also a higher head on either side) fails.
 */
export function compareFingerprints(
  oldFp: HubFingerprint,
  newFp: HubFingerprint,
): { ok: boolean; differences: string[]; warnings: string[] } {
  const differences: string[] = [];
  const warnings: string[] = [];
  if (oldFp.tenantId !== newFp.tenantId)
    differences.push(`company differs: ${oldFp.tenantId} vs ${newFp.tenantId}`);
  if (oldFp.engine !== newFp.engine)
    differences.push(`engine differs: ${oldFp.engine} vs ${newFp.engine} (compare like with like)`);
  for (const t of new Set([...Object.keys(oldFp.tables), ...Object.keys(newFp.tables)])) {
    const a = oldFp.tables[t];
    const b = newFp.tables[t];
    if (a && b && a.rows === b.rows && a.sha256 === b.sha256) continue;
    const line = `table ${t}: ${a?.rows ?? "missing"} rows vs ${b?.rows ?? "missing"} rows${
      a && b && a.rows === b.rows ? " (same count, different content)" : ""
    }`;
    (VOLATILE.has(t) ? warnings : differences).push(line);
  }
  const key = (x: { partyId: string; currency: string }) => `${x.partyId}/${x.currency}`;
  const newBal = new Map(newFp.balances.map((b) => [key(b), b.balance]));
  const oldBal = new Map(oldFp.balances.map((b) => [key(b), b.balance]));
  for (const [k, v] of oldBal)
    if (newBal.get(k) !== v)
      differences.push(`balance ${k}: ${v} vs ${newBal.get(k) ?? "missing"}`);
  for (const [k, v] of newBal)
    if (!oldBal.has(k)) differences.push(`balance ${k}: missing vs ${v}`);
  const newStock = new Map(
    newFp.stock.map((s) => [s.rollId, `${s.remainingKg}/${s.remainingPieces}`]),
  );
  for (const s of oldFp.stock) {
    const v = `${s.remainingKg}/${s.remainingPieces}`;
    if (newStock.get(s.rollId) !== v)
      differences.push(`roll ${s.rollId}: ${v} vs ${newStock.get(s.rollId) ?? "missing"}`);
  }
  if (newFp.stock.length !== oldFp.stock.length)
    differences.push(`roll count: ${oldFp.stock.length} vs ${newFp.stock.length}`);
  if (oldFp.stream.headAppliedSeq !== newFp.stream.headAppliedSeq)
    differences.push(
      `sync stream head: ${oldFp.stream.headAppliedSeq} vs ${newFp.stream.headAppliedSeq}`,
    );
  return { ok: differences.length === 0, differences, warnings };
}
