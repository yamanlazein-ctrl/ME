/**
 * BC-1 (specs/002-mobile-app, FR-35): a phone reserves 100 invoice numbers and 50 of every other type;
 * its early refill triggers at 25% of ITS block (25 invoices left); a desktop is unchanged (500 / 200).
 * A fake hub records the `size` each claim asks for; the blocks it hands out are mirrored locally by the
 * real ensureDeviceNumberBlocks code path. Runs on both engines.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import {
  runWithPlatformContext,
  runWithTenantContext,
} from "@/infrastructure/orm/tenant-context.js";

const dir = mkdtempSync(join(tmpdir(), "motard-blocksize-"));
process.env.HUB_CONFIG_PATH = join(dir, "hub.json");
process.env.HUB_SESSION_PATH = join(dir, "hub-session.json");
delete process.env.CENTRAL_SYNC_URL;

const tenantId = randomUUID();
const userId = randomUUID();
const phoneDevice = randomUUID();
const desktopDevice = randomUUID();
const year = new Date().getFullYear();
const claims: Array<{ entityType: string; size: number }> = [];
let nextStart = 1;
let server: http.Server;

let ensure: typeof import("@/application/use-cases/sync/numberBlockUseCases.js").ensureDeviceNumberBlocks;
let blocks: import("@/application/ports/IDocumentNumberBlockRepository.js").IDocumentNumberBlockRepository;
let fingerprints: import("@/application/ports/IMachineFingerprintProvider.js").IMachineFingerprintProvider;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      if ((req.url ?? "").startsWith("/api/sync/number-blocks/claim")) {
        claims.push({ entityType: body.entityType, size: body.size });
        const startNumber = nextStart;
        nextStart += body.size;
        return res.end(
          JSON.stringify({
            entityType: body.entityType,
            year,
            prefix: body.entityType.toUpperCase(),
            startNumber,
            endNumber: startNumber + body.size - 1,
          }),
        );
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(process.env.HUB_CONFIG_PATH!, JSON.stringify({ url: hubUrl }));
  writeFileSync(
    process.env.HUB_SESSION_PATH!,
    JSON.stringify({
      accessToken: "hub-token-xyz",
      hubUrl,
      hubDeviceId: randomUUID(),
      localTenantId: tenantId,
      localUserId: userId,
    }),
  );

  await runWithPlatformContext(async () => {
    await db.execute(sql`
      insert into tenants (id, name, slug, status, license_status, license_type)
      values (${tenantId}, 'Phone Block Tenant', ${`pb-${tenantId.slice(0, 8)}`},
              'active', 'no_license', 'trial')
    `);
    await db.execute(sql`
      insert into users (id, tenant_id, name, email, password_hash, role)
      values (${userId}, ${tenantId}, 'مدير', ${`pb-${tenantId.slice(0, 8)}@test.local`}, 'x', 'admin')
    `);
  });
  const { buildContainer } = await import("@/infrastructure/di/container.js");
  const container = buildContainer();
  blocks = container.documentNumberBlockRepo;
  fingerprints = container.fingerprintProvider;
  ensure = (await import("@/application/use-cases/sync/numberBlockUseCases.js"))
    .ensureDeviceNumberBlocks;
  for (const [id, platform] of [
    [phoneDevice, "android"],
    [desktopDevice, "windows"],
  ] as const) {
    await runWithTenantContext({ tenantId, userId, userRole: "admin", userName: "مدير" }, () =>
      container.syncDeviceRepo.registerOrTouch({
        tenantId: tenantId as never,
        userId: userId as never,
        deviceFingerprint: `fp-${id}`,
        deviceFingerprintVersion: 1,
        platform,
        hostname: platform,
        label: platform,
        deviceId: id as never,
      }),
    );
  }
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const ensureFor = (syncDeviceId: string, entityTypes: string[], deviceKind?: "desktop" | "phone") =>
  runWithTenantContext({ tenantId, userId, userRole: "admin", userName: "مدير" }, () =>
    ensure(blocks, fingerprints, {
      tenantId: tenantId as never,
      syncDeviceId: syncDeviceId as never,
      userId: userId as never,
      authHeader: "Bearer local",
      entityTypes,
      ...(deviceKind ? { deviceKind } : {}),
    }),
  );

const sizeOf = (r: Awaited<ReturnType<typeof ensureFor>>, entityType: string) => {
  const b = r.ensured.find((e) => e.entityType === entityType);
  return b ? b.endNumber - b.startNumber + 1 : -1;
};

/** Leaves `remaining` unused numbers in the device's active block of this type. */
const leaveRemaining = (deviceId: string, entityType: string, remaining: number) =>
  runWithPlatformContext(() =>
    db.execute(sql`
      update document_number_blocks set next_number = end_number - ${remaining} + 1
       where tenant_id = ${tenantId} and sync_device_id = ${deviceId}
         and entity_type = ${entityType} and year = ${year} and status = 'active'
    `),
  );

describe("phone number-block sizes (BC-1)", () => {
  it("a phone block is 100 invoices and 50 vouchers; the hub is asked for exactly that", async () => {
    const r = await ensureFor(phoneDevice, ["invoice", "voucher"], "phone");
    expect(r.ensured.map((e) => e.source)).toEqual(["hub", "hub"]);
    expect(sizeOf(r, "invoice")).toBe(100);
    expect(sizeOf(r, "voucher")).toBe(50);
    expect(claims.filter((c) => c.size === 100).map((c) => c.entityType)).toEqual(["invoice"]);
    expect(claims.filter((c) => c.size === 50).map((c) => c.entityType)).toEqual(["voucher"]);
  });

  it("the phone refill triggers when 24 invoices remain and not when 25 remain", async () => {
    const before = claims.length;
    await leaveRemaining(phoneDevice, "invoice", 25);
    const keep = await ensureFor(phoneDevice, ["invoice"], "phone");
    expect(keep.ensured[0]?.source).toBe("existing");
    expect(claims.length).toBe(before);

    await leaveRemaining(phoneDevice, "invoice", 24);
    const refill = await ensureFor(phoneDevice, ["invoice"], "phone");
    expect(refill.ensured[0]?.source).toBe("hub");
    expect(sizeOf(refill, "invoice")).toBe(100);
    expect(claims.length).toBe(before + 1);
  });

  it("every other phone entity type is 50", async () => {
    const r = await ensureFor(phoneDevice, ["customer", "return", "expense"], "phone");
    expect(["customer", "return", "expense"].map((t) => sizeOf(r, t))).toEqual([50, 50, 50]);
  });

  it("a desktop is unchanged: invoice 500, voucher 200 (with and without deviceKind)", async () => {
    const r = await ensureFor(desktopDevice, ["invoice", "voucher"]);
    expect(sizeOf(r, "invoice")).toBe(500);
    expect(sizeOf(r, "voucher")).toBe(200);
    const explicit = await ensureFor(desktopDevice, ["invoice", "voucher"], "desktop");
    expect(explicit.ensured.map((e) => e.source)).toEqual(["existing", "existing"]);
  });

  it("the desktop refill threshold stays at 125 of 500", async () => {
    const before = claims.length;
    await leaveRemaining(desktopDevice, "invoice", 125);
    expect((await ensureFor(desktopDevice, ["invoice"])).ensured[0]?.source).toBe("existing");
    await leaveRemaining(desktopDevice, "invoice", 124);
    const refill = await ensureFor(desktopDevice, ["invoice"]);
    expect(refill.ensured[0]?.source).toBe("hub");
    expect(sizeOf(refill, "invoice")).toBe(500);
    expect(claims.length).toBe(before + 1);
  });
});
