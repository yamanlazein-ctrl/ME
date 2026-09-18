import { test, expect } from "@playwright/test";
import { createRequire } from "module";

/**
 * ============================================================================
 *  licensing-lock-in.spec.ts
 * ============================================================================
 *  حارس دائم ضد رجوع أي كسر في «قفل الترخيص» (Phase أ/ب/ج).
 *  تاريخ الإنشاء: 2026-08-28.
 *
 *  يقفل السلوكيات التالية (أي تغيير مستقبلي يكسرها = رجوع يجب إصلاحه فوراً):
 *    1) تفعيل الأدمن للترخيص يسجّل جهاز الخادم (جهاز #1).
 *    2) حد الأجهزة مفروض عند التفعيل: جهاز إضافي بعد اكتمال الحصة → 409.
 *    3) مسار أعمال محمي يعيد 200 والترخيص نشط.
 *    4) دعوة مستخدم: generate → validate → consume تنشئ المستخدم وتسجّل
 *       جهازه (استهلاك جهاز عند القبول) — جهاز #2.
 *    5) الموظف الجديد يسجّل الدخول ببريده وكلمة مروره (الدور صحيح).
 *    6) حد الأجهزة مفروض عند قبول الدعوة: جهاز موظفٍ ثانٍ بعد الحصة → 400.
 *    7) الحارس: ترخيص ملغي (revoked) → 403 على مسار محمي.
 *    8) الحارس: منتهٍ واستُنفدت السماح → 403؛ منتهٍ وداخل السماح → 200
 *       + ترويسة X-License-Grace (فترة السماح للقراءة فقط).
 *
 *  ⚠️⚠️⚠️  لا تحذف هذا الاختبار (DO NOT DELETE THIS TEST)  ⚠️⚠️⚠️
 *
 *  حتمية البيانات (Determinism): يعيد هذا الحارس ضبط جداول الترخيص فقط
 *  (device_registrations / invitation_codes / مستخدمو الاختبار licguard-%)
 *  وحالة صف الترخيص قبل كل تشغيل وبعده. لا يمس أي بيانات أعمال أو محاسبة.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const { Pool } = require("../../backend/node_modules/pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL is required"); })(),
});

const BACKEND = process.env.ERP_BACKEND_URL ?? "http://127.0.0.1:8080";
const TENANT_ID = process.env.ERP_TENANT_ID;
const EMAIL = process.env.ERP_ADMIN_EMAIL;
const PASSWORD = process.env.ERP_ADMIN_PASSWORD;
if (!TENANT_ID || !EMAIL || !PASSWORD) throw new Error("ERP_TENANT_ID, ERP_ADMIN_EMAIL, and ERP_ADMIN_PASSWORD are required");

const DEVICE_CAP = 2; // حصة الأجهزة التي يفرضها الاختبار
const EMP_EMAIL = "licguard-emp@erp.local";
const EMP_PASSWORD = "LicGuard@2026!";

const state = {
  token: "",
  licenseKey: "",
  licenseId: "",
  invitationCode: "",
  createdUserId: "",
};

// ── helpers ────────────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, json };
}

async function login(): Promise<string> {
  const r = await api("POST", "/api/auth/login", {
    email: EMAIL,
    password: PASSWORD,
    tenantId: TENANT_ID,
  });
  expect(r.status, "admin login").toBe(200);
  expect(r.json.accessToken, "accessToken present").toBeTruthy();
  return r.json.accessToken as string;
}

async function setLicenseActive(): Promise<void> {
  const limits = {
    users: 20,
    devices: DEVICE_CAP,
    branches: 2,
    warehouses: 3,
    storage_gb: 10,
    api_calls: 100000,
  };
  await pool.query(
    `UPDATE licenses SET status='active', expires_at=NULL, grace_days=7,
       limits=$1::jsonb,
       features=ARRAY['feature.inventory','feature.sales','feature.purchasing','feature.reports','feature.accounting']::text[]`,
    [JSON.stringify(limits)],
  );
}

async function countLiveDevices(): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int n FROM device_registrations WHERE tenant_id=$1 AND revoked_at IS NULL`,
    [TENANT_ID],
  );
  return r.rows[0].n;
}

async function countAllDevices(): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int n FROM device_registrations WHERE tenant_id=$1`,
    [TENANT_ID],
  );
  return r.rows[0].n;
}

// ── Setup / Teardown ───────────────────────────────────────────────────────
test.beforeAll(async () => {
  console.log("[setup] ضبط حالة الترخيص وتنظيف جداول الترخيص فقط");
  state.token = await login();
  const lic = await pool.query(`SELECT id, key FROM licenses LIMIT 1`);
  expect(lic.rowCount, "a license exists").toBeGreaterThan(0);
  state.licenseId = lic.rows[0].id;
  state.licenseKey = lic.rows[0].key;
  await setLicenseActive();
  // Licensing-table determinism (never touches business/accounting data):
  await pool.query(`DELETE FROM device_registrations WHERE tenant_id=$1`, [TENANT_ID]);
  await pool.query(`DELETE FROM invitation_codes WHERE tenant_id=$1`, [TENANT_ID]);
  await pool.query(`DELETE FROM users WHERE tenant_id=$1 AND email LIKE 'licguard-%'`, [TENANT_ID]);
  await pool.query(`UPDATE license_activations SET deactivated_at=NOW() WHERE deactivated_at IS NULL`);
  console.log(`[setup] license=${state.licenseKey} cap=${DEVICE_CAP}`);
});

test.afterAll(async () => {
  console.log("[teardown] إعادة الترخيص إلى نشط");
  await setLicenseActive();
  await pool.end();
});

test.describe.configure({ mode: "serial" });

test("T1 — تفعيل الأدمن يسجّل جهاز الخادم (جهاز #1)", async () => {
  const before = await countLiveDevices();
  const r = await api(
    "POST",
    "/api/license/activate",
    { key: state.licenseKey, hostname: "LICGUARD-SERVER", appVersion: "1.0.0", platform: "windows" },
    state.token,
  );
  console.log(`   activate -> ${r.status} | devices ${before} -> ${await countLiveDevices()}`);
  expect(r.status, "activation succeeds").toBe(200);
  expect(await countLiveDevices(), "server device registered").toBe(before + 1);
});

test("T2 — حد الأجهزة عند التفعيل: جهاز إضافي بعد الحصة → 409", async () => {
  // Remove the server device so the next activation is a genuinely NEW device.
  await pool.query(
    `DELETE FROM device_registrations WHERE tenant_id=$1 AND name='LICGUARD-SERVER'`,
    [TENANT_ID],
  );
  // Fill to the cap with fake devices (none of them is the server fingerprint).
  while ((await countLiveDevices()) < DEVICE_CAP) {
    await pool.query(
      `INSERT INTO device_registrations (license_id, tenant_id, device_id, device_fingerprint, device_fingerprint_version, platform, name)
       VALUES ($1,$2,gen_random_uuid(),$3,1,'windows',$4)`,
      [state.licenseId, TENANT_ID, `LICGUARD-FAKE-${Date.now()}-${Math.random()}`, "LICGUARD-FAKE"],
    );
  }
  expect(await countLiveDevices(), "at cap before attempt").toBe(DEVICE_CAP);
  // Activate → the server is a brand-new device beyond the cap → must be refused.
  const r = await api(
    "POST",
    "/api/license/activate",
    { key: state.licenseKey, hostname: "LICGUARD-OVER-LIMIT", appVersion: "1.0.0", platform: "windows" },
    state.token,
  );
  console.log(`   activate(over cap) -> ${r.status} | ${r.json.message ?? ""}`);
  expect(r.status, "device beyond cap refused").toBe(409);
  // Restore: clear fake devices and re-register the server device for later steps.
  await pool.query(`DELETE FROM device_registrations WHERE tenant_id=$1 AND name='LICGUARD-FAKE'`, [TENANT_ID]);
  const re = await api(
    "POST",
    "/api/license/activate",
    { key: state.licenseKey, hostname: "LICGUARD-SERVER", appVersion: "1.0.0", platform: "windows" },
    state.token,
  );
  expect(re.status, "server re-activation after cleanup").toBe(200);
});

test("T3 — مسار محمي يعيد 200 والترخيص نشط", async () => {
  const r = await api("GET", "/api/customers", undefined, state.token);
  console.log(`   GET /api/customers -> ${r.status}`);
  expect(r.status, "protected route 200 under active license").toBe(200);
});

test("T4 — دعوة مستخدم: generate → validate → consume (ينشئ مستخدماً + جهاز #2)", async () => {
  const g = await api(
    "POST",
    "/api/invitations/generate",
    { type: "user", ttlMinutes: 60, targetName: "حارس الترخيص", targetEmail: EMP_EMAIL, targetRole: "accountant" },
    state.token,
  );
  expect(g.status, "generate invitation").toBe(200);
  state.invitationCode = g.json.code;
  console.log(`   generate -> ${g.status} | code=${state.invitationCode}`);

  const v = await api("POST", "/api/invitations/validate", { code: state.invitationCode });
  expect(v.status, "validate invitation").toBe(200);
  expect(v.json.valid, "code valid").toBe(true);

  const devicesBefore = await countAllDevices();
  const c = await api("POST", "/api/invitations/consume", {
    code: state.invitationCode,
    password: EMP_PASSWORD,
    deviceFingerprint: "LICGUARD-EMP-FP",
  });
  console.log(`   consume -> ${c.status} | devices ${devicesBefore} -> ${await countAllDevices()}`);
  expect(c.status, "consume invitation").toBe(200);
  expect(c.json.createdUserId, "user created").toBeTruthy();
  expect(c.json.registeredDeviceId, "device consumed on accept").toBeTruthy();
  state.createdUserId = c.json.createdUserId;
  expect(await countAllDevices(), "device count grew").toBe(devicesBefore + 1);
});

test("T5 — الموظف الجديد يسجّل الدخول (الدور accountant)", async () => {
  const r = await api("POST", "/api/auth/login", {
    email: EMP_EMAIL,
    password: EMP_PASSWORD,
    tenantId: TENANT_ID,
  });
  console.log(`   login(${EMP_EMAIL}) -> ${r.status} | role=${r.json.user?.role}`);
  expect(r.status, "employee login").toBe(200);
  expect(r.json.user?.role, "role is accountant").toBe("accountant");
});

test("T6 — حد الأجهزة عند قبول الدعوة: جهاز موظفٍ ثانٍ → 400", async () => {
  const g = await api(
    "POST",
    "/api/invitations/generate",
    { type: "user", ttlMinutes: 60, targetName: "موظف إضافي", targetEmail: "licguard-emp2@erp.local", targetRole: "warehouse" },
    state.token,
  );
  expect(g.status).toBe(200);
  const c = await api("POST", "/api/invitations/consume", {
    code: g.json.code,
    password: "AnotherPass@2026!",
    deviceFingerprint: "LICGUARD-EMP2-FP",
  });
  console.log(`   consume(2nd employee device) -> ${c.status} | ${c.json.message ?? ""}`);
  expect(c.status, "2nd employee device refused at cap").toBe(400);
});

test("T7 — الحارس: ترخيص ملغي (revoked) → 403", async () => {
  await pool.query(`UPDATE licenses SET status='revoked'`);
  const r = await api("GET", "/api/customers", undefined, state.token);
  console.log(`   revoked -> GET /api/customers ${r.status} | ${r.json.code ?? ""}`);
  expect(r.status, "revoked license blocks").toBe(403);
});

test("T8 — الحارس: منتهٍ+استُنفدت السماح → 403؛ منتهٍ+داخل السماح → 200 + X-License-Grace", async () => {
  // Expired long ago, grace exhausted.
  await pool.query(`UPDATE licenses SET status='expired', expires_at=NOW() - INTERVAL '60 days', grace_days=7`);
  let r = await api("GET", "/api/customers", undefined, state.token);
  console.log(`   expired(no grace) -> ${r.status}`);
  expect(r.status, "expired with exhausted grace blocks").toBe(403);

  // Expired yesterday, still within 7-day grace.
  await pool.query(`UPDATE licenses SET status='expired', expires_at=NOW() - INTERVAL '1 day', grace_days=7`);
  r = await api("GET", "/api/customers", undefined, state.token);
  const grace = r.headers.get("x-license-grace");
  console.log(`   expired(within grace) -> ${r.status} | X-License-Grace=${grace}`);
  expect(r.status, "expired within grace allows").toBe(200);
  expect(grace, "grace header present").toBeTruthy();

  await setLicenseActive();
});
