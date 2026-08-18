import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, inArray } from "drizzle-orm";
import { colors } from "../src/infrastructure/orm/schemas/color.table.js";
import { fabrics } from "../src/infrastructure/orm/schemas/fabric.table.js";
import { rolls } from "../src/infrastructure/orm/schemas/roll.table.js";

const FABRIC_IDS = [
  "f466515a-33de-44ca-8a15-b4e69e165ba5", // قطن مصري
  "99531b81-dc9f-4c10-8eb5-6d0749beab6c", // بوليستر
  "f7ca991f-92f7-4fc1-9f21-07a4d4b4b30c", // بوليستر مطاطي
  "b44c4378-bd44-4fe1-8a52-64853505699a", // جينز خام
  "da46f49d-7d9c-4535-822e-b25b64acdf37", // تريكو قطني
  "418f0659-7bc8-4d1e-866e-70d57db82d56", // تريكو بوليستر
  "f39e6169-6894-4da1-baf1-6f198d52bf10", // كتان طبيعي
];

async function main() {
  console.log("=== Colors by Fabric ===");
  for (const fid of FABRIC_IDS) {
    const fab = await db.select().from(fabrics).where(eq(fabrics.id, fid)).limit(1);
    const fabName = fab[0]?.name ?? "???";
    console.log(`\nFabric: ${fabName} (${fid})`);
    const cols = await db.select().from(colors).where(eq(colors.fabricId, fid));
    for (const c of cols) {
      console.log(`  - ${c.name} (id=${c.id}, code=${c.code ?? "null"})`);
    }
    if (cols.length === 0) console.log("  (no colors found)");
  }

  console.log("\n=== Rolls for needed fabrics ===");
  const allColors = await db.select().from(colors).where(inArray(colors.fabricId, FABRIC_IDS));
  const colorIds = allColors.map((c) => c.id);
  const rollRows = await db.select().from(rolls).where(inArray(rolls.colorId, colorIds));
  for (const r of rollRows) {
    const c = allColors.find((x) => x.id === r.colorId);
    console.log(`  roll_no=${r.rollNo}, fabric=${c?.name ?? "?"}, color=${c?.name ?? "?"}, remaining=${r.remainingKg}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
