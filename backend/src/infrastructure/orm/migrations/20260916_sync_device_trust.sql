-- Batch 4 / item 4B — sync device trust: revocation + device↔user binding.
--
-- Why an additive migration: `sync_devices` could not express either concept.
--   * No revoked_at / revoke_reason → "revoked device" was unrepresentable, so
--     a decommissioned or compromised device kept its push/pull rights forever.
--   * `last_seen_by_user_id` is the user who touched the row LAST (overwritten
--     by every registerOrTouch), so it records a transient actor, not the set
--     of users the device is actually bound to. Authority over a device id was
--     therefore self-asserted: any tenant user could re-announce any device id
--     and the hub adopted it (fingerprint included).
--
-- `authorized_user_ids` is the additive binding: the users this device has been
-- provisioned for. It is grown only through an authenticated registration that
-- proves possession of the device (matching fingerprint) — see
-- PostgresSyncDeviceRepository.registerOrTouch.
ALTER TABLE "sync_devices" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
ALTER TABLE "sync_devices" ADD COLUMN IF NOT EXISTS "revoke_reason" varchar(64);
ALTER TABLE "sync_devices" ADD COLUMN IF NOT EXISTS "authorized_user_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Backfill for devices registered before this migration: the user who last
-- registered the device is the only binding evidence that exists. Any other
-- legitimate user of the same physical device re-binds on their next login via
-- the fingerprint match, so the backfill never strands a shared workstation.
UPDATE "sync_devices"
   SET "authorized_user_ids" = ARRAY["last_seen_by_user_id"]
 WHERE "last_seen_by_user_id" IS NOT NULL
   AND "authorized_user_ids" = '{}'::uuid[];
