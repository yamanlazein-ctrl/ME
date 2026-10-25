// Spike S2 (research R3): the shared use-cases run on this JavaScript engine and write the same rows as on Node. Deterministic
// by construction: ids come from the seeded UUID sequence (nodeCrypto.setUuidSequenceForSpike), numbers are pre-allocated and
// every document date is 2026-01-15. The same routine runs under Node (scripts/s2-reference.mjs → evidence/s2-reference.db)
// and on the phone (Spikes → S2); `scripts/compare-db.mjs` must print `0 differences`.
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import type { TenantContext } from "@backend/domain/types/index";
import { setUuidSequenceForSpike } from "../platform/nodeCrypto";
import type { ShimDatabase } from "../platform/sqlite/types";
import type { PhoneRepositories } from "./container";
import { createDocuments } from "./documents";

export const S2_DATE = "2026-01-15";
export const S2_TENANT_ID = "5a5a5a5a-0000-4000-8000-000000000001";
export const S2_USER_ID = "5a5a5a5a-0000-4000-8000-000000000002";
export const S2_DEVICE_ID = "5a5a5a5a-0000-4000-8000-000000000003";

export interface S2Result {
  receiptNumber: string;
  invoiceNumber: string;
  invoiceTotal: number;
  customerId: string;
}

function must<T>(r: { ok: true; data: T } | { ok: false; error: string }, label: string): T {
  if (!r.ok) throw new Error(`S2 ${label}: ${r.error}`);
  return r.data;
}

/** conn: a freshly migrated database (openRuntime already ran on it). */
export async function runS2(conn: ShimDatabase, repos: PhoneRepositories): Promise<S2Result> {
  setUuidSequenceForSpike("s2");
  conn.exec("PRAGMA foreign_keys = OFF");
  conn
    .prepare(
      "INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES (?, 'S2', 's2', 'active', 'no_license', 'trial')",
    )
    .run(S2_TENANT_ID);
  conn
    .prepare(
      "INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'S2 Admin', 's2@device.local', 'x', 'admin', 1)",
    )
    .run(S2_USER_ID, S2_TENANT_ID);
  conn.exec("PRAGMA foreign_keys = ON");
  await repos.syncDeviceRepo.registerOrTouch({
    tenantId: S2_TENANT_ID as never,
    userId: S2_USER_ID as never,
    deviceFingerprint: "s2-device",
    deviceFingerprintVersion: 1,
    platform: "android",
    hostname: "s2",
    label: "s2",
    deviceId: S2_DEVICE_ID as never,
  });
  const ctx: TenantContext = {
    tenantId: S2_TENANT_ID,
    userId: S2_USER_ID,
    userRole: "admin",
    userName: "S2 Admin",
    syncDeviceId: S2_DEVICE_ID,
  };
  const documents = createDocuments({ repos, context: () => ctx });

  const customer = await withTenantTx(S2_TENANT_ID, async () => {
    const party = must(
      await createPartyUseCase(
        repos.partyRepo,
        { kind: "customer", code: "CUS-2026-0001", name: "S2 Customer", currency: "SYP" },
        ctx,
      ),
      "party",
    );
    return party;
  });
  const fabric = must(
    await createFabricUseCase(repos.fabricRepo, { name: "S2 Fabric", minStockKg: 0 }, ctx),
    "fabric",
  );
  const color = must(
    await createColorUseCase(repos.colorRepo, { fabricId: fabric.id, name: "S2 Color" }, ctx),
    "color",
  );
  const roll = must(
    await createRollUseCase(
      repos.rollRepo,
      {
        colorId: color.id,
        rollNo: "S2-R1",
        initialKg: 1000,
        pieces: 50,
        pricePerKg: 2,
        currency: "USD",
        entryDate: S2_DATE,
      },
      ctx,
    ),
    "roll",
  );

  // One receipt of 500 USD at the rate 14500 SYP per USD.
  const receipt = must(
    await documents.createVoucher(
      "receipt",
      {
        date: S2_DATE,
        partyId: customer.id,
        partyKind: "customer",
        amount: 500,
        currency: "USD",
        exchangeRate: 14500,
        method: "cash",
        preAllocatedNumber: "VOC-2026-0001",
        preAllocatedId: "5a5a5a5a-0000-4000-8000-0000000000a1",
      },
      { opId: "5a5a5a5a-0000-4000-8000-0000000000b1" },
    ),
    "receipt",
  );

  // One 3-line sale in SYP.
  const line = (kg: number, price: number) => ({
    fabricId: fabric.id,
    colorId: color.id,
    rollId: roll.id,
    quantityKg: kg,
    pieces: 1,
    pricePerKg: price,
  });
  const sale = must(
    await documents.createInvoice(
      {
        type: "sale",
        date: S2_DATE,
        partyId: customer.id,
        partyType: "customer",
        currency: "SYP",
        exchangeRate: 14500,
        lines: [line(10, 61625), line(7.5, 61625), line(2.25, 72500)],
        paid: 100000,
        preAllocatedNumber: "INV-2026-0001",
        preAllocatedId: "5a5a5a5a-0000-4000-8000-0000000000a2",
      },
      { opId: "5a5a5a5a-0000-4000-8000-0000000000b2" },
    ),
    "sale",
  );
  return {
    receiptNumber: receipt.number,
    invoiceNumber: sale.number,
    invoiceTotal: sale.total,
    customerId: customer.id,
  };
}
