-- Migration 0021: License owner + invitation link + device-user link
-- Phase 2 of the licensing system implementation

-- 1. Add license_id to invitation_codes (links invitation to a specific license)
ALTER TABLE invitation_codes ADD COLUMN license_id UUID REFERENCES licenses(id);

-- 2. Add is_license_owner to users (identifies the primary license owner)
ALTER TABLE users ADD COLUMN is_license_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Add owner_user_id to tenants (denormalized cache for fast owner lookup)
ALTER TABLE tenants ADD COLUMN owner_user_id UUID REFERENCES users(id);

-- 4. Add user_id to device_registrations (links device to a specific user)
ALTER TABLE device_registrations ADD COLUMN user_id UUID REFERENCES users(id);

-- 5. Indexes for performance
CREATE INDEX idx_invitation_codes_license ON invitation_codes(license_id);
CREATE INDEX idx_users_license_owner ON users(tenant_id, is_license_owner) WHERE is_license_owner = TRUE;
CREATE INDEX idx_device_registrations_user ON device_registrations(user_id);

-- 6. Partial unique index: only one license owner per tenant
CREATE UNIQUE INDEX idx_tenants_one_owner ON tenants(owner_user_id) WHERE owner_user_id IS NOT NULL;
