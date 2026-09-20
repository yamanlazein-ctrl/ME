-- FIN-03: tenants.activation_id had no referential integrity, so a tenant
-- could point at a license_activations row that does not exist (roster proof
-- path #2 then fails silently). The desktop activation use case writes both
-- rows in one transaction, so a real FK is safe.
--
-- ON DELETE SET NULL: removing an activation must not delete the tenant; it
-- only clears the denormalized pointer.
DO $$
BEGIN
  -- Clear dangling pointers first so the constraint can be validated.
  UPDATE tenants t
     SET activation_id = NULL
   WHERE t.activation_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM license_activations la WHERE la.id = t.activation_id
     );

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_activation_id_fk'
  ) THEN
    ALTER TABLE "tenants"
      ADD CONSTRAINT "tenants_activation_id_fk"
      FOREIGN KEY ("activation_id")
      REFERENCES "license_activations" ("id")
      ON DELETE SET NULL;
  END IF;
END $$;
