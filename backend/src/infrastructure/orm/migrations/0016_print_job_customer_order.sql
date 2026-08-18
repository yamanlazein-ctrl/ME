-- 0016_print_job_customer_order.sql
-- Phase 2.2/2.3: link print jobs to a customer (party) + originating order so
-- printing becomes a trackable financial event; and record the printing cost.

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES parties(id);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);
-- Charge to the customer for the printing service (SYP per kg). When present
-- together with customer_id, a printing_charge ledger entry is written at send.
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS charge_per_kg DECIMAL(12,2);
-- Reference to the auto-created expense row for the printing cost (Phase 2.3).
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS cost_expense_id UUID REFERENCES expenses(id);

CREATE INDEX IF NOT EXISTS idx_print_jobs_customer ON print_jobs (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs (tenant_id, order_id);
