import { db, type Tx } from "../orm/drizzle.js";
import { documentSequences } from "../orm/schemas/document-sequence.table.js";
import { documentNumberBlocks } from "../orm/schemas/document-number-block.table.js";
import { and, eq, sql } from "drizzle-orm";
import { BusinessRuleError } from "../../domain/errors/index.js";
import { config } from "../config/env.js";
import { consumeNextInTx } from "../repositories/PostgresDocumentNumberBlockRepository.js";

const PREFIXES: Record<string, string> = {
  invoice: "INV",
  // Entry (purchase) invoices get their own prefix AND their own sequence
  // counter — distinct entityType key below keeps the counters separate, so
  // the first entry invoice after this change is ENT-<year>-0001 while the
  // existing INV-<year>-NNNN sale-invoice counter continues untouched.
  invoice_entry: "ENT",
  return: "RET",
  voucher: "VOC",
  expense: "EXP",
  order: "ORD",
  print: "PRT",
  // H-6: the roll produced when a print job is received uses the same PRT
  // prefix as the print job's own document number, but is a DISTINCT
  // sequence (distinct entityType key) — otherwise the job-number counter
  // and the output-roll-number counter would become the same counter,
  // silently changing existing numbering semantics beyond what the race
  // fix requires.
  print_roll: "PRT",
  customer: "CUS",
  supplier: "SUP",
  settlement: "SET",
};

const WIDTHS: Record<string, number> = {
  invoice: 4,
  invoice_entry: 4,
  return: 4,
  voucher: 4,
  expense: 4,
  order: 4,
  print: 4,
  print_roll: 4,
};

/** Default reserved block sizes per entity (product defaults). */
export const DEFAULT_BLOCK_SIZES: Record<string, number> = {
  invoice: 500,
  invoice_entry: 200,
  return: 100,
  voucher: 200,
  expense: 100,
  order: 100,
};

export type AllocateNumberOpts = {
  /** Consume from this device's reserved block (desktop offline numbering). */
  syncDeviceId?: string | null;
  /**
   * Final number already reserved from a block — skip sequence bump;
   * raise the global floor so future claims cannot collide.
   */
  preAllocatedNumber?: string | null;
};

/**
 * Generate the next sequential document number for a given entity type and tenant.
 *
 * Fix (forensic audit 2026-08-15, live-reproduced 3x — settlement, expense,
 * order): the previous implementation did SELECT ... FOR UPDATE, then
 * branched into either an UPDATE (row exists) or an INSERT (row doesn't
 * exist yet). The INSERT branch — hit on the FIRST-EVER document of any
 * entityType for a tenant — was a genuine race: two concurrent callers can
 * both run the SELECT, both see zero rows (nothing exists yet to lock),
 * and both attempt the INSERT. One succeeds; the other throws an
 * uncaught `23505` unique-violation on idx_doc_seq_tenant_entity_prefix,
 * which was never caught anywhere in the call chain and crashed the
 * entire Node process via an unhandled promise rejection.
 *
 * Fixed by collapsing the whole read-branch-write sequence into a single
 * atomic `INSERT ... ON CONFLICT (tenant_id, entity_type, prefix) DO
 * UPDATE ... RETURNING`. Postgres guarantees this upsert-increment is
 * race-free even when two transactions attempt it for the same key at the
 * exact same instant — there is no window where two callers can compute
 * the same next-number, and no window where a first-use race can throw.
 *
 * Format: `{PREFIX}-{YYYY}-{NNNN}`
 *
 * @param entityType - e.g. "invoice", "return", "voucher", "expense", "order"
 * @param tenantId  - UUID of the tenant
 * @returns         - formatted document number string
 */
export async function nextDocumentNumber(entityType: string, tenantId: string): Promise<string> {
  const prefix = PREFIXES[entityType] ?? entityType.toUpperCase();
  const width = WIDTHS[entityType] ?? 4;
  const year = new Date().getFullYear().toString();

  const [row] = await db
    .insert(documentSequences)
    .values({ tenantId, entityType, prefix, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.entityType, documentSequences.prefix],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1` },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  const padded = String(row.lastNumber).padStart(width, "0");
  return `${prefix}-${year}-${padded}`;
}

/**
 * In-transaction number allocation. Same atomic upsert as `nextDocumentNumber`,
 * but runs against a caller-provided `Tx` so the sequence increment and the
 * downstream insert share one transaction — if the downstream insert fails,
 * the rollback undoes the sequence bump as well. This is the fix for the
 * "failed save burns a number" pathology: a use-case that throws, a FK that
 * violates, a stock guard that rejects — none of them leave a gap in the
 * numbering because the increment was never committed.
 *
 * Race-free for the same reason as `nextDocumentNumber` (single
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, which Postgres
 * serializes per-row), so concurrent callers in separate transactions still
 * receive distinct, consecutive numbers.
 *
 * Phase 5: when `preAllocatedNumber` is set, use it as-is (PRE_ALLOCATED) and
 * raise the global sequence floor. When `syncDeviceId` is set on desktop,
 * consume from a reserved device block instead of the global +1 path.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  entityType: string,
  tenantId: string,
  opts?: AllocateNumberOpts,
): Promise<string> {
  const { prefix, width } = resolveNumberFormat(entityType);
  const yearNum = new Date().getFullYear();
  const year = yearNum.toString();

  if (opts?.preAllocatedNumber) {
    return applyPreAllocatedNumber(tx, entityType, tenantId, opts.preAllocatedNumber, {
      prefix,
      width,
      yearNum,
    });
  }

  if (opts?.syncDeviceId && shouldUseNumberBlocks()) {
    const fromBlock = await consumeNextInTx(
      tx,
      tenantId,
      opts.syncDeviceId,
      entityType,
      yearNum,
    );
    if (!fromBlock) {
      throw new BusinessRuleError(
        "نفدت كتلة الترقيم لهذا الجهاز أو لا توجد كتلة للسنة الحالية — اطلب كتلة جديدة عند الاتصال",
      );
    }
    return `${prefix}-${year}-${String(fromBlock.numberValue).padStart(width, "0")}`;
  }

  const [row] = await tx
    .insert(documentSequences)
    .values({ tenantId, entityType, prefix, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.entityType, documentSequences.prefix],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1` },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  const padded = String(row.lastNumber).padStart(width, "0");
  return `${prefix}-${year}-${padded}`;
}

/**
 * Convenience wrapper: allocate a number inside the caller's transaction, then
 * invoke `fn` with the allocated number. The callback runs in the SAME
 * transaction, so any throw from `fn` rolls back the sequence increment.
 *
 * Use this when a single repository method needs both a new number and the
 * insert that consumes it. For repositories whose insert logic is already
 * a multi-statement transaction, prefer calling `allocateDocumentNumber`
 * directly at the top of the existing `db.transaction(async (tx) => ...)`
 * block.
 */
export async function withNumberedSequence<T>(
  tx: Tx,
  entityType: string,
  tenantId: string,
  fn: (number: string) => Promise<T>,
): Promise<T> {
  const number = await allocateDocumentNumber(tx, entityType, tenantId);
  return await fn(number);
}

export function resolveNumberFormat(entityType: string): { prefix: string; width: number } {
  return {
    prefix: PREFIXES[entityType] ?? entityType.toUpperCase(),
    width: WIDTHS[entityType] ?? 4,
  };
}

export function defaultBlockSize(entityType: string): number {
  return DEFAULT_BLOCK_SIZES[entityType] ?? 100;
}

function shouldUseNumberBlocks(): boolean {
  return Boolean(config.DESKTOP_DEPLOY || config.CENTRAL_SYNC_URL);
}

/**
 * Atomically reserve the next `size` numbers from document_sequences and
 * insert a device block covering that range.
 */
export async function claimNumberBlockInTx(
  tx: Tx,
  input: {
    tenantId: string;
    syncDeviceId: string;
    entityType: string;
    size?: number;
    year?: number;
  },
): Promise<{
  id: string;
  entityType: string;
  year: number;
  prefix: string;
  startNumber: number;
  endNumber: number;
  nextNumber: number;
}> {
  const year = input.year ?? new Date().getFullYear();
  const { prefix, width } = resolveNumberFormat(input.entityType);
  const size = input.size ?? defaultBlockSize(input.entityType);
  if (size < 1 || size > 5000) {
    throw new BusinessRuleError("حجم كتلة الترقيم غير صالح");
  }

  const maxValue = 10 ** width - 1;

  // Atomic tip advance: lastNumber += size, then range is (end-size+1)..end.
  const [bumped] = await tx
    .insert(documentSequences)
    .values({
      tenantId: input.tenantId,
      entityType: input.entityType,
      prefix,
      lastNumber: size,
    })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.entityType, documentSequences.prefix],
      set: { lastNumber: sql`${documentSequences.lastNumber} + ${size}` },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  const end = bumped.lastNumber;
  const start = end - size + 1;
  if (end > maxValue) {
    // Roll the tip back so we don't leave an unusable overshoot reserved.
    await tx
      .update(documentSequences)
      .set({ lastNumber: sql`${documentSequences.lastNumber} - ${size}` })
      .where(
        and(
          eq(documentSequences.tenantId, input.tenantId),
          eq(documentSequences.entityType, input.entityType),
          eq(documentSequences.prefix, prefix),
        ),
      );
    throw new BusinessRuleError(
      `لا يمكن حجز كتلة ترقيم — تجاوز الحد الأقصى للأرقام لهذه السنة (${maxValue})`,
    );
  }

  const [block] = await tx
    .insert(documentNumberBlocks)
    .values({
      tenantId: input.tenantId,
      syncDeviceId: input.syncDeviceId,
      entityType: input.entityType,
      year,
      prefix,
      startNumber: start,
      endNumber: end,
      nextNumber: start,
      status: "active",
    })
    .returning();

  return {
    id: block.id,
    entityType: block.entityType,
    year: block.year,
    prefix: block.prefix,
    startNumber: block.startNumber,
    endNumber: block.endNumber,
    nextNumber: block.nextNumber,
  };
}

/**
 * Reclaim unused tail of an active block when it is still the tip of the
 * global sequence (no later blocks claimed). Returns unused count.
 */
export async function reclaimNumberBlockTailInTx(
  tx: Tx,
  input: { tenantId: string; blockId: string },
): Promise<{ reclaimed: number; newGlobalLast: number | null }> {
  const [block] = await tx
    .select()
    .from(documentNumberBlocks)
    .where(
      and(
        eq(documentNumberBlocks.id, input.blockId),
        eq(documentNumberBlocks.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");

  if (!block || block.status !== "active") {
    return { reclaimed: 0, newGlobalLast: null };
  }

  const [seq] = await tx
    .select({ lastNumber: documentSequences.lastNumber })
    .from(documentSequences)
    .where(
      and(
        eq(documentSequences.tenantId, input.tenantId),
        eq(documentSequences.entityType, block.entityType),
        eq(documentSequences.prefix, block.prefix),
      ),
    )
    .limit(1)
    .for("update");

  if (!seq || seq.lastNumber !== block.endNumber) {
    return { reclaimed: 0, newGlobalLast: seq?.lastNumber ?? null };
  }

  const unused = block.endNumber - block.nextNumber + 1;
  if (unused <= 0) {
    await tx
      .update(documentNumberBlocks)
      .set({ status: "exhausted", updatedAt: new Date() })
      .where(eq(documentNumberBlocks.id, block.id));
    return { reclaimed: 0, newGlobalLast: seq.lastNumber };
  }

  const newGlobalLast = block.nextNumber - 1;
  await tx
    .update(documentSequences)
    .set({ lastNumber: Math.max(0, newGlobalLast) })
    .where(
      and(
        eq(documentSequences.tenantId, input.tenantId),
        eq(documentSequences.entityType, block.entityType),
        eq(documentSequences.prefix, block.prefix),
      ),
    );

  await tx
    .update(documentNumberBlocks)
    .set({
      endNumber: Math.max(newGlobalLast, block.startNumber - 1),
      status: newGlobalLast < block.startNumber ? "exhausted" : "reclaimed",
      reclaimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documentNumberBlocks.id, block.id));

  return { reclaimed: unused, newGlobalLast: Math.max(0, newGlobalLast) };
}

async function applyPreAllocatedNumber(
  tx: Tx,
  entityType: string,
  tenantId: string,
  preAllocatedNumber: string,
  fmt: { prefix: string; width: number; yearNum: number },
): Promise<string> {
  const parsed = parseDocumentNumber(preAllocatedNumber);
  if (!parsed) {
    throw new BusinessRuleError(`رقم مستند غير صالح: ${preAllocatedNumber}`);
  }
  if (parsed.prefix !== fmt.prefix) {
    throw new BusinessRuleError(
      `بادئة الرقم المحجوز (${parsed.prefix}) لا تطابق نوع المستند (${fmt.prefix})`,
    );
  }
  if (parsed.year !== fmt.yearNum) {
    throw new BusinessRuleError("لا يمكن قبول رقم محجوز من سنة مختلفة عن السنة الحالية");
  }

  // Raise global floor so future claims/allocations cannot collide.
  await tx
    .insert(documentSequences)
    .values({
      tenantId,
      entityType,
      prefix: fmt.prefix,
      lastNumber: parsed.n,
    })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.entityType, documentSequences.prefix],
      set: {
        lastNumber: sql`GREATEST(${documentSequences.lastNumber}, ${parsed.n})`,
      },
    });

  return `${fmt.prefix}-${parsed.year}-${String(parsed.n).padStart(fmt.width, "0")}`;
}

export function parseDocumentNumber(
  value: string,
): { prefix: string; year: number; n: number } | null {
  const m = /^([A-Z]+)-(\d{4})-(\d+)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[3]);
  if (!Number.isFinite(n) || n < 1) return null;
  return { prefix: m[1].toUpperCase(), year: Number(m[2]), n };
}

/**
 * READ-ONLY preview of the next document number — does NOT consume a number.
 *
 * Used by the UI to show what the number will most likely be on save
 * (#7: the old frontend preview kept a session-local counter that restarted
 * at 0001 on every reload, so it never matched the server-assigned number).
 * A plain SELECT on document_sequences: if the row doesn't exist yet the
 * first number would be 1. The real allocation still happens atomically at
 * save time, so under concurrency the preview remains an estimate.
 *
 * When a device block is active, preview the block's next_number instead.
 */
export async function peekNextDocumentNumber(
  entityType: string,
  tenantId: string,
  syncDeviceId?: string | null,
): Promise<string> {
  const { prefix, width } = resolveNumberFormat(entityType);
  const yearNum = new Date().getFullYear();
  const year = yearNum.toString();

  if (syncDeviceId && shouldUseNumberBlocks()) {
    const [block] = await db
      .select({ nextNumber: documentNumberBlocks.nextNumber, endNumber: documentNumberBlocks.endNumber })
      .from(documentNumberBlocks)
      .where(
        and(
          eq(documentNumberBlocks.tenantId, tenantId),
          eq(documentNumberBlocks.syncDeviceId, syncDeviceId),
          eq(documentNumberBlocks.entityType, entityType),
          eq(documentNumberBlocks.year, yearNum),
          eq(documentNumberBlocks.status, "active"),
        ),
      )
      .limit(1);
    if (block && block.nextNumber <= block.endNumber) {
      return `${prefix}-${year}-${String(block.nextNumber).padStart(width, "0")}`;
    }
  }

  const [row] = await db
    .select({ lastNumber: documentSequences.lastNumber })
    .from(documentSequences)
    .where(
      and(
        eq(documentSequences.tenantId, tenantId),
        eq(documentSequences.entityType, entityType),
        eq(documentSequences.prefix, prefix),
      ),
    )
    .limit(1);

  const next = (row?.lastNumber ?? 0) + 1;
  return `${prefix}-${year}-${String(next).padStart(width, "0")}`;
}
