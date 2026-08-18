import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, inArray, and } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "../src/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "../src/infrastructure/orm/schemas/color.table.js";
import { rolls } from "../src/infrastructure/orm/schemas/roll.table.js";

const INV_NUMBERS = ["INV-2026-0007","INV-2026-0008","INV-2026-0009","INV-2026-0010","INV-2026-0011"];

async function main() {
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) {
      console.log(`\n=== ${num}: NOT FOUND ===`);
      continue;
    }
    const inv = invRows[0];
    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    console.log(`\n=== ${num} ===`);
    console.log(`  date=${inv.date}, party=${party[0]?.name ?? inv.partyId}`);
    console.log(`  subtotal=${inv.subtotal}, discount=${inv.discount}, tax=${inv.tax}, shipping=${inv.shipping}`);
    console.log(`  total=${inv.total}, paid=${inv.paid}, paymentMethod=${inv.paymentMethod ?? "null"}`);
    console.log(`  notes=${inv.notes ?? "null"}`);

    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    for (const l of lines) {
      const fab = await db.select().from(fabrics).where(eq(fabrics.id, l.fabricId)).limit(1);
      const col = await db.select().from(colors).where(eq(colors.id, l.colorId)).limit(1);
      const rol = await db.select().from(rolls).where(eq(rolls.id, l.rollId)).limit(1);
      const lineTotal = Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0));
      console.log(`  Line: fabric=${fab[0]?.name ?? "?"}, color=${col[0]?.name ?? "?"}, roll=${rol[0]?.rollNo ?? "?"}`);
      console.log(`        qty=${l.quantityKg}, price=${l.pricePerKg}, pieces=${l.pieces}, discountAmount=${l.discountAmount}`);
      console.log(`        lineTotal=${lineTotal}, note=${l.note ?? "null"}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
