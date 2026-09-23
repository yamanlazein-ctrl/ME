// يضبط كلمة مرور مدير المركز صراحةً (argon2id بنفس إعدادات السيرفر) ويشخّص أسباب رفض الدخول.
// الاستخدام:
//   DATABASE_URL=... BOOTSTRAP_TENANT_ID=... node reset-hub-admin.mjs admin@example.com Pass123456
// إن لم يُضبط BOOTSTRAP_TENANT_ID يُستخدم tenant الوحيد المكتمل الإعداد (نفس منطق السيرفر).
import { randomUUID } from "node:crypto";
import pg from "pg";
import argon2 from "@node-rs/argon2";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("اضبط DATABASE_URL أولاً");
const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];
if (!EMAIL || !PASSWORD) throw new Error("الاستخدام: node reset-hub-admin.mjs admin@example.com Pass123456");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(`SELECT set_config('app.platform_mode', 'on', true)`);

  // ── نفس ترتيب السيرفر: BOOTSTRAP_TENANT_ID ثم tenant الوحيد المكتمل ──
  const completed = (
    await client.query(`SELECT tenant_id FROM setup_wizard_state WHERE is_completed = true`)
  ).rows.map((r) => r.tenant_id);
  console.log("setup_wizard_state المكتملة:", completed.length ? completed : "(لا يوجد!)");

  let tenantId = process.env.BOOTSTRAP_TENANT_ID?.trim() || null;
  if (!tenantId) {
    if (completed.length !== 1) {
      throw new Error(`لا يمكن تحديد الشركة: ${completed.length} شركة مكتملة. اضبط BOOTSTRAP_TENANT_ID.`);
    }
    tenantId = completed[0];
  }
  console.log("tenantId المستخدم:", tenantId);

  const tenant = (await client.query(`SELECT id, name, slug FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  if (!tenant) throw new Error(`الشركة ${tenantId} غير موجودة في tenants — BOOTSTRAP_TENANT_ID خاطئ`);
  console.log("الشركة:", tenant.name, `(${tenant.slug})`);

  if (!completed.includes(tenantId)) {
    console.warn("⚠ هذه الشركة ليس لها setup_wizard_state مكتمل — سيرد السيرفر بـ SETUP_REQUIRED. سأضيفه.");
    await client.query(
      `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
       VALUES ($1, 'done', ARRAY['welcome','activate','company','localization','admin','review']::text[], true, now())
       ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done', completed_at = now()`,
      [tenantId],
    );
  }

  const lic = (
    await client.query(
      `SELECT key, status FROM licenses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  console.log("الترخيص:", lic ? `${lic.key} (${lic.status})` : "⚠ لا يوجد ترخيص لهذه الشركة");

  // users عليه سياسة tenant_isolation: لا يُرى إلا بـ current_tenant_id.
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

  const all = (await client.query(`SELECT id, email, role, active FROM users WHERE tenant_id = $1`, [tenantId])).rows;
  console.log("مستخدمو هذه الشركة:", all.length ? all.map((u) => `${u.email} [${u.role}${u.active ? "" : ", معطّل"}]`) : "(لا أحد)");

  const passwordHash = await argon2.hash(PASSWORD, {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    algorithm: 2, // Argon2id — مطابق لـ src/infrastructure/auth/PasswordHasher.ts
  });

  // السيرفر يطابق email حرفياً (case-sensitive)، لذا نوحّد القيمة المخزنة على ما ستكتبه في الشاشة.
  const updated = await client.query(
    `UPDATE users SET email = $2, password_hash = $3, active = true, updated_at = now()
     WHERE tenant_id = $1 AND lower(email) = lower($2) RETURNING id`,
    [tenantId, EMAIL, passwordHash],
  );
  if (updated.rowCount > 0) {
    console.log("✔ حُدّثت كلمة مرور المستخدم الموجود:", updated.rows[0].id);
  } else {
    const id = randomUUID();
    await client.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active, is_license_owner)
       VALUES ($1, $2, 'مدير', $3, $4, 'admin', true, true)`,
      [id, tenantId, EMAIL, passwordHash],
    );
    console.log("✔ لم يكن المستخدم موجوداً في هذه الشركة — أُنشئ:", id);
  }

  // تحقق فعلي بنفس دالة السيرفر قبل الحفظ.
  const stored = (
    await client.query(`SELECT password_hash FROM users WHERE tenant_id = $1 AND email = $2`, [tenantId, EMAIL])
  ).rows[0];
  if (!stored || !(await argon2.verify(stored.password_hash, PASSWORD))) {
    throw new Error("فشل التحقق من الهاش بعد الكتابة — أُلغيت العملية");
  }

  await client.query("COMMIT");
  console.log(`\nتم. ادخل بـ ${EMAIL} وكلمة المرور التي أدخلتها.`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("✖", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
