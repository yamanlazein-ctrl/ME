/**
 * Insert 10 new entry invoices (V06-V15) with multi-currency support.
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { PostgresInvoiceRepository } from "../src/infrastructure/repositories/PostgresInvoiceRepository.js";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "../src/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "../src/infrastructure/orm/schemas/color.table.js";
import { rolls } from "../src/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import type { TenantContext } from "../src/domain/types/index.js";

const TENANT_ID = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const ctx: TenantContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  userRole: "admin",
  userName: "system",
};

const repo = new PostgresInvoiceRepository(db);

async function getOrCreateParty(name: string, kind: "customer" | "supplier", currency: string) {
  const existing = await db
    .select()
    .from(parties)
    .where(and(eq(parties.name, name), eq(parties.tenantId, TENANT_ID)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(parties)
    .values({
      tenantId: TENANT_ID,
      kind,
      name,
      currency,
      status: "active",
    })
    .returning();
  console.log(`  Created party: ${name} (${row.id})`);
  return row.id;
}

async function getOrCreateFabric(name: string) {
  const existing = await db
    .select()
    .from(fabrics)
    .where(and(eq(fabrics.name, name), eq(fabrics.tenantId, TENANT_ID)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(fabrics)
    .values({
      tenantId: TENANT_ID,
      name,
    })
    .returning();
  console.log(`  Created fabric: ${name} (${row.id})`);
  return row.id;
}

async function getOrCreateColor(fabricId: string, name: string, code?: string) {
  const existing = await db
    .select()
    .from(colors)
    .where(
      and(eq(colors.fabricId, fabricId), eq(colors.name, name), eq(colors.tenantId, TENANT_ID)),
    )
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(colors)
    .values({
      tenantId: TENANT_ID,
      fabricId,
      name,
      code: code ?? null,
    })
    .returning();
  console.log(`  Created color: ${name} (${row.id})`);
  return row.id;
}

async function getOrCreateRoll(
  colorId: string,
  rollNo: string,
  pricePerKg: number,
  currency: string,
  supplierId: string,
) {
  const existing = await db
    .select()
    .from(rolls)
    .where(and(eq(rolls.rollNo, rollNo), eq(rolls.tenantId, TENANT_ID)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(rolls)
    .values({
      tenantId: TENANT_ID,
      colorId,
      rollNo,
      initialKg: "0",
      remainingKg: "0",
      pricePerKg: String(pricePerKg),
      currency,
      supplierId,
      entryDate: "2026-08-18",
    })
    .returning();
  console.log(`  Created roll: ${rollNo} (${row.id})`);
  return row.id;
}

async function nextInvoiceNumber(): Promise<string> {
  const result = await db.execute(sql`
    UPDATE document_sequences 
    SET last_number = last_number + 1 
    WHERE tenant_id = ${TENANT_ID} AND entity_type = 'invoice' AND prefix IS NULL
    RETURNING prefix, last_number;
  `);
  const rows = (result as unknown as { rows: { prefix: string | null; last_number: number }[] })
    .rows;
  if (rows.length === 0) {
    // insert if not exists
    await db.execute(sql`
      INSERT INTO document_sequences (tenant_id, entity_type, last_number)
      VALUES (${TENANT_ID}, 'invoice', 1)
      ON CONFLICT DO NOTHING;
    `);
    const r2 = await db.execute(sql`
      UPDATE document_sequences 
      SET last_number = last_number + 1 
      WHERE tenant_id = ${TENANT_ID} AND entity_type = 'invoice' AND prefix IS NULL
      RETURNING prefix, last_number;
    `);
    const rows2 = (r2 as unknown as { rows: { prefix: string | null; last_number: number }[] })
      .rows;
    const num = rows2[0]!.last_number;
    return `INV-2026-${String(num).padStart(4, "0")}`;
  }
  const num = rows[0].last_number;
  return `INV-2026-${String(num).padStart(4, "0")}`;
}

interface LineDef {
  fabricName: string;
  colorName: string;
  colorCode?: string;
  rollNo: string;
  quantityKg: number;
  pricePerKg: number;
  discountAmount: number;
}

interface InvDef {
  ref: string;
  date: string;
  partyName: string;
  currency: "SYP" | "USD" | "EUR";
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  lines: LineDef[];
  discount: number;
  tax: number;
  shipping: number;
  paid: number;
}

const DEFINITIONS: InvDef[] = [
  {
    ref: "ENT-2026-8V06",
    date: "2026-08-18",
    partyName: "شركة الحرير الدمشقي",
    currency: "USD",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "قطن عضوي",
        colorName: "طبيعي",
        rollNo: "V06-R01",
        quantityKg: 100,
        pricePerKg: 5.0,
        discountAmount: 20,
      },
    ],
    discount: 10,
    tax: 15,
    shipping: 5,
    paid: 200,
  },
  {
    ref: "ENT-2026-8V07",
    date: "2026-08-18",
    partyName: "مصانع الشهباء للنسيج",
    currency: "SYP",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "شامواه",
        colorName: "أحمر",
        colorCode: "SH-001",
        rollNo: "V07-R01",
        quantityKg: 75,
        pricePerKg: 25000,
        discountAmount: 150000,
      },
    ],
    discount: 50000,
    tax: 100000,
    shipping: 75000,
    paid: 0,
  },
  {
    ref: "ENT-2026-8V08",
    date: "2026-08-19",
    partyName: "شركة الصوف الإيطالية",
    currency: "EUR",
    paymentMethod: "check",
    lines: [
      {
        fabricName: "صوف ميرينو",
        colorName: "أبيض",
        rollNo: "V08-R01",
        quantityKg: 50,
        pricePerKg: 12.0,
        discountAmount: 30,
      },
    ],
    discount: 20,
    tax: 25,
    shipping: 15,
    paid: 150,
  },
  {
    ref: "ENT-2026-8V09",
    date: "2026-08-19",
    partyName: "مجموعة النيل للأقمشة",
    currency: "USD",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "كتان فرنسي",
        colorName: "بيج",
        rollNo: "V09-R01",
        quantityKg: 120,
        pricePerKg: 8.5,
        discountAmount: 50,
      },
    ],
    discount: 30,
    tax: 40,
    shipping: 20,
    paid: 500,
  },
  {
    ref: "ENT-2026-8V10",
    date: "2026-08-19",
    partyName: "شركة تدمر للقطن",
    currency: "SYP",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "جينز ثقيل",
        colorName: "نيلي غامق",
        rollNo: "V10-R01",
        quantityKg: 200,
        pricePerKg: 18000,
        discountAmount: 200000,
      },
    ],
    discount: 100000,
    tax: 250000,
    shipping: 150000,
    paid: 1000000,
  },
  {
    ref: "ENT-2026-8V11",
    date: "2026-08-20",
    partyName: "مصنع البرتغال للنسيج",
    currency: "EUR",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "بوليستر تقني",
        colorName: "رمادي",
        rollNo: "V11-R01",
        quantityKg: 80,
        pricePerKg: 6.5,
        discountAmount: 40,
      },
    ],
    discount: 15,
    tax: 20,
    shipping: 10,
    paid: 250,
  },
  {
    ref: "ENT-2026-8V12",
    date: "2026-08-20",
    partyName: "شركة الخليج للتريكو",
    currency: "USD",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "تريكو قطني",
        colorName: "أبيض",
        rollNo: "V12-R01",
        quantityKg: 60,
        pricePerKg: 7.0,
        discountAmount: 25,
      },
      {
        fabricName: "تريكو بوليستر",
        colorName: "أسود",
        rollNo: "V12-R02",
        quantityKg: 40,
        pricePerKg: 4.5,
        discountAmount: 15,
      },
    ],
    discount: 20,
    tax: 30,
    shipping: 10,
    paid: 0,
  },
  {
    ref: "ENT-2026-8V13",
    date: "2026-08-20",
    partyName: "مؤسسة الفرات للأقمشة",
    currency: "SYP",
    paymentMethod: "check",
    lines: [
      {
        fabricName: "مخمل",
        colorName: "أخضر",
        rollNo: "V13-R01",
        quantityKg: 150,
        pricePerKg: 32000,
        discountAmount: 300000,
      },
    ],
    discount: 150000,
    tax: 400000,
    shipping: 200000,
    paid: 1500000,
  },
  {
    ref: "ENT-2026-8V14",
    date: "2026-08-21",
    partyName: "شركة هولندا للكتان",
    currency: "EUR",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "كتان ناعم",
        colorName: "كريمي",
        rollNo: "V14-R01",
        quantityKg: 70,
        pricePerKg: 9.0,
        discountAmount: 50,
      },
      {
        fabricName: "كتان خشن",
        colorName: "بني",
        rollNo: "V14-R02",
        quantityKg: 90,
        pricePerKg: 7.0,
        discountAmount: 40,
      },
    ],
    discount: 30,
    tax: 45,
    shipping: 25,
    paid: 400,
  },
  {
    ref: "ENT-2026-8V15",
    date: "2026-08-21",
    partyName: "شركة اليابان للحرير",
    currency: "USD",
    paymentMethod: "cash",
    lines: [
      {
        fabricName: "حرير طبيعي",
        colorName: "أبيض لؤلؤي",
        rollNo: "V15-R01",
        quantityKg: 30,
        pricePerKg: 15.0,
        discountAmount: 100,
      },
    ],
    discount: 10,
    tax: 20,
    shipping: 5,
    paid: 200,
  },
];

async function main() {
  for (const def of DEFINITIONS) {
    console.log(`\n========== ${def.ref} ==========`);

    // 1. Create party
    const partyId = await getOrCreateParty(def.partyName, "supplier", def.currency);

    // 2. Create fabrics, colors, rolls
    const lines = [];
    for (const l of def.lines) {
      const fabricId = await getOrCreateFabric(l.fabricName);
      const colorId = await getOrCreateColor(fabricId, l.colorName, l.colorCode);
      const rollId = await getOrCreateRoll(colorId, l.rollNo, l.pricePerKg, def.currency, partyId);
      lines.push({
        fabricId,
        colorId,
        rollId,
        quantityKg: l.quantityKg,
        pricePerKg: l.pricePerKg,
        discountAmount: l.discountAmount,
        pieces: 1,
      });
    }

    // 3. Generate invoice number
    const invNumber = await nextInvoiceNumber();
    console.log(`  Invoice number: ${invNumber}`);

    // 4. Create invoice
    const createInput = {
      type: "entry" as const,
      date: def.date,
      partyId,
      partyType: "supplier" as const,
      currency: def.currency,
      lines,
      discount: def.discount,
      tax: def.tax,
      shipping: def.shipping,
      notes: `الرقم المرجعي: ${def.ref}`,
      paid: def.paid,
      paymentMethod: def.paid > 0 ? def.paymentMethod : undefined,
    };

    const invoice = await repo.create(createInput, invNumber, ctx);
    console.log(`  Created: ${invoice.number}`);
    console.log(
      `    subtotal=${invoice.subtotal}, total=${invoice.total}, paid=${invoice.paid}, due=${invoice.amountDue}`,
    );
  }

  console.log("\n\n========== ALL DONE ==========");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
