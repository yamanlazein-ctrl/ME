import { eq, and, desc, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import { printJobs } from "../orm/schemas/print-job.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { expenses } from "../orm/schemas/expense.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { nextDocumentNumber } from "../utils/documentNumbers.js";
import {
  type PrintJobData,
  type CreatePrintJobInput,
  type ReceivePrintJobInput,
} from "../../domain/entities/PrintJob.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";

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
        // only deducted at receive time (by receivedKg), so without this check a
        // print job could be created against stock that has already been sold.
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
        const chargeAmount = Math.round(input.quantityKg * input.chargePerKg);
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
              description: `Printing charge ${number} (${input.quantityKg}kg × ${input.chargePerKg})`,
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
              description: `Printing revenue ${number}`,
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
        if (!srcLock) throw new Error("Source roll not found");
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
            description: `Print send ${number}`,
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
      if (!job) throw new Error("Print job not found or already received");

      const [srcRoll] = await tx
        .select()
        .from(rolls)
        .where(and(eq(rolls.id, job.sourceRollId), eq(rolls.tenantId, ctx.tenantId)))
        .limit(1);
      if (!srcRoll) throw new Error("Source roll not found");

      let resultFabricId = job.resultFabricId;
      let resultColorId = job.resultColorId;
      let resultRollId: string | null = null;

      if (input.receivedKg != null && input.receivedKg >= 0) {
        if (!resultFabricId) {
          if (input.newName) {
            const existingFab = await tx
              .select()
              .from(fabrics)
              .where(
                and(
                  eq(fabrics.tenantId, ctx.tenantId),
                  eq(fabrics.name, input.newName),
                ),
              )
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
          const baseColorId = job.sourceColorId ?? srcRoll.colorId;
          if (input.newColorName) {
            const existingCol = await tx
              .select()
              .from(colors)
              .where(
                and(
                  eq(colors.tenantId, ctx.tenantId),
                  eq(colors.fabricId, resultFabricId),
                  eq(colors.name, input.newColorName),
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
                  name: input.newColorName,
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
        const printCost = input.printCostPerKg ? Number(input.printCostPerKg) : 0;
        const currency = input.currency ?? (srcRoll.currency ?? "SYP");
        const salePrice = input.newSalePricePerKg ?? srcRoll.salePricePerKg ?? undefined;
        // B1 fix: entryDate is NOT NULL in the rolls table; fall back to today's
        // date (or the print job's date) if the caller didn't supply one.
        const effectiveDate =
          input.date ?? job.date ?? new Date().toISOString().slice(0, 10);

        const [newRoll] = await tx
          .insert(rolls)
          .values({
            tenantId: ctx.tenantId,
            colorId: resultColorId ?? srcRoll.colorId,
            rollNo: generatedRollNo,
            dyeBatch: srcRoll.dyeBatch,
            initialKg: String(input.receivedKg),
            remainingKg: String(input.receivedKg),
            pricePerKg: String(srcPrice + printCost),
            salePricePerKg: salePrice != null ? String(salePrice) : null,
            currency,
            supplierId: srcRoll.supplierId ?? null,
            entryDate: effectiveDate,
            widthCm: srcRoll.widthCm ? String(srcRoll.widthCm) : null,
            weightGsm: srcRoll.weightGsm ? String(srcRoll.weightGsm) : null,
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
              description: `Print receive ${job.number} (new roll ${generatedRollNo})`,
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
                description: `Print waste ${job.number} (${wasteKg} kg)`,
              },
              ctx,
            );
          }
        }

      // Phase 2.3 — auto-create a printing-cost expense (no party) + its ledger
      // row atomically, when a print cost per kg is known. This makes the
      // printing cost flow into the ledger/cashbox automatically.
      const effectiveDate2 = input.date ?? job.date ?? new Date().toISOString().slice(0, 10);
      let costExpenseId: string | null = null;
      const costPerKg = input.printCostPerKg ?? Number(job.printCostPerKg ?? 0);
      const receivedKgNum = input.receivedKg ?? 0;
      if (costPerKg > 0 && receivedKgNum > 0) {
        const printCostTotal = Math.round(receivedKgNum * costPerKg);
        if (printCostTotal > 0) {
          const [expRow] = await tx
            .insert(expenses)
            .values({
              tenantId: ctx.tenantId,
              number: `EXP-${job.number}`,
              category: "طباعة",
              description: `تكلفة طباعة ${job.number} (${receivedKgNum} كغ × ${costPerKg})`,
              amount: printCostTotal,
              currency: input.currency ?? (job.currency ?? "SYP"),
              date: effectiveDate2,
              method: "cash",
              paidFromCashbox: true,
              createdBy: ctx.userId,
            })
            .returning();
          costExpenseId = expRow.id;
          const isCash = true;
          // C4 fix: double-entry — expense leg + balancing cash leg.
          await tx.insert(ledgerEntries).values([
            {
              tenantId: ctx.tenantId,
              partyId: null,
              date: effectiveDate2,
              type: "expense",
              debit: printCostTotal,
              credit: 0,
              currency: input.currency ?? (job.currency ?? "SYP"),
              cashImpact: "none",
              referenceType: "expense",
              referenceId: expRow.id,
              referenceNumber: `EXP-${job.number}`,
              description: `Expense EXP-${job.number}: طباعة - تكلفة طباعة ${job.number}`,
              createdBy: ctx.userId,
            },
            {
              tenantId: ctx.tenantId,
              partyId: null,
              date: effectiveDate2,
              type: "cash",
              debit: 0,
              credit: printCostTotal,
              currency: input.currency ?? (job.currency ?? "SYP"),
              cashImpact: isCash ? "out" : "none",
              referenceType: "expense",
              referenceId: expRow.id,
              referenceNumber: `EXP-${job.number}`,
              description: `Cash paid EXP-${job.number}`,
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
      pressName: n(row.pressName),
      printCostPerKg: num(row.printCostPerKg),
      currency: row.currency,
      newName: n(row.newName),
      newCategory: n(row.newCategory),
      newColorName: n(row.newColorName),
      newColorCode: n(row.newColorCode),
      newSalePricePerKg: num(row.newSalePricePerKg),
      receivedKg: num(row.receivedKg),
      wasteKg:
        row.receivedKg != null ? Math.max(0, Number(row.quantityKg) - Number(row.receivedKg)) : undefined,
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