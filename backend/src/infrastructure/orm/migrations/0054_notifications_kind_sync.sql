-- Allow the 'sync' notification kind used by the offline sync engine.
--
-- Root cause (live multi-device run, 2026-09-10): the sync engine writes two
-- kinds of operator notice with `kind = 'sync'` —
--   1. hub side, when a push loses the first-writer-wins claim
--      (`syncUseCases.ts` receiveSyncPush → "رُفضت مزامنة بسبب تعارض"), and
--   2. device side, when a local document is rolled back after its unit was
--      rejected (`syncUseCases.ts` → "أُبطلت عملية محلية بعد رفض المزامنة").
--
-- The TypeScript union in `INotificationRepository.ts` already lists 'sync',
-- so both call sites type-check — but the DB CHECK constraint was never
-- extended, so every insert failed with
--   `notifications_kind_check` violation
-- and the failure was swallowed by the caller's `catch (err) { logger.warn }`.
-- Result: conflict losers were never notified, and `notifications` stayed
-- empty on every node.
--
-- Fix: widen the constraint to include 'sync'. Existing values are preserved.
-- Idempotent: drop-then-add, so re-running is safe.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('credit', 'aging', 'stock', 'unpaid', 'cash', 'order', 'sync'));
