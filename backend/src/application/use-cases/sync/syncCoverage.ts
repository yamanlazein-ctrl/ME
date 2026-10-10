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
  // ---- press cycle (textile printing/dyeing: moves stock and cash) ----
  "POST /printing/send": { sync: { entityType: "print", operation: "send" } },
  "POST /printing/receive": { sync: { entityType: "print", operation: "receive" } },
  "POST /expenses/:id/cancel": { sync: { entityType: "expense", operation: "cancel" } },
  // ---- masters ----
  "POST /customers": { sync: { entityType: "party", operation: "create" } },
  "POST /suppliers": { sync: { entityType: "party", operation: "create" } },
  "PUT /customers/:id": { sync: { entityType: "party", operation: "update" } },
  "PUT /suppliers/:id": { sync: { entityType: "party", operation: "update" } },
  "PUT /customers/:id/opening": { sync: { entityType: "party", operation: "update" } },
  "PUT /suppliers/:id/opening": { sync: { entityType: "party", operation: "update" } },
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
  "POST /inventory/rolls/:id/adjust": { sync: { entityType: "roll", operation: "adjust" } },
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

  // ---- year-end closing: tenant-wide control plane, not a syncable document.
  // A close is a one-shot administrative freeze of a whole year for EVERY
  // device; replicating it as a per-device document would let two devices
  // close independently. Devices converge instead by pulling `financial_years`.
  // device; replicating it as a per-device document would let two devices
  // close independently. Devices converge instead by pulling `financial_years`.
  "POST /financial-years/begin-counting": {
    exempt: "year-end control plane; devices converge by pulling financial_years, not by replaying a close",
  },
  "POST /financial-years/close": {
    exempt: "year-end control plane; whole-tenant freeze, hub-authoritative, never replayed per device",
  },
  "POST /financial-years/reopen": {
    exempt: "year-end control plane; audited admin action, hub-authoritative",
  },
  // The count rows are local working state for one operator's count sheet. The
  // DOCUMENT that matters (the stock movement + ledger leg) is written by
  // counts/post, and that variance is already covered by the roll/ledger
  // entries it produces.
  "POST /financial-years/counts": {
    exempt: "count sheet is per-operator working state; the posted adjustment flows through stock_movements + ledger_entries",
  },
  // A posted variance changes the shelf: replayed on every device as a roll delta.
  "POST /financial-years/counts/post": { sync: { entityType: "roll", operation: "adjust" } },

  // ---- corrective dye purge: a hub-authoritative administrative repair.
  // It rewrites documents that were ORIGINALLY synced, so replaying it as a
  // per-device document would diverge the devices from the hub. The hub is
  // authoritative and devices converge by pulling.
  "DELETE /inventory/dyes/:id/purge": {
    exempt: "corrective purge of synced documents; hub-authoritative, not replayed per device",
  },

  // ---- party merge: refused (409) while sync is enabled; standalone only
  "POST /parties/merge": { exempt: "standalone-only party merge; route returns 409 when sync enqueue is enabled" },
  // ---- local integrity control plane (not business state)
  "POST /integrity/accept-baseline": { exempt: "admin data-integrity baseline control, not a business document" },
  "POST /integrity/authorize-reset": { exempt: "admin reset authorization control, not a business document" },
  // ---- transport (never business state) ----
  "PUT /sync/hub-config": { exempt: "local hub pairing, not a business document" },
  "POST /sync/hub-pair": { exempt: "local hub pairing, not a business document" },
  "POST /sync/hub/test": { exempt: "read-only hub ping" },
  "POST /sync/hub/connect": { exempt: "local hub pairing, not a business document" },
  "DELETE /sync/hub": { exempt: "local hub pairing, not a business document" },
  "POST /sync/hub/enroll": { exempt: "local hub pairing (enrollment code), not a business document" },
  "POST /sync/hub/devices/:deviceId/revoke": { exempt: "proxy to the hub device registry" },
  "POST /sync/hub/devices/:deviceId/reinstate": { exempt: "proxy to the hub device registry" },
  "POST /sync/hub/enrollment-code": { exempt: "proxy to the hub enrollment code" },
  "DELETE /sync/hub/enrollment-code": { exempt: "proxy to the hub enrollment code" },
  "POST /sync/enrollment-code": { exempt: "hub device enrollment code, not a business document" },
  "DELETE /sync/enrollment-code": { exempt: "hub device enrollment code, not a business document" },
  "POST /sync/devices/self/credential": { exempt: "hub device credential, not a business document" },
  "POST /api/sync/enroll": { exempt: "hub device enrollment (registry is hub-authoritative)" },
  "POST /api/sync/device-token": { exempt: "hub device token exchange, read-only for data" },
  "POST /sync/activity": { exempt: "ephemeral presence feed on the hub, not a business document" },
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
  "POST /api/license/devices/:deviceId/revoke": { exempt: "org DeviceSeat revoke" },
  "POST /api/org/devices/:deviceId/revoke": { exempt: "org DeviceSeat revoke" },
  "POST /api/license/heartbeat": { exempt: "licensing telemetry" },
  "POST /api/license/transfer": { exempt: "vendor-only Control Plane (ERP returns 403)" },
  "GET /api/license/updates/status": { exempt: "licensing update policy read" },
  "POST /api/setup/init": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/activate": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/company": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/admin": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/review": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/complete": { exempt: "one-time provisioning, pre-tenant" },
  "POST /api/setup/wizard/restore": {
    exempt: "first-run restore of a local backup (no users yet); restored sync outbox/inbox/cursor carry the sync state",
  },
  // ---- first-run restore of a full backup (the text-only-IPC hand-off fix)
  "POST /api/setup/wizard/restore-path": {
    exempt: "first-run restore taken by path from the shell (backup bytes never cross the IPC bridge); restored sync outbox/inbox/cursor carry the sync state",
  },
  "POST /api/backup/restore-path": {
    exempt: "admin restore of a full backup taken by path from the shell; no sync unit is produced",
  },
  // ---- desktop runtime hand-off (specs/001 US3/US4; local process control, not business state) ----
  "POST /api/desktop/runtime/pre-update-backup": {
    exempt: "device-local backup file taken before an update; the backup is a local artifact, never a business document",
  },
  "POST /api/desktop/runtime/shutdown": { exempt: "device-local process shutdown for the update hand-off" },
  // ---- device-local operational mirrors ----
  "POST /notifications": { exempt: "device-local mirror; sync rejections notify per device" },
  "POST /notifications/:id/read": { exempt: "device-local read state" },
  "POST /notifications/mark-all-read": { exempt: "device-local read state" },
  "POST /notifications/dismiss-all": { exempt: "device-local read state" },
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
