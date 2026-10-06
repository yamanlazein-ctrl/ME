-- FUNCTION cashbox_daily_apply_delta
CREATE OR REPLACE FUNCTION public.cashbox_daily_apply_delta(p_tenant uuid, p_currency text, p_date date, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev numeric;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;

  SELECT c.closing_balance INTO v_prev
  FROM cashbox_daily_balances c
  WHERE c.tenant_id = p_tenant
    AND c.currency = p_currency
    AND c.balance_date < p_date
  ORDER BY c.balance_date DESC
  LIMIT 1;

  IF v_prev IS NULL THEN
    SELECT COALESCE(s.opening_balance, 0) INTO v_prev
    FROM cashbox_sessions s
    WHERE s.tenant_id = p_tenant
      AND s.currency = p_currency
    LIMIT 1;
    v_prev := COALESCE(v_prev, 0);
  END IF;

  INSERT INTO cashbox_daily_balances (tenant_id, currency, balance_date, closing_balance, updated_at)
  VALUES (p_tenant, p_currency, p_date, v_prev + p_delta, now())
  ON CONFLICT (tenant_id, currency, balance_date)
  DO UPDATE SET
    closing_balance = cashbox_daily_balances.closing_balance + p_delta,
    updated_at = now();

  UPDATE cashbox_daily_balances
  SET closing_balance = closing_balance + p_delta,
      updated_at = now()
  WHERE tenant_id = p_tenant
    AND currency = p_currency
    AND balance_date > p_date;
END;
$function$


-- FUNCTION cashbox_daily_shift_all
CREATE OR REPLACE FUNCTION public.cashbox_daily_shift_all(p_tenant uuid, p_currency text, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;
  UPDATE cashbox_daily_balances
  SET closing_balance = closing_balance + p_delta,
      updated_at = now()
  WHERE tenant_id = p_tenant
    AND currency = p_currency;
END;
$function$


-- FUNCTION fn_ledger_entries_append_only
CREATE OR REPLACE FUNCTION public.fn_ledger_entries_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Controlled party remap for merge (amounts/date/type/status stay immutable).
    IF current_setting('app.allow_party_remap', true) = '1'
       AND NEW.debit = OLD.debit
       AND NEW.credit = OLD.credit
       AND NEW.currency = OLD.currency
       AND NEW.date = OLD.date
       AND NEW.type = OLD.type
       AND NEW.status = OLD.status
       AND NEW.reference_id IS NOT DISTINCT FROM OLD.reference_id
       AND NEW.reference_type IS NOT DISTINCT FROM OLD.reference_type THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'ledger_entries: cannot modify already-cancelled rows'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'ledger_entries: UPDATE only allowed for cancellation (status→cancelled)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.debit <> OLD.debit OR NEW.credit <> OLD.credit
       OR NEW.currency <> OLD.currency OR NEW.party_id <> OLD.party_id
       OR NEW.date <> OLD.date OR NEW.type <> OLD.type
       OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
       OR NEW.reference_type IS DISTINCT FROM OLD.reference_type THEN
      RAISE EXCEPTION 'ledger_entries: financial columns are immutable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$


-- FUNCTION fn_license_audit_events_append_only
CREATE OR REPLACE FUNCTION public.fn_license_audit_events_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'license_audit_events is append-only (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$function$


-- FUNCTION sync_inbox_stamp_applied_seq
CREATE OR REPLACE FUNCTION public.sync_inbox_stamp_applied_seq()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'applied' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'applied') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('sync_inbox_applied:' || NEW.tenant_id::text, 0));
    NEW.applied_seq := nextval('sync_inbox_applied_seq');
    NEW.applied_at := COALESCE(NEW.applied_at, clock_timestamp());
  END IF;
  RETURN NEW;
END $function$


-- FUNCTION trg_cashbox_daily_from_ledger
CREATE OR REPLACE FUNCTION public.trg_cashbox_daily_from_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  amt numeric;
  delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.status, 'active') <> 'active' THEN
      RETURN NEW;
    END IF;
    IF NEW.cash_impact = 'in' THEN
      amt := COALESCE(NEW.debit, 0) + COALESCE(NEW.credit, 0);
      delta := amt;
    ELSIF NEW.cash_impact = 'out' THEN
      amt := COALESCE(NEW.debit, 0) + COALESCE(NEW.credit, 0);
      delta := -amt;
    ELSE
      RETURN NEW;
    END IF;
    PERFORM cashbox_daily_apply_delta(NEW.tenant_id, NEW.currency, NEW.date::date, delta);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- status active → cancelled: reverse; cancelled → active: re-apply
    IF OLD.cash_impact NOT IN ('in', 'out') AND NEW.cash_impact NOT IN ('in', 'out') THEN
      RETURN NEW;
    END IF;
    IF COALESCE(OLD.status, 'active') = 'active' AND COALESCE(NEW.status, 'active') = 'cancelled'
       AND OLD.cash_impact IN ('in', 'out') THEN
      amt := COALESCE(OLD.debit, 0) + COALESCE(OLD.credit, 0);
      delta := CASE WHEN OLD.cash_impact = 'in' THEN -amt ELSE amt END;
      PERFORM cashbox_daily_apply_delta(OLD.tenant_id, OLD.currency, OLD.date::date, delta);
    ELSIF COALESCE(OLD.status, 'active') = 'cancelled' AND COALESCE(NEW.status, 'active') = 'active'
       AND NEW.cash_impact IN ('in', 'out') THEN
      amt := COALESCE(NEW.debit, 0) + COALESCE(NEW.credit, 0);
      delta := CASE WHEN NEW.cash_impact = 'in' THEN amt ELSE -amt END;
      PERFORM cashbox_daily_apply_delta(NEW.tenant_id, NEW.currency, NEW.date::date, delta);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$function$


-- FUNCTION trg_cashbox_daily_from_manual
CREATE OR REPLACE FUNCTION public.trg_cashbox_daily_from_manual()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := CASE WHEN NEW.direction = 'in' THEN NEW.amount ELSE -NEW.amount END;
    PERFORM cashbox_daily_apply_delta(NEW.tenant_id, NEW.currency, NEW.date::date, delta);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    delta := CASE WHEN OLD.direction = 'in' THEN -OLD.amount ELSE OLD.amount END;
    PERFORM cashbox_daily_apply_delta(OLD.tenant_id, OLD.currency, OLD.date::date, delta);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Reverse old, apply new (covers amount/date/currency/direction edits).
    delta := CASE WHEN OLD.direction = 'in' THEN -OLD.amount ELSE OLD.amount END;
    PERFORM cashbox_daily_apply_delta(OLD.tenant_id, OLD.currency, OLD.date::date, delta);
    delta := CASE WHEN NEW.direction = 'in' THEN NEW.amount ELSE -NEW.amount END;
    PERFORM cashbox_daily_apply_delta(NEW.tenant_id, NEW.currency, NEW.date::date, delta);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$


-- TRIGGER cashbox_daily_ledger_ai
CREATE TRIGGER cashbox_daily_ledger_ai AFTER INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION trg_cashbox_daily_from_ledger();
-- TRIGGER cashbox_daily_ledger_au
CREATE TRIGGER cashbox_daily_ledger_au AFTER UPDATE OF status, cash_impact, debit, credit ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION trg_cashbox_daily_from_ledger();
-- TRIGGER trg_ledger_entries_append_only
CREATE TRIGGER trg_ledger_entries_append_only BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only();
-- TRIGGER trg_license_audit_events_no_delete
CREATE TRIGGER trg_license_audit_events_no_delete BEFORE DELETE ON public.license_audit_events FOR EACH ROW EXECUTE FUNCTION fn_license_audit_events_append_only();
-- TRIGGER trg_license_audit_events_no_update
CREATE TRIGGER trg_license_audit_events_no_update BEFORE UPDATE ON public.license_audit_events FOR EACH ROW EXECUTE FUNCTION fn_license_audit_events_append_only();
-- TRIGGER cashbox_daily_manual_aiud
CREATE TRIGGER cashbox_daily_manual_aiud AFTER INSERT OR DELETE OR UPDATE ON public.manual_movements FOR EACH ROW EXECUTE FUNCTION trg_cashbox_daily_from_manual();
-- TRIGGER trg_sync_inbox_applied_seq
CREATE TRIGGER trg_sync_inbox_applied_seq BEFORE INSERT OR UPDATE OF status ON public.sync_inbox FOR EACH ROW EXECUTE FUNCTION sync_inbox_stamp_applied_seq();
