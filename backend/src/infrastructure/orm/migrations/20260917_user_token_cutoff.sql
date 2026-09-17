ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokens_revoked_before" timestamptz;
