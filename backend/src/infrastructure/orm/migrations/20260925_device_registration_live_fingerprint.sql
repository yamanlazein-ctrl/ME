-- Prevent duplicate live registrations for one canonical device fingerprint.
-- The mutable device-count entitlement is serialized by the parent-license
-- row lock in the activation use case.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM device_registrations
    WHERE revoked_at IS NULL
    GROUP BY license_id, device_fingerprint
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate live device registrations exist; reconcile before applying 20260925_device_registration_live_fingerprint';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "device_registrations_live_license_fingerprint_uidx"
  ON "device_registrations" ("license_id", "device_fingerprint")
  WHERE "revoked_at" IS NULL;
