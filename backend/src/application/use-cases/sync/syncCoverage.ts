/**
 * SYNC-13 — Sync coverage registry.
 *
 * Single source of truth mapping EVERY mutating HTTP endpoint to either:
 *  - { sync: { entityType, operation } } — the handler MUST enqueue a sync
 *    unit, and materializeSyncUnit MUST handle entityType/operation; or
 *  - { exempt: "<reason>" } — deliberately device-local/admin/transport, with
 *    the reason recorded so exemptions stay reviewable.
 *
 * tests/sync-coverage.test.ts enforces three things:
 *  1. every mutating route in src/presentation/routes is listed here
 *     (a new endpoint without an entry fails the build);
 *  2. every `sync` entry has an enqueue call in its route file and a
 *     materialize branch in syncMaterialize.ts;
 *  3. exemptions are explicit strings, never silent omissions.
 */
export type CoverageEntry =
  { sync: { entityType: string; operation: string } } | { exempt: string };

export const SYNC_COVERAGE: Record<string, CoverageEntry> = {
  // ---- invoices ----
  "POST /invoices": { sync: { entityType: "invoice", operation: "create" } },
  "PUT /invoices/:id": { sync: { entityType: "invoice", operation: "update" } },
  "POST /invoices/:id/cancel": { sync: { entityType: "invoice", operation: "cancel" } },
  // ---- vouchers ----
  "POST /payments": { sync: { entityType: "voucher", operation: "create" } },
  "POST /receipts": { sync: { entityType: "voucher", operation: "create" } },
  "POST /payments/:id/cancel": { sync: { entityType: "voucher", operation: "cancel" } },
  "POST /receipts/:id/cancel": { sync: { entityType: "voucher", operation: "cancel" } },
  // ---- returns ----
  "POST /returns": { sync: { entityType: "return", operation: "create" } },
  "POST /returns/:id/cancel": { sync: { entityType: "return", operation: "cancel" } },
  // ---- orders ----
  "POST /orders": { sync: { entityType: "order", operation: "create" } },
  "POST /orders/:id/cancel": { sync: { entityType: "order", operation: "cancel" } },
  "PUT /orders/:id": { sync: { entityType: "order", operation: "update" } },
  "POST /orders/:id/fulfill": { sync: { entityType: "order", operation: "update" } },
  // ---- expenses ----
  "POST /expenses": { sync: { entityType: "expense", operation: "create" } },
  "POST /expenses/:id/cancel": { sync: { entityType: "expense", operation: "cancel" } },
  // ---- masters ----
  "POST /customers": { sync: { entityType: "party", operation: "create" } },
  "POST /suppliers": { sync: { entityType: "party", operation: "create" } },
  "PUT /customers/:id": { sync: { entityType: "party", operation: "update" } },
  "PUT /suppliers/:id": { sync: { entityType: "party", operation: "update" } },
  "DELETE /customers/:id": { sync: { entityType: "party", operation: "delete" } },
  "DELETE /suppliers/:id": { sync: { entityType: "party", operation: "delete" } },
  "POST /inventory/fabrics": { sync: { entityType: "fabric", operation: "create" } },
  "PUT /inventory/fabrics/:id": { sync: { entityType: "fabric", operation: "update" } },
  "DELETE /inventory/fabrics/:id": { sync: { entityType: "fabric", operation: "delete" } },
  "POST /inventory/colors": { sync: { entityType: "color", operation: "create" } },
  "PUT /inventory/colors/:id": { sync: { entityType: "color", operation: "update" } },
  "DELETE /inventory/colors/:id": { sync: { entityType: "color", operation: "delete" } },
  "POST /inventory/rolls": { sync: { entityType: "roll", operation: "create" } },
  "PUT /inventory/rolls/:id": { sync: { entityType: "roll", operation: "update" } },
  "DELETE /inventory/rolls/:id": { sync: { entityType: "roll", operation: "delete" } },
  // ---- ledger (direct writes) ----
  "POST /ledger": { sync: { entityType: "ledger", operation: "create" } },
  "POST /ledger/:id/cancel": { sync: { entityType: "ledger", operation: "cancel" } },
  // ---- settlements ----
  "POST /customers/:id/statement/settle": {
    sync: { entityType: "settlement", operation: "create" },
  },
  "POST /suppliers/:id/statement/settle": {
    sync: { entityType: "settlement", operation: "create" },
  },
  // ---- cashbox (SYNC-12) ----
  "POST /cashbox/opening-balance": { sync: { entityType: "cashbox", operation: "opening" } },
  "POST /cashbox/manual-movements": { sync: { entityType: "cashbox", operation: "movement" } },
  "DELETE /cashbox/manual-movements/:id": {
    sync: { entityType: "cashbox", operation: "movement-cancel" },
  },
  "POST /cashbox/close-day": { sync: { entityType: "cashbox", operation: "close" } },
  // ---- admin snapshots (hub-wins, no claims) ----
  "PUT /settings/:section": { sync: { entityType: "settings", operation: "update" } },
  "PUT /api/company/profile": { sync: { entityType: "company", operation: "update" } },

  // ---- transport (never business state) ----
  "PUT /sync/hub-config": { exempt: "local hub pairing, not a business document" },
  "POST /sync/hub-pair": { exempt: "local hub pairing, not a business document" },
  "POST /sync/run": { exempt: "sync transport itself" },
  "POST /sync/claims/reap": { exempt: "operator tooling on hub state" },
  "POST /sync/conflicts/resolve": { exempt: "operator tooling on hub conflict state" },
  "POST /sync/number-blocks/claim": {
    exempt: "numbering transport (blocks sync via pull snapshots)",
  },
  "POST /sync/number-blocks/ensure": { exempt: "numbering transport" },
  "POST /sync/number-blocks/reclaim": { exempt: "numbering transport" },
  // ---- identity / sessions (hub-authoritative per device, not business docs) ----
  "POST /api/auth/login": { exempt: "session issuance, per-device" },
  "POST /api/auth/logout": { exempt: "session issuance, per-device" },
  "POST /api/auth/refresh": { exempt: "session issuance, per-device" },
  "POST /api/auth/pin-login": { exempt: "session issuance, per-device" },
  "POST /api/auth/set-pin": { sync: { entityType: "user", operation: "set-pin" } },
  "POST /api/auth/sync-device": { exempt: "device registry is hub-authoritative per device" },
  "POST /api/invitations/generate": { exempt: "admin identity, single-admin issuance" },
  "POST /api/invitations/revoke/:id": { exempt: "admin identity, single-admin issuance" },
  "POST /api/invitations/validate": { exempt: "read-only validation" },
  "POST /api/invitations/consume": { sync: { entityType: "user", operation: "create" } },
  "PATCH /users/:id": { sync: { entityType: "user", operation: "update" } },
  "DELETE /users/:id": { sync: { entityType: "user", operation: "deactivate" } },
  "POST /users/:id/reset-password": { sync: { entityType: "user", operation: "update" } },
  "POST /api/license/activate": { exempt: "licensing, hub-authoritative" },
  "POST /api/license/devices/:deviceId/revoke": { exempt: "licensing, hub-authoritative" },
  "POST /api/license/heartbeat": { exempt: "licensing telemetry" },
  "POST /api/license/transfer": { exempt: "licensing, hub-authoritative" },
  "POST /api/setup/init": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/activate": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/company": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/admin": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/review": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/complete": { exempt: "one-time provisioning, pre-tenant" },
  // ---- device-local operational mirrors ----
  "POST /notifications": { exempt: "device-local mirror; sync rejections notify per device" },
  "POST /notifications/:id/read": { exempt: "device-local read state" },
  "POST /notifications/mark-all-read": { exempt: "device-local read state" },
  "POST /notifications/dismiss-all": { exempt: "device-local read state" },
  "POST /printing/send": { exempt: "per-device print queue" },
  "POST /printing/receive": { exempt: "per-device print queue" },
  "POST /api/company/logo": {
    exempt:
      "binary logo bytes stay device-local until attachment sync exists; profile fields sync via PUT /api/company/profile",
  },
  // ---- read-only POST (availability check, no writes) ----
  "POST /orders/pending-conflicts": { exempt: "read-only availability query (readGuard)" },
  "POST /expenses/names": {
    exempt: "no-op by design: returns 201 without writing (names derive from expense categories)",
  },
};
