-- Cashbox daily-balance functions: drop `SET row_security = off`.
--
-- The 20260928 migration assumed `row_security = off` BYPASSES row-level
-- security inside these SECURITY DEFINER trigger functions. It does not: for a
-- role that is neither superuser nor BYPASSRLS (the database owner on Neon /
-- any managed Postgres), it makes every RLS-affected statement FAIL with
--   "query would be affected by row-level security policy for table
--    cashbox_daily_balances".
-- Every cash-moving ledger row (paid sale, receipt, payment, expense, manual
-- movement) therefore failed on the central hub, so those documents never
-- synced. The desktop runs as superuser, which is why it never showed there.
--
-- Without the override the normal tenant policy applies. It always matches:
-- the triggering INSERT/UPDATE on ledger_entries / manual_movements is itself
-- subject to the same `app.current_tenant_id` policy, so the session tenant is
-- the row's tenant whenever these functions run.
ALTER FUNCTION cashbox_daily_apply_delta(uuid, text, date, numeric) RESET row_security;
--> statement-breakpoint
ALTER FUNCTION cashbox_daily_shift_all(uuid, text, numeric) RESET row_security;
--> statement-breakpoint
ALTER FUNCTION trg_cashbox_daily_from_ledger() RESET row_security;
--> statement-breakpoint
ALTER FUNCTION trg_cashbox_daily_from_manual() RESET row_security;
