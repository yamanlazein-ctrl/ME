-- P1-13: unify license device registrations and sync devices by one
-- canonical fingerprint. Existing rows are linked where the fingerprint is
-- already the same; unmatched sync rows remain visible and are linked on the
-- next authenticated registration.
ALTER TABLE "sync_devices"
  ADD COLUMN IF NOT EXISTS "device_registration_id" uuid;

CREATE INDEX IF NOT EXISTS "idx_sync_devices_device_registration"
  ON "sync_devices" ("device_registration_id");

-- A registration belongs to one tenant; the application verifies tenant
-- equality before assigning the nullable link. The FK prevents dangling links.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sync_devices_device_registration_fk'
  ) THEN
    ALTER TABLE "sync_devices"
      ADD CONSTRAINT "sync_devices_device_registration_fk"
      FOREIGN KEY ("device_registration_id")
      REFERENCES "device_registrations"("id");
  END IF;
END $$;

-- Deterministically link existing same-tenant, same-fingerprint rows. When
-- multiple historical registrations exist, choose the oldest registration so
-- the migration never invents a second device identity.
UPDATE "sync_devices" s
SET "device_registration_id" = chosen.id
FROM LATERAL (
  SELECT d.id
  FROM "device_registrations" d
  WHERE d.tenant_id = s.tenant_id
    AND d.device_fingerprint = s.device_fingerprint
  ORDER BY d.created_at ASC, d.id ASC
  LIMIT 1
) chosen
WHERE s."device_registration_id" IS NULL;
