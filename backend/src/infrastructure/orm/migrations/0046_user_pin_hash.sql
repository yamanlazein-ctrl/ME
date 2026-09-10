-- 0046: optional 4-digit PIN hash for device user-picker unlock (alongside password_hash).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash varchar(255);
