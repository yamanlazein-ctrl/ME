CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
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
       OR NEW.reference_id <> OLD.reference_id
       OR NEW.reference_type <> OLD.reference_type THEN
      RAISE EXCEPTION 'ledger_entries: financial columns are immutable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only();
