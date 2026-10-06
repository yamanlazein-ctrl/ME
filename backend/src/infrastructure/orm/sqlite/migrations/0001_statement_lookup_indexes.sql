-- T112 (specs/001-desktop-sqlite-engine, AC-9 / SC-008): indexes only, no behavior change.
--
-- The full single-party statement at the gate volume (40,020 lines, 81 pages) missed the 10 s target
-- (12.5–22.6 s). Per page the statement loads its documents by id list. Without planner statistics,
-- SQLite answered `id IN (…) AND tenant_id = ?` by scanning every invoice of the tenant through
-- idx_invoices_type (61 ms per page), and the line-detail join `invoice_lines.invoice_id IN (…)`
-- fell back to a full scan of invoice_lines (no index starts with invoice_id; the existing one is
-- (tenant_id, invoice_id) and the query filters the tenant on the joined invoices row).
--
-- (tenant_id, id) lets one index satisfy both predicates of the document lookups; (invoice_id) lets
-- the line-detail join seek by document.
CREATE INDEX "idx_invoices_tenant_id_id" ON "invoices" ("tenant_id", "id");
CREATE INDEX "idx_vouchers_tenant_id_id" ON "vouchers" ("tenant_id", "id");
CREATE INDEX "idx_invoice_lines_invoice_id" ON "invoice_lines" ("invoice_id");
