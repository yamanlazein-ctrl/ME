/**
 * Audit Script: فحص جميع الفواتير والمخزون وكشف الحساب
 * 
 * التشغيل: cd backend && npx tsx ../scripts/audit-invoices.ts
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

// تحميل الإعدادات
dotenv.config({ path: join(process.cwd(), '.env') });

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/erp';

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  console.log('='.repeat(80));
  console.log('📊 تقرير التدقيق الشامل - Motard Fabrics Group ERP');
  console.log('='.repeat(80));
  console.log();

  // 1. جلب جميع الفواتير
  console.log('🔍 1. فحص الفواتير...');
  const { rows: invoices } = await pool.query(`
    SELECT 
      i.id, i.number, i.type, i.date, i.currency,
      i.subtotal, i.discount, i.tax, i.shipping, i.total,
      i.paid, i.amount_due, i.status,
      p.name as party_name,
      COUNT(il.id) as line_count,
      SUM(il.quantity_kg) as total_kg,
      SUM(il.quantity_kg * il.price_per_kg - il.discount_amount) as lines_total
    FROM invoices i
    LEFT JOIN invoice_lines il ON il.invoice_id = i.id
    LEFT JOIN parties p ON p.id = i.party_id
    GROUP BY i.id, p.name
    ORDER BY i.date DESC
  `);

  console.log(`   إجمالي الفواتير: ${invoices.length}`);
  console.log();

  let errors: any[] = [];
  let correct = 0;

  for (const inv of invoices) {
    const expectedTotal = Number(inv.lines_total) - inv.discount + inv.tax + inv.shipping;
    const totalDiff = Math.abs(inv.total - expectedTotal);
    const expectedRemaining = Math.max(0, inv.total - (inv.paid || 0));
    const remainingDiff = Math.abs(inv.amount_due - expectedRemaining);

    const hasError = totalDiff > 0.01 || remainingDiff > 0.01;

    if (hasError) {
      errors.push({
        number: inv.number,
        type: inv.type,
        date: inv.date,
        party: inv.party_name,
        totalExpected: expectedTotal.toFixed(2),
        totalActual: inv.total.toFixed(2),
        paid: inv.paid || 0,
        remainingExpected: expectedRemaining.toFixed(2),
        remainingActual: inv.amount_due?.toFixed(2) || '0.00',
      });
    } else {
      correct++;
    }
  }

  console.log(`   ✅ فواتير صحيحة: ${correct}`);
  console.log(`   ❌ فواتير بأخطاء: ${errors.length}`);
  console.log();

  if (errors.length > 0) {
    console.log('   ⚠️  الفواتير الخاطئة:');
    for (const e of errors.slice(0, 10)) {
      console.log(`   - ${e.number} (${e.type}) | ${e.party}`);
      console.log(`     الإجمالي: المتوقع=${e.totalExpected} الفعلي=${e.totalActual}`);
      console.log(`     المتبقي: المتوقع=${e.remainingExpected} الفعلي=${e.remainingActual}`);
    }
    if (errors.length > 10) {
      console.log(`   ... و ${errors.length - 10} أخرى`);
    }
    console.log();
  }

  // 2. فحص كشف حساب الموردين
  console.log('🔍 2. فحص كشف حساب الموردين...');
  const { rows: suppliers } = await pool.query(`
    SELECT 
      p.id, p.name, p.kind,
      COALESCE(SUM(CASE WHEN le.type = 'purchase_invoice' THEN le.debit ELSE 0 END), 0) as total_invoices,
      COALESCE(SUM(CASE WHEN le.type = 'payment_out' THEN le.credit ELSE 0 END), 0) as total_payments,
      COALESCE(SUM(CASE WHEN le.type = 'purchase_invoice' THEN le.debit ELSE 0 END), 0) - 
      COALESCE(SUM(CASE WHEN le.type = 'payment_out' THEN le.credit ELSE 0 END), 0) as balance
    FROM parties p
    LEFT JOIN ledger_entries le ON le.party_id = p.id AND le.status = 'active'
    WHERE p.kind = 'supplier'
    GROUP BY p.id, p.name, p.kind
    ORDER BY balance DESC
  `);

  console.log(`   إجمالي الموردين: ${suppliers.length}`);
  console.log();

  for (const s of suppliers.slice(0, 5)) {
    console.log(`   📦 ${s.name}`);
    console.log(`      إجمالي الفواتير: ${Number(s.total_invoices).toFixed(2)}`);
    console.log(`      إجمالي المدفوع: ${Number(s.total_payments).toFixed(2)}`);
    console.log(`      الرصيد: ${Number(s.balance).toFixed(2)}`);
    console.log();
  }

  // 3. فحص كشف حساب العملاء
  console.log('🔍 3. فحص كشف حساب العملاء...');
  const { rows: customers } = await pool.query(`
    SELECT 
      p.id, p.name, p.kind,
      COALESCE(SUM(CASE WHEN le.type = 'sales_invoice' THEN le.debit ELSE 0 END), 0) as total_invoices,
      COALESCE(SUM(CASE WHEN le.type = 'receipt_in' THEN le.credit ELSE 0 END), 0) as total_payments,
      COALESCE(SUM(CASE WHEN le.type = 'sales_invoice' THEN le.debit ELSE 0 END), 0) - 
      COALESCE(SUM(CASE WHEN le.type = 'receipt_in' THEN le.credit ELSE 0 END), 0) as balance
    FROM parties p
    LEFT JOIN ledger_entries le ON le.party_id = p.id AND le.status = 'active'
    WHERE p.kind = 'customer'
    GROUP BY p.id, p.name, p.kind
    ORDER BY balance DESC
  `);

  console.log(`   إجمالي العملاء: ${customers.length}`);
  console.log();

  for (const c of customers.slice(0, 5)) {
    console.log(`   👤 ${c.name}`);
    console.log(`      إجمالي الفواتير: ${Number(c.total_invoices).toFixed(2)}`);
    console.log(`      إجمالي المدفوع: ${Number(c.total_payments).toFixed(2)}`);
    console.log(`      الرصيد: ${Number(c.balance).toFixed(2)}`);
    console.log();
  }

  // 4. فحص المخزون
  console.log('🔍 4. فحص المخزون...');
  const { rows: stock } = await pool.query(`
    SELECT 
      f.name as fabric_name,
      c.name as color_name,
      c.code as color_code,
      r.roll_no,
      r.total_kg,
      r.remaining_kg,
      r.status
    FROM rolls r
    LEFT JOIN colors c ON c.id = r.color_id
    LEFT JOIN fabrics f ON f.id = c.fabric_id
    WHERE r.status = 'active'
    ORDER BY r.remaining_kg DESC
    LIMIT 10
  `);

  console.log(`   إجمالي الأصبغة النشطة: ${stock.length}`);
  console.log();

  for (const s of stock) {
    console.log(`   🧵 ${s.fabric_name} | ${s.color_name} (${s.color_code}) | صبغة ${s.roll_no}`);
    console.log(`      الكمية الأصلية: ${Number(s.total_kg).toFixed(2)} كغ`);
    console.log(`      المتبقي: ${Number(s.remaining_kg).toFixed(2)} كغ`);
    console.log();
  }

  // 5. ملخص Ledger
  console.log('🔍 5. ملخص دفتر الأستاذ (Ledger)...');
  const { rows: ledgerSummary } = await pool.query(`
    SELECT 
      type,
      COUNT(*) as count,
      SUM(debit) as total_debit,
      SUM(credit) as total_credit,
      SUM(debit - credit) as net
    FROM ledger_entries
    WHERE status = 'active'
    GROUP BY type
    ORDER BY count DESC
  `);

  for (const l of ledgerSummary) {
    console.log(`   ${l.type}: ${l.count} قيد | مدين=${Number(l.total_debit).toFixed(2)} | دائن=${Number(l.total_credit).toFixed(2)} | صافي=${Number(l.net).toFixed(2)}`);
  }

  console.log();
  console.log('='.repeat(80));
  console.log('📋 الخلاصة');
  console.log('='.repeat(80));
  console.log(`✅ فواتير صحيحة: ${correct}`);
  console.log(`❌ فواتير بأخطاء: ${errors.length}`);
  console.log(`📦 موردون: ${suppliers.length}`);
  console.log(`👤 عملاء: ${customers.length}`);
  console.log(`🧵 أصبغة نشطة: ${stock.length}`);
  console.log();

  await pool.end();
}

main().catch(console.error);
