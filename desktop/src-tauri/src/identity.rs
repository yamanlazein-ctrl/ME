// Installation identity — License ≠ Company ≠ Installation ≠ User (Plan §2).
//
// Why a separate module for what is currently one call: every previous
// desktop attempt let a new installation silently inherit an old company's
// identity and data (copied pgdata, leftover tenant, stale activation). The
// rule "a new installation must ALWAYS provision a fresh installation
// identity and must NEVER reuse a previous tenant/company/license state" has
// to be visible as its own boot step with its own refusal path — not buried
// inside database provisioning.
//
// Division of ownership (hard separation, Plan §1.1):
//   - THIS module (+ `device_binding`, `db_meta`): who is this installation?
//     DPAPI-bound `device-binding.dat` proves same machine+user; `db-meta.json`
//     stamps the live pgdata with that identity. A blob that cannot be
//     decrypted (copied install, different user/PC, tampering) refuses boot.
//   - Backend/license server: what company, what user, what rights? The
//     license key carries NO company name, PIN, or business data; company
//     setup and the manager account happen in the ERP after activation.
//   - The vendor dashboard issues rights; it never sees customer PINs.
//
// Call order is enforced by main.rs: `ensure_fresh_installation()` (step 0)
// runs BEFORE any sidecar starts, and its result stamps every fresh cluster.

pub use crate::device_binding::DeviceBindError;

/// Step 0 of desktop boot. First launch mints and persists a fresh
/// installation identity; later launches verify it. Returns the stable
/// `installation_id` used to stamp `db-meta.json`.
///
/// `Err(DeviceBindError::Tampered)` ⟹ the caller must REFUSE to start —
/// showing the copied-install guidance, never the backend stack.
pub fn ensure_fresh_installation() -> Result<String, DeviceBindError> {
    crate::device_binding::ensure_device_binding()
}
