-- DFP-013: enforce tenant/license pairing on invitations and devices.
-- Existence-only FKs to licenses(id) allowed cross-tenant references.

-- Composite unique target for FKs — column order must match REFERENCES (...).
CREATE UNIQUE INDEX IF NOT EXISTS licenses_tenant_id_uidx
  ON licenses (tenant_id, id);

-- Clear invitation→license links that cross tenants (license_id is nullable).
UPDATE invitation_codes AS i
SET license_id = NULL
FROM licenses AS l
WHERE i.license_id = l.id
  AND l.tenant_id IS DISTINCT FROM i.tenant_id;

-- Refuse to proceed if any device is bound to another tenant's license.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM device_registrations AS d
    JOIN licenses AS l ON l.id = d.license_id
    WHERE l.tenant_id IS DISTINCT FROM d.tenant_id
       OR l.tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'DFP-013: device_registrations has license rows with NULL or mismatched tenant_id — fix data before applying composite FK';
  END IF;
END $$;

-- Drop existence-only FKs (names from 0002 / 0021 inline REFERENCES).
ALTER TABLE invitation_codes
  DROP CONSTRAINT IF EXISTS invitation_codes_license_id_licenses_id_fk;
ALTER TABLE invitation_codes
  DROP CONSTRAINT IF EXISTS invitation_codes_license_id_fkey;
ALTER TABLE device_registrations
  DROP CONSTRAINT IF EXISTS device_registrations_license_id_licenses_id_fk;
ALTER TABLE device_registrations
  DROP CONSTRAINT IF EXISTS device_registrations_license_id_fkey;

-- Composite tenant equality.
ALTER TABLE invitation_codes
  ADD CONSTRAINT invitation_codes_tenant_license_fk
  FOREIGN KEY (tenant_id, license_id)
  REFERENCES licenses (tenant_id, id);

ALTER TABLE device_registrations
  ADD CONSTRAINT device_registrations_tenant_license_fk
  FOREIGN KEY (tenant_id, license_id)
  REFERENCES licenses (tenant_id, id);
