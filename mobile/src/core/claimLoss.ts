// Claim loss (FR-34, E1): two devices sold the same roll offline and the hub took the other one first. The shared sync code
// already cancels the phone's invoice locally; here the owner is told which invoice and which roll.
import type { Phone } from "./phone";
import type { RejectedDocument } from "./syncQueries";

export const CLAIM_LOSS_TITLE = "تعذّر اعتماد الفاتورة";

export function claimLossMessage(invoiceNumber: string, rollNos: string[]): string {
  const rolls = rollNos.length > 0 ? rollNos.join("، ") : "—";
  return `الفاتورة ${invoiceNumber} لم تُعتمد لأن الرول ${rolls} بِيع من جهاز آخر قبلها. أُلغيت الفاتورة على هذا الهاتف. يجب الحل من الديسكتوب.`;
}

/** Alert texts for the invoices among `rejected` (other entity types are announced by the notification only). */
export async function claimLossAlerts(
  phone: Phone,
  rejected: RejectedDocument[],
): Promise<Array<{ title: string; message: string }>> {
  const out: Array<{ title: string; message: string }> = [];
  for (const r of rejected) {
    if (r.entityType !== "invoice" || !r.number) continue;
    // One lookup per roll: `searchRepo.rollsByIds` deliberately fails on the desktop twin (owner decision O-1).
    const rolls: Array<{ rollNo: string }> = [];
    for (const id of r.rollIds) {
      const roll = await phone.repos.rollRepo.findById(id, phone.context());
      if (roll) rolls.push({ rollNo: roll.rollNo });
    }
    out.push({
      title: CLAIM_LOSS_TITLE,
      message: claimLossMessage(
        r.number,
        rolls.map((x) => x.rollNo),
      ),
    });
  }
  return out;
}
