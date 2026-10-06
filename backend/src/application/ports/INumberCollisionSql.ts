/**
 * The three statements behind the sync number-collision rule
 * (syncNumberCollision.ts), per engine (specs/001-desktop-sqlite-engine S1).
 * Each runs on the caller-provided executor (a db or an open transaction).
 */
export interface CollisionTarget {
  table: string;
  column: string;
  /** Extra columns of the unique index, with the incoming values. */
  scope: Record<string, string>;
}

export interface INumberCollisionSql {
  /** Id of another row (≠ exceptId) holding `value`, or null. */
  holderOf(executor: unknown, tenantId: string, target: CollisionTarget, value: string, exceptId: string): Promise<string | null>;
  renameValue(executor: unknown, tenantId: string, target: CollisionTarget, holderId: string, newValue: string): Promise<void>;
  /** Keep a paid invoice's `RCP-<number>` receipt in step with a renamed invoice number. */
  renameDerivedReceipt(executor: unknown, tenantId: string, invoiceId: string, oldNo: string, newNo: string): Promise<void>;
}
