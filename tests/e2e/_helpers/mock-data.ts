/**
 * Seed data generators for certification tests.
 *
 * These create test data via the backend API so dynamic routes
 * like /invoices/$id, /orders/$id, /customers/$id, /suppliers/$id
 * always have valid IDs to test against.
 */

import type { APIRequestContext } from "@playwright/test";

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";
const ADMIN = { username: "admin", password: "admin" };

let _cachedToken: string | null = null;

/** Obtain an admin JWT token (cached per process). */
export async function getAdminToken(request: APIRequestContext): Promise<string> {
  if (_cachedToken) return _cachedToken;
  const ctx = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  }).then((r) => r.json());
  _cachedToken = ctx.accessToken ?? ctx.token ?? "";
  return _cachedToken;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function seq() {
  return Math.floor(Math.random() * 1_000_000);
}

/** Create a supplier via API and return its id. */
export async function createSupplier(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const token = await getAdminToken(request);
  const body = {
    name: `مورد-اختبار-${seq()}`,
    phone: "0999-000000",
    currency: "SYP",
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/suppliers`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string, name: body.name as string };
}

/** Create a customer via API and return its id. */
export async function createCustomer(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const token = await getAdminToken(request);
  const body = {
    name: `عميل-اختبار-${seq()}`,
    phone: "0999-111111",
    currency: "SYP",
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/customers`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string, name: body.name as string };
}

/** Create a fabric via API and return its id. */
export async function createFabric(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const token = await getAdminToken(request);
  const body = {
    name: `قماش-اختبار-${seq()}`,
    minStockKg: 10,
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/inventory/fabrics`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string, name: body.name as string };
}

/** Create a color via API and return its id. */
export async function createColor(
  request: APIRequestContext,
  fabricId: string,
): Promise<{ id: string }> {
  const token = await getAdminToken(request);
  const body = { fabricId, name: `لون-اختبار-${seq()}`, code: `C-${seq()}` };
  const res = await fetch(`${BACKEND}/inventory/colors`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string };
}

/** Create a roll via API and return its id. */
export async function createRoll(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string }> {
  const token = await getAdminToken(request);
  const body = {
    colorId: "col-1",
    rollNo: `R-${seq()}`,
    dyeBatch: `D-${seq()}`,
    initialKg: 100,
    remainingKg: 100,
    pricePerKg: 12000,
    currency: "SYP",
    supplierId: "sup-1",
    entryDate: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/inventory/rolls`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string };
}

/** Create an invoice (entry or sale) via API and return its id. */
export async function createInvoice(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string }> {
  const token = await getAdminToken(request);
  const body = {
    type: "sale",
    date: new Date().toISOString().slice(0, 10),
    partyId: "cus-1",
    partyType: "customer",
    currency: "SYP",
    lines: [
      {
        fabricId: "fab-1",
        colorId: "col-1",
        rollId: "rol-1",
        quantityKg: 1,
        pricePerKg: 12000,
        discountAmount: 0,
      },
    ],
    paid: 0,
    notes: "فاتورة اختبار",
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/invoices`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string };
}

/** Create an order via API and return its id. */
export async function createOrder(
  request: APIRequestContext,
  overrides?: Record<string, unknown>,
): Promise<{ id: string }> {
  const token = await getAdminToken(request);
  const body = {
    partyId: "cus-1",
    currency: "SYP",
    lines: [
      {
        fabricId: "fab-1",
        colorId: "col-1",
        quantityKg: 5,
        pricePerKg: 12000,
      },
    ],
    ...overrides,
  };
  const res = await fetch(`${BACKEND}/orders`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then((r) => r.json());
  return { id: res.id as string };
}
