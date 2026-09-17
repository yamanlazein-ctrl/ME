import { BusinessRuleError } from "../errors/index.js";

/**
 * F05 (Phase 1 foundation audit): "inventory cost differs between invoice
 * and GL/report". Root cause — `rolls.pricePerKg` is this roll's cost
 * basis: COGS is frozen from it at the moment of sale
 * (resolveSaleCostPerKg / saleCogsConversion.ts) and never revalued
 * afterward, exactly like an invoice's historical FX rate is frozen once
 * posted. But `pricePerKg` itself stayed freely editable via
 * PUT /inventory/rolls/:id with zero propagation to already-posted
 * ledger/COGS entries — so the LIVE inventory report (which prices
 * remaining stock at the CURRENT pricePerKg) could silently drift from
 * what the GL and already-issued invoices actually recorded, for any roll
 * that had already been partially sold before its price was edited.
 *
 * Once any stock has left a roll, its price has already been used to post
 * real COGS/GL entries — editing the price further is blocked, mirroring
 * the existing remainingKg-edit guard (BUG-05) in the same repository: the
 * historical value is frozen, and the correct fix is a new roll, not a
 * silent revaluation of one that's already partially sold.
 */
export function assertRollPriceEditAllowed(params: {
  rollNo: string;
  initialKg: number;
  remainingKg: number;
  currentPricePerKg: number;
  newPricePerKg: number;
}): void {
  const { rollNo, initialKg, remainingKg, currentPricePerKg, newPricePerKg } = params;
  const hasSoldStock = remainingKg < initialKg;
  const priceActuallyChanges =
    Math.round(currentPricePerKg * 100) !== Math.round(newPricePerKg * 100);
  if (hasSoldStock && priceActuallyChanges) {
    throw new BusinessRuleError(
      `لا يمكن تعديل سعر تكلفة اللفافة ${rollNo} بعد بيع جزء من مخزونها — التكلفة التاريخية مجمّدة في الفواتير والدفاتر المحاسبية بالفعل. أنشئ لفافة جديدة بالسعر الصحيح بدلاً من ذلك.`,
    );
  }
}
