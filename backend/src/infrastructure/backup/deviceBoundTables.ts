// Dependency-free on purpose: imported by the engine-agnostic fingerprint (hubFingerprint.ts),
// which must not load portableBackup.ts and with it the PostgreSQL layer under DB_ENGINE=sqlite.
/** Machine / installation / license-activation state — never copied to another install. */
export const DEVICE_BOUND_TABLES = new Set([
  "licenses",
  "license_activations",
  "license_audit_events",
  "device_registrations",
  "secrets", // encrypted with this machine's APP_MASTER_KEY — unreadable elsewhere
  "server_installations",
  // MIG-07: `revoked_tokens` and `idempotency_keys` are company data on a hub and now travel with
  // the backup: the jti denylist keeps revoked sessions revoked, and the HTTP replay cache lets a
  // client that retries a POST across a cutover get its original answer instead of a duplicate.
  "invitation_codes", // device-local
]);
