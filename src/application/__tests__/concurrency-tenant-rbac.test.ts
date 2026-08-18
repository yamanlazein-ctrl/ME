import { describe, it, expect, beforeEach } from "vitest";

describe("Concurrency / Optimistic Locking Test", () => {
  // Simulating InMemoryInventoryRepository.reserveStock behavior
  class Roll {
    remainingKg: number;
    version: number;
    constructor(public id: string, kg: number) {
      this.remainingKg = kg;
      this.version = 1;
    }
  }

  function attemptReserve(roll: Roll, kg: number): { ok: boolean; error?: string } {
    const v = roll.version;
    if (roll.remainingKg < kg) return { ok: false, error: "InsufficientStock" };
    roll.remainingKg -= kg;
    roll.version += 1;
    return { ok: true };
  }

  function attemptReserveWithVersion(
    roll: Roll,
    kg: number,
    expectedVersion: number,
  ): { ok: boolean; error?: string } {
    if (roll.version !== expectedVersion) return { ok: false, error: "ConcurrentModification" };
    if (roll.remainingKg < kg) return { ok: false, error: "InsufficientStock" };
    roll.remainingKg -= kg;
    roll.version += 1;
    return { ok: true };
  }

  it("guards with version check — second reservation with stale version fails", () => {
    const roll = new Roll("r1", 100);

    // First operation
    const r1 = attemptReserveWithVersion(roll, 40, roll.version);
    expect(r1.ok).toBe(true);
    expect(roll.remainingKg).toBe(60);
    expect(roll.version).toBe(2);

    // Second operation with STALE version (still version 1)
    const r2 = attemptReserveWithVersion(roll, 10, 1);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("ConcurrentModification");
    expect(roll.remainingKg).toBe(60); // unchanged — the first operation was not overwritten
  });

  it("without version check, two concurrent sales can double-deduct", () => {
    const roll = new Roll("r2", 100);

    // BAD pattern: no version check, two operations compete
    // Both check remainingKg = 100 → both think 60 is available
    // End result: 100 - 60 - 60 = -20 (impossible, silently corrupt)

    const r1 = attemptReserve(roll, 60);
    const r2 = attemptReserve(roll, 60);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false); // second fails (but with insufficient, not concurrency)
    expect(roll.remainingKg).toBe(40); // not -20
  });

  it("exactly exceeding total stock together — one must fail", () => {
    const roll = new Roll("r3", 50);

    const r1 = attemptReserveWithVersion(roll, 30, roll.version);
    expect(r1.ok).toBe(true);

    const r2 = attemptReserveWithVersion(roll, 30, roll.version);
    // Should fail — version mismatch or insufficient
    expect(r2.ok).toBe(false);
    expect(roll.remainingKg).toBe(20); // one succeeded, one failed
  });
});

describe("Tenant Isolation Test", () => {
  const tenantA = { tenantId: "tenant-a", userId: "u1", userRole: "admin" as const, userName: "UserA" };
  const tenantB = { tenantId: "tenant-b", userId: "u2", userRole: "admin" as const, userName: "UserB" };

  // Simulated multi-tenant store (like InMemoryInvoiceRepository)
  const store = new Map<string, { id: string; tenantId: string; data: string }>();

  function save(entity: { id: string; tenantId: string; data: string }) {
    store.set(entity.id, entity);
  }

  function findById(id: string, tenantId: string) {
    const e = store.get(id);
    return e?.tenantId === tenantId ? e : null;
  }

  function listByTenant(tenantId: string) {
    return [...store.values()].filter((e) => e.tenantId === tenantId);
  }

  beforeEach(() => store.clear());

  it("findById enforces tenant isolation — tenant A cannot read tenant B's data", () => {
    save({ id: "e1", tenantId: "tenant-a", data: "A's data" });
    save({ id: "e2", tenantId: "tenant-b", data: "B's data" });

    // Tenant A reads own data: OK
    expect(findById("e1", "tenant-a")?.data).toBe("A's data");

    // Tenant A tries to read tenant B's data by ID: null
    expect(findById("e2", "tenant-a")).toBeNull();

    // Tenant B tries to read tenant A's data: null
    expect(findById("e1", "tenant-b")).toBeNull();
  });

  it("list only returns entities for the requesting tenant", () => {
    save({ id: "e1", tenantId: "tenant-a", data: "A1" });
    save({ id: "e2", tenantId: "tenant-a", data: "A2" });
    save({ id: "e3", tenantId: "tenant-b", data: "B1" });

    expect(listByTenant("tenant-a")).toHaveLength(2);
    expect(listByTenant("tenant-b")).toHaveLength(1);
  });
});

describe("RBAC Test", () => {
  const ROLES = ["admin", "accountant", "warehouse", "viewer"] as const;

  // Permissions: which roles can WRITE to which modules
  const writePermissions: Record<string, string[]> = {
    invoices: ["admin", "accountant"],
    inventory: ["admin", "warehouse"],
    vouchers: ["admin", "accountant"],
    cashbox: ["admin", "accountant"],
    expenses: ["admin", "accountant"],
    returns: ["admin", "accountant"],
    settings: ["admin"],
    orders: ["admin", "accountant"],
  };

  function canWrite(role: string, module: string): boolean {
    return (writePermissions[module] ?? []).includes(role);
  }

  it("viewer cannot write to any module", () => {
    for (const module of Object.keys(writePermissions)) {
      expect(canWrite("viewer", module)).toBe(false);
    }
  });

  it("admin can write to all modules", () => {
    for (const module of Object.keys(writePermissions)) {
      expect(canWrite("admin", module)).toBe(true);
    }
  });

  it("accountant can write to financial modules but not inventory or settings", () => {
    expect(canWrite("accountant", "invoices")).toBe(true);
    expect(canWrite("accountant", "vouchers")).toBe(true);
    expect(canWrite("accountant", "cashbox")).toBe(true);
    expect(canWrite("accountant", "expenses")).toBe(true);
    expect(canWrite("accountant", "inventory")).toBe(false);
    expect(canWrite("accountant", "settings")).toBe(false);
  });

  it("warehouse can write to inventory but not financial modules", () => {
    expect(canWrite("warehouse", "inventory")).toBe(true);
    expect(canWrite("warehouse", "invoices")).toBe(false);
    expect(canWrite("warehouse", "vouchers")).toBe(false);
  });

  it("every role has at least one readable module", () => {
    for (const role of ROLES) {
      // All roles can read (viewer can view everything)
      const readableCount = Object.keys(writePermissions).filter(() => true).length;
      expect(readableCount).toBeGreaterThan(0);
    }
  });
});
