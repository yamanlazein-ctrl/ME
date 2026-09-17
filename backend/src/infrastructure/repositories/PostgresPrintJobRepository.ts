import { eq, and, desc, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import { printJobs } from "../orm/schemas/print-job.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { assertDayUnlocked } from "./dayLockHelper.js";
import { nextDocumentNumber } from "../utils/documentNumbers.js";
import {
  type PrintJobData,
  type CreatePrintJobInput,
  type ReceivePrintJobInput,
} from "../../domain/entities/PrintJob.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";
import { round2dp, convertAmount, isValidFxRate } from "@erp/shared";

export class PostgresPrintJobRepository implements IPrintJobRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<PrintJobData | null> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.id, id), eq(printJobs.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(ctx: TenantContext): Promise<PrintJobData[]> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(eq(printJobs.tenantId, ctx.tenantId))
      .orderBy(desc(printJobs.createdAt));
    return rows.map((r) => this.toDomain(r));
  }

  async listOpen(ctx: TenantContext): Promise<PrintJobData[]> {
    const rows = await this.db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.tenantId, ctx.tenantId), eq(printJobs.status, "sent")))
      .orderBy(desc(printJobs.createdAt));
    return rows.map((r) => this.toDomain(r));
  }

  async create(
    input: CreatePrintJobInput,
    number: string,
    ctx: TenantContext,
  ): Promise<PrintJobData> {
    let sourceFabricId = input.sourceFabricId;
    let sourceColorId = input.sourceColorId;
    if (input.sourceRollId && (!sourceFabricId || !sourceColorId)) {
      const src = await this.db
        .select({ colorId: rolls.colorId, remainingKg: rolls.remainingKg })
        .from(rolls)
        .where(and(eq(rolls.id, input.sourceRollId), eq(rolls.tenantId, ctx.tenantId)))
        .limit(1);
      if (src.length > 0) {
        // Guard: refuse to send more than the roll currently holds. Stock is
        // deducted at SEND time (see below), so this check prevents overselling
        // against already-committed print jobs and sales.
        if (Number(src[0].remainingKg) < input.quantityKg) {
          throw new Error(
            `كمية الإرسال (${input.quantityKg} كغ) تتجاوز المخزون المتاح (${Number(src[0].remainingKg)} كغ)`,
          );
        }
        const colorRow = await this.db
          .select({ fabricId: colors.fabricId })
          .from(colors)
          .where(and(eq(colors.id, src[0].colorId), eq(colors.tenantId, ctx.tenantId)))
          .limit(1);
        if (colorRow.length > 0) {
          sourceColorId = src[0].colorId;
          sourceFabricId = colorRow[0].fabricId;
        }
      }
    }
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(printJobs)
        .values({
          tenantId: ctx.tenantId,
          number,
          date: input.date,
          sourceRollId: input.sourceRollId,
          sourceFabricId: sourceFabricId ?? null,
          sourceColorId: sourceColorId ?? null,
          quantityKg: String(input.quantityKg),
          pieces: input.pieces ?? 1,
          pressName: input.pressName,
          printCostPerKg: input.printCostPerKg ? String(input.printCostPerKg) : null,
          currency: input.currency ?? "SYP",
          newName: input.newName,
          newCategory: input.newCategory,
          newColorName: input.newColorName,
          newColorCode: input.newColorCode,
          newSalePricePerKg: input.newSalePricePerKg ? String(input.newSalePricePerKg) : null,
          notes: input.notes,
          createdBy: ctx.userId,
          customerId: input.customerId ?? null,
          orderId: input.orderId ?? null,
          chargePerKg: input.chargePerKg ? String(input.chargePerKg) : null,
        })
        .returning();

      // Phase 2.2 — financial entry for the printing service: when the job is
      // for a customer with a charge, DEBIT the customer for qty × chargePerKg
      // (receivable for the printing service). No cash impact — settled via
      // receipt vouchers later.
      if (input.customerId && input.chargePerKg) {
        const chargeAmount = round2dp(input.quantityKg * input.chargePerKg);
        if (chargeAmount > 0) {
          // C4 fix: double-entry — balance the customer receivable with revenue.
          await tx.insert(ledgerEntries).values([
            {
              tenantId: ctx.tenantId,
              partyId: input.customerId,
              date: input.date,
              type: "printing_charge",
              debit: chargeAmount,
              credit: 0,
              currency: input.currency ?? "SYP",
              cashImpact: "none",
              referenceType: "print_job",
              referenceId: r.id,
              referenceNumber: number,
              description: `أجرة طباعة ${number} (${input.quantityKg} كغ × ${input.chargePerKg})`,
              createdBy: ctx.userId,
            },
            {
              tenantId: ctx.tenantId,
              partyId: null,
              date: input.date,
              type: "printing_revenue",
              debit: 0,
              credit: chargeAmount,
              currency: input.currency ?? "SYP",
              cashImpact: "none",
              referenceType: "print_job",
              referenceId: r.id,
              referenceNumber: number,
              description: `إيراد طباعة ${number}`,
              createdBy: ctx.userId,
            },
          ]);
        }
      }

      // BUG-6 fix: deduct the source roll at SEND time — the fabric physically
      // leaves the warehouse when the job is created. This prevents the source
      // kg from being sold or re-sent while the job is out for printing, and
      // matches the UI promise ("خصم كمية من القماش الخام").
      if (input.sourceRollId && input.quantityKg > 0) {
        const [srcLock] = await tx
          .select()
          .from(rolls)
          .where(and(eq(rolls.id, input.sourceRollId), eq(rolls.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        if (!srcLock) throw new Error("اللفافة المصدر غير موجودة");
        if (Number(srcLock.remainingKg) < input.quantityKg) {
          throw new Error(
            `كمية الإرسال (${input.quantityKg} كغ) تتجاوز المخزون المتاح (${Number(srcLock.remainingKg)} كغ)`,
          );
        }
        const newSrcKg = Number(srcLock.remainingKg) - input.quantityKg;
        await tx
          .update(rolls)
          .set({
            remainingKg: String(newSrcKg),
            status: sql`CASE WHEN ${String(newSrcKg)} <= '0' THEN 'exhausted' ELSE ${rolls.status} END`,
            version: sql`${rolls.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(rolls.id, input.sourceRollId), eq(rolls.tenantId, ctx.tenantId)));
        await recordStockMovement(
          tx,
          {
            rollId: input.sourceRollId,
            direction: "out",
            movementType: "print_send",
            quantityKg: input.quantityKg,
            balanceAfterKg: newSrcKg,
            referenceType: "print_job",
            referenceId: r.id,
            referenceNumber: number,
            movementDate: input.date,
            description: `إرسال طباعة ${number}`,
          },
          ctx,
        );
      }
      return r;
    });
    return this.toDomain(row);
  }

  async receive(input: ReceivePrintJobInput, ctx: TenantContext): Promise<PrintJobData> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(printJobs)
        .where(
          and(
            eq(printJobs.id, input.jobId),
            eq(printJobs.tenantId, ctx.tenantId),
            eq(printJobs.status, "sent"),
          ),
        )
        .for("update")
        .limit(1);
      if (!job) throw new Error("أمر الطباعة غير موجود أو تم استلامه مسبقاً");

      const [srcRoll] = await tx
        .select()
        .from(rolls)
        .where(and(eq(rolls.id, job.sourceRollId), eq(rolls.tenantId, ctx.tenantId)))
        .limit(1);
      if (!srcRoll) throw new Error("اللفافة المصدر غير موجودة");

      let resultFabricId = job.resultFabricId;
      let resultColorId = job.resultColorId;
      let resultRollId: string | null = null;

      if (input.receivedKg != null && input.receivedKg >= 0) {
        if (!resultFabricId) {
          if (input.newName) {
            const existingFab = await tx
              .select()
              .from(fabrics)
              .where(and(eq(fabrics.tenantId, ctx.tenantId), eq(fabrics.name, input.newName)))
              .limit(1);
            if (existingFab.length > 0) {
              resultFabricId = existingFab[0].id;
            } else {
              const [fab] = await tx
                .insert(fabrics)
                .values({
                  tenantId: ctx.tenantId,
                  name: input.newName,
                  category: input.newCategory ?? job.newCategory,
                })
                .returning();
              resultFabricId = fab.id;
            }
          } else {
            resultFabricId = job.sourceFabricId ?? null;
          }
        }

        if (resultFabricId) {
          const sourceFabricId = job.sourceFabricId ?? null;
          const fabricChanged = resultFabricId !== sourceFabricId;
          const baseColorId = job.sourceColorId ?? srcRoll.colorId;
          // Issue 11: never attach a result roll to the SOURCE color when the
          // fabric was renamed — inventory name resolves via color→fabric, so
          // reusing source colorId left the old fabric name on the new roll.
          if (input.newColorName?.trim() || fabricChanged) {
            let colorName = input.newColorName?.trim() ?? "";
            if (!colorName && baseColorId) {
              const [srcCol] = await tx
                .select({ name: colors.name })
                .from(colors)
                .where(and(eq(colors.id, baseColorId), eq(colors.tenantId, ctx.tenantId)))
                .limit(1);
              colorName = srcCol?.name?.trim() || "افتراضي";
            }
            if (!colorName) colorName = "افتراضي";
            const existingCol = await tx
              .select()
              .from(colors)
              .where(
                and(
                  eq(colors.tenantId, ctx.tenantId),
                  eq(colors.fabricId, resultFabricId),
                  eq(colors.name, colorName),
                ),
              )
              .limit(1);
            if (existingCol.length > 0) {
              resultColorId = existingCol[0].id;
            } else {
              const [col] = await tx
                .insert(colors)
                .values({
                  tenantId: ctx.tenantId,
                  fabricId: resultFabricId,
                  name: colorName,
                  code: input.newColorCode ?? null,
                })
                .returning();
              resultColorId = col.id;
            }
          } else {
            resultColorId = baseColorId;
          }
        }

        // Fix H-6 (forensic audit 2026-08-15, live-reproduced): rollNo used to
        // be derived from `count(*) WHERE rollNo ILIKE 'PRT-%'` + 1 — a
        // check-then-act race identical in shape to H-4/document_sequences.
        // Two concurrent print-job completions could both count the same N
        // and both attempt to insert the SAME PRT-YYYY-NNNN roll number;
        // since rollNo is uniquely indexed per tenant
        // (idx_rolls_tenant_roll_no), the loser crashed the whole process
        // with an uncaught 23505 violation instead of failing gracefully.
        // Routed through the shared nextDocumentNumber() sequence generator
        // (same atomic INSERT...ON CONFLICT DO UPDATE used by every other
        // document type), which is race-free by construction.
        const generatedRollNo = await nextDocumentNumber("print_roll", ctx.tenantId);

        const srcPrice = Number(srcRoll.pricePerKg ?? 0);
        const printCost = input.printCostPerKg != null ? Number(input.printCostPerKg) : 0;
        const srcCur = srcRoll.currency ?? "SYP";
        const currency = input.currency ?? srcCur;
        const fxRate = input.exchangeRate;
        // Same FX rule as invoices: non-USD receive needs a manual rate.
        // Cross-currency also needs a rate when the non-USD side is involved.
        const needsFx =
          currency !== "USD" || (srcCur !== currency && srcCur !== "USD");
        // Soft FX (N8): do not hard-block receive when rate is missing —
        // convertAmount falls back to source price; FE asks for confirmation.
        if (srcCur !== currency && srcCur !== "USD" && currency !== "USD") {
          throw new Error(
            `لا يمكن تحويل تكلفة المصدر من ${srcCur} إلى ${currency} مباشرة — اختر نفس عملة اللفافة أو الدولار`,
          );
        }
        const srcInReceive =
          convertAmount(
            srcPrice,
            {
              currency: srcCur,
              exchangeRate: srcCur === "USD" ? 1 : isValidFxRate(fxRate) ? fxRate : null,
            },
            {
              currency,
              exchangeRate: currency === "USD" ? 1 : isValidFxRate(fxRate) ? fxRate : null,
            },
          ) ?? srcPrice;
        const unitCost = round2dp(srcInReceive + printCost);
        const salePrice = input.newSalePricePerKg ?? srcRoll.salePricePerKg ?? undefined;
        // B1 fix: entryDate is NOT NULL in the rolls table; fall back to today's
        // date (or the print job's date) if the caller didn't supply one.
        const effectiveDate = input.date ?? job.date ?? new Date().toISOString().slice(0, 10);

        // BUG-05 fix: compute sellable pieces for the result roll. Previously
        // this insert omitted pieces/remainingPieces so every printed roll was
        // created with remaining_pieces=0 while any sale requires pieces>=1 —
        // making ALL printed fabric unsellable. Scale the pieces recorded on
        // the print job by the received/sent kg ratio (waste shrinks pieces),
        // minimum 1 when anything was received.
        const resultPieces = Math.max(
          (input.receivedKg ?? 0) > 0 ? 1 : 0,
          Math.round((Number(job.pieces) || 1) * ((input.receivedKg ?? 0) / (Number(job.quantityKg) || 1))),
        );

        const [newRoll] = await tx
          .insert(rolls)
          .values({
            tenantId: ctx.tenantId,
            colorId: resultColorId ?? srcRoll.colorId,
            rollNo: generatedRollNo,
            dyeBatch: srcRoll.dyeBatch,
            initialKg: String(input.receivedKg),
            remainingKg: String(input.receivedKg),
            pricePerKg: String(unitCost),
            salePricePerKg: salePrice != null ? String(salePrice) : null,
            currency,
            supplierId: srcRoll.supplierId ?? null,
            entryDate: effectiveDate,
            widthCm: srcRoll.widthCm ? String(srcRoll.widthCm) : null,
            weightGsm: srcRoll.weightGsm ? String(srcRoll.weightGsm) : null,
            pieces: resultPieces,
            remainingPieces: resultPieces,
          })
          .returning();
        resultRollId = newRoll.id;

        // BUG-3 fix: reject over-receive instead of silently clamping.
        // The source roll was already deducted at SEND time (quantityKg), so
        // receiving more than the sent quantity is physically impossible and
        // must be rejected — a silent Math.max(0, ...) hides an integrity break.
        if (input.receivedKg != null && input.receivedKg > Number(job.quantityKg)) {
          throw new Error(
            `الكمية المستلمة (${input.receivedKg} كغ) تتجاوز الكمية المرسلة (${Number(job.quantityKg)} كغ)`,
          );
        }
        // The result roll's initial kg equals receivedKg. The source roll was
        // already deducted at send time — no further source deduction here.
        await recordStockMovement(
          tx,
          {
            rollId: newRoll.id,
            direction: "in",
            movementType: "print_receive",
            quantityKg: input.receivedKg ?? 0,
            balanceAfterKg: input.receivedKg ?? 0,
            referenceType: "print_job",
            referenceId: job.id,
            referenceNumber: job.number ?? newRoll.id,
            movementDate: effectiveDate,
            description: `استلام طباعة ${job.number} (صبغة ${generatedRollNo})`,
          },
          ctx,
        );

        // C6 — document the printing loss (waste): sent − received. The
        // source roll was already deducted at SEND time, so this movement is
        // purely informational (balanceAfter stays unchanged) — it makes the
        // loss explicit and auditable instead of a silent gap.
        const wasteKg = Math.max(0, Number(job.quantityKg) - (input.receivedKg ?? 0));
        if (wasteKg > 0) {
          await recordStockMovement(
            tx,
            {
              rollId: job.sourceRollId,
              direction: "out",
              movementType: "print_waste",
              quantityKg: wasteKg,
              balanceAfterKg: Number(srcRoll.remainingKg),
              referenceType: "print_job",
              referenceId: job.id,
              referenceNumber: job.number ?? "",
              movementDate: effectiveDate,
              description: `هدر طباعة ${job.number} (${wasteKg} كغ)`,
            },
            ctx,
          );
        }
      }

      // BUG-06 fix (approach A): the printing cost is CAPITALIZED into the
      // result roll's unit cost (see pricePerKg = srcPrice + printCost above),
      // so it must reach the P&L exactly ONCE — via COGS when the printed
      // fabric is sold. The old separate EXPENSE row double-counted it.
      // Cash outflow tracking is preserved: Dr inventory / Cr cash (impact=out).
      const effectiveDate2 = input.date ?? job.date ?? new Date().toISOString().slice(0, 10);
      let costExpenseId: string | null = null;
      const costPerKg = input.printCostPerKg ?? Number(job.printCostPerKg ?? 0);
      const receivedKgNum = input.receivedKg ?? 0;
      if (costPerKg > 0 && receivedKgNum > 0) {
        const printCostTotal = round2dp(receivedKgNum * costPerKg);
        if (printCostTotal > 0) {
          // OI-7: printing cost paid now moves cash out — reject on a closed day.
          await assertDayUnlocked(tx, ctx.tenantId, effectiveDate2);
          await tx.insert(ledgerEntries).values([
            {
              tenantId: ctx.tenantId,
              partyId: null,
              date: effectiveDate2,
              type: "inventory_asset",
              debit: printCostTotal,
              credit: 0,
              currency: input.currency ?? job.currency ?? "SYP",
              cashImpact: "none",
              referenceType: "print_job",
              referenceId: job.id,
              referenceNumber: `EXP-${job.number}`,
              description: `رسملة تكلفة طباعة ${job.number} (${receivedKgNum} كغ × ${costPerKg})`,
              createdBy: ctx.userId,
            },
            {
              tenantId: ctx.tenantId,
              partyId: null,
              date: effectiveDate2,
              type: "cash",
              debit: 0,
              credit: printCostTotal,
              currency: input.currency ?? job.currency ?? "SYP",
              cashImpact: "out",
              referenceType: "print_job",
              referenceId: job.id,
              referenceNumber: `EXP-${job.number}`,
              description: `دفع نقدي للمطبعة EXP-${job.number}`,
              createdBy: ctx.userId,
            },
          ]);
        }
      }

      const [updated] = await tx
        .update(printJobs)
        .set({
          status: "received",
          receivedKg: input.receivedKg != null ? String(input.receivedKg) : null,
          printCostPerKg: input.printCostPerKg != null ? String(input.printCostPerKg) : null,
          currency: input.currency ?? job.currency,
          exchangeRate:
            input.exchangeRate != null && input.exchangeRate > 0
              ? String(input.exchangeRate)
              : null,
          newName: input.newName ?? job.newName,
          newCategory: input.newCategory ?? job.newCategory,
          newColorName: input.newColorName ?? job.newColorName,
          newColorCode: input.newColorCode ?? job.newColorCode,
          newSalePricePerKg:
            input.newSalePricePerKg != null ? String(input.newSalePricePerKg) : job.newSalePricePerKg,
          resultRollId,
          resultFabricId: resultFabricId ?? null,
          resultColorId: resultColorId ?? null,
          receiveNotes: input.notes ?? null,
          receivedAt: new Date(),
          costExpenseId,
        })
        .where(and(eq(printJobs.id, input.jobId), eq(printJobs.tenantId, ctx.tenantId)))
        .returning();
      return this.toDomain(updated);
    });
  }

  private toDomain(row: typeof printJobs.$inferSelect): PrintJobData {
    return this.mapRow(row);
  }

  private mapRow(row: typeof printJobs.$inferSelect): PrintJobData {
    const n = (v: string | null) => v ?? undefined;
    const num = (v: string | null) => (v != null && v !== "" ? Number(v) : undefined);
    return {
      id: row.id,
      tenantId: row.tenantId,
      number: row.number ?? "",
      date: row.date,
      status: row.status as PrintJobData["status"],
      sourceRollId: row.sourceRollId,
      sourceFabricId: n(row.sourceFabricId),
      sourceColorId: n(row.sourceColorId),
      quantityKg: Number(row.quantityKg),
      pieces: row.pieces != null ? Number(row.pieces) : undefined,
      pressName: n(row.pressName),
      printCostPerKg: num(row.printCostPerKg),
      currency: row.currency,
      exchangeRate: num(row.exchangeRate),
      newName: n(row.newName),
      newCategory: n(row.newCategory),
      newColorName: n(row.newColorName),
      newColorCode: n(row.newColorCode),
      newSalePricePerKg: num(row.newSalePricePerKg),
      receivedKg: num(row.receivedKg),
      receivedAt: row.receivedAt ? row.receivedAt.toISOString() : undefined,
      wasteKg:
        row.receivedKg != null
          ? Math.max(0, Number(row.quantityKg) - Number(row.receivedKg))
          : undefined,
      resultRollId: n(row.resultRollId),
      resultFabricId: n(row.resultFabricId),
      resultColorId: n(row.resultColorId),
      notes: n(row.notes),
      receiveNotes: n(row.receiveNotes),
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      customerId: row.customerId ?? undefined,
      orderId: row.orderId ?? undefined,
      chargePerKg: num(row.chargePerKg),
      costExpenseId: row.costExpenseId ?? undefined,
    };
  }
}
