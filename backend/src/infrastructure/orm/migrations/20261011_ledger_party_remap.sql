-- OLD-PLAN Phase 3.4: allow controlled party_id remap during customer merge.
-- Session: SET LOCAL app.allow_party_remap = '1' inside the merge transaction.

CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;
