// شغّله مرة واحدة فقط بعد تشغيل الهجرات: node bootstrap-hub.mjs
// يطبع بيانات الدخول في النهاية — احفظها فوراً.
import { randomUUID } from "node:crypto";
import pg from "pg";
import argon2 from "@node-rs/argon2";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("اضبط DATABASE_URL أولاً");

const COMPANY_NAME = process.argv[2] || "شركتي";
const ADMIN_EMAIL = process.argv[3] || "admin@hub.local";
const ADMIN_PASSWORD = process.argv[4];
if (!ADMIN_PASSWORD) throw new Error("الاستخدام: node bootstrap-hub.mjs \"اسم الشركة\" admin@example.com كلمة_مرور_قوية");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const tenantId = randomUUID();
const userId = randomUUID();
const licenseId = randomUUID();
const slug = `tenant-${tenantId.slice(0, 8)}`;

const passwordHash = await argon2.hash(ADMIN_PASSWORD, {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  algorithm: 2,
});

// كل الإدخالات في معاملة واحدة: إن فشل أي استعلام لا يبقى tenant يتيم.
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // الجداول ذات tenant_id عليها FORCE RLS (حتى على المالك) — سياق platform للمعاملة فقط.
  // users من الفئة 1 (tenant_isolation) — لا تكفيها platform_mode، تحتاج current_tenant_id.
  await client.query(
    `SELECT set_config('app.platform_mode', 'on', true), set_config('app.current_tenant_id', $1, true)`,
    [tenantId],
  );

  await client.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`,
    [tenantId, COMPANY_NAME, slug],
  );

  await client.query(
    `INSERT INTO licenses (id, key, type, status, expires_at, grace_days, max_devices, features, customer_name, edition, plan, license_version, product_version, license_model, binding_type, tenant_id, limits)
     VALUES ($1, $2, 'full', 'active', NULL, 7, 10,
       ARRAY['feature.inventory','feature.sales','feature.purchasing','feature.accounting','feature.reports']::text[],
       $3, 'enterprise', 'standard', 'v1', '1.0.0', 'perpetual', 'none', $4,
       '{"users":50,"devices":10,"branches":5,"api_calls":1000000,"storage_gb":50,"warehouses":10}'::jsonb)`,
    [licenseId, `LIC-HUB-${randomUUID().slice(0, 8).toUpperCase()}`, COMPANY_NAME, tenantId],
  );

  await client.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active, is_license_owner)
     VALUES ($1, $2, 'مدير', $3, $4, 'admin', true, true)`,
    [userId, tenantId, ADMIN_EMAIL, passwordHash],
  );

  // بدون هذا الصف يرفض install gate كل الطلبات بـ "يرجى إكمال معالج الإعداد".
  await client.query(
    `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
     VALUES ($1, 'done', ARRAY['welcome','activate','company','localization','admin','review']::text[], true, now())`,
    [tenantId],
  );

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}

console.log("تم بنجاح. احفظ هذه القيم:");
console.log("tenantId:", tenantId);
console.log("email:", ADMIN_EMAIL);
console.log("password:", "(كما أدخلته)");
await pool.end();
