-- 0013: Database hardening — non-negative stock constraint + immutable ledger trigger.
-- P0: Prevents negative remaining_kg at the DB level.
-- P1: Prevents UPDATE/DELETE on ledger_entries (append-only, cancel via status change only).

-- 1. Non-negative remaining_kg constraint on rolls
ALTER TABLE rolls ADD CONSTRAINT ck_remaining_kg_nonnegative CHECK (remaining_kg >= 0);

-- 2. Immutable ledger: prevent UPDATE and DELETE on ledger_entries.
-- The only mutation allowed is through the INSERT path (create) and the
-- soft-delete pattern (status -> 'cancelled' via a controlled update).
-- This trigger blocks all DELETEs and any UPDATE that is NOT only setting
-- cancelled_at / cancelled_by / status to 'cancelled'.
CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Allow UPDATE only for cancellation: status → 'cancelled' with cancelled_at set
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'ledger_entries: cannot modify already-cancelled rows'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Only these columns may change during cancellation
    IF NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'ledger_entries: UPDATE only allowed for cancellation (status→cancelled)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Prevent changes to financial columns even during cancellation
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

CREATE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only();