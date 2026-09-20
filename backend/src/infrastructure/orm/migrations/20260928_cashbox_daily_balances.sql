-- Phase 5: rolling per-day cashbox balances for O(1) overdraft guards.
-- Maintained by triggers on ledger_entries (cash_impact in/out) and
-- manual_movements so every mutation path stays consistent inside the
-- caller's transaction. Application reads closing_balance for as-of date.

CREATE TABLE IF NOT EXISTS cashbox_daily_balances (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  currency varchar(3) NOT NULL,
  balance_date date NOT NULL,
  closing_balance numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, currency, balance_date)
);

CREATE INDEX IF NOT EXISTS idx_cashbox_daily_balances_tenant_currency_date
  ON cashbox_daily_balances (tenant_id, currency, balance_date DESC);

ALTER TABLE cashbox_daily_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbox_daily_balances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cashbox_daily_balances;
CREATE POLICY tenant_isolation ON cashbox_daily_balances FOR ALL
USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Apply a signed cash delta (+in / -out) to the day and all later days.
-- SECURITY DEFINER + row_security=off: FORCE RLS would otherwise block the
-- trigger writer even when the session tenant matches (owner is forced too).
CREATE OR REPLACE FUNCTION cashbox_daily_apply_delta(
  p_tenant uuid,
  p_currency text,
  p_date date,
  p_delta numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
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
$$;

-- Shift every stored daily closing when the opening balance changes.
CREATE OR REPLACE FUNCTION cashbox_daily_shift_all(
  p_tenant uuid,
  p_currency text,
  p_delta numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
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
$$;

CREATE OR REPLACE FUNCTION trg_cashbox_daily_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
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
$$;

DROP TRIGGER IF EXISTS cashbox_daily_ledger_ai ON ledger_entries;
CREATE TRIGGER cashbox_daily_ledger_ai
  AFTER INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION trg_cashbox_daily_from_ledger();

DROP TRIGGER IF EXISTS cashbox_daily_ledger_au ON ledger_entries;
CREATE TRIGGER cashbox_daily_ledger_au
  AFTER UPDATE OF status, cash_impact, debit, credit ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION trg_cashbox_daily_from_ledger();

CREATE OR REPLACE FUNCTION trg_cashbox_daily_from_manual()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
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
$$;

DROP TRIGGER IF EXISTS cashbox_daily_manual_aiud ON manual_movements;
CREATE TRIGGER cashbox_daily_manual_aiud
  AFTER INSERT OR UPDATE OR DELETE ON manual_movements
  FOR EACH ROW
  EXECUTE FUNCTION trg_cashbox_daily_from_manual();
