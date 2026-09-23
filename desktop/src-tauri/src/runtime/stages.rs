// BootStage — the explicit, ordered startup sequence (Plan §1.2, §3.3, §11).
//
// Root cause this closes: every previous desktop attempt sequenced startup
// implicitly (whatever ran first won) and timing-dependently, so a slow disk,
// a busy port, or a cold AV scan reordered the boot and produced a different
// failure each time. Here the order is a single enumerated list: adding,
// removing, or reordering a stage requires editing `ALL`, which the order
// test below observes. Progress labels come from the same table, so the
// splash screen can never disagree with what the boot actually does.
//
// DeviceBinding (step 0) runs in main.rs before this module is entered and is
// listed here so the full order is visible in one place.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootStage {
    /// Step 0 — DPAPI device-binding gate (main.rs). Refuses copied installs.
    DeviceBinding,
    /// Verify every runtime-critical bundled file exists (AV quarantine check).
    Preflight,
    /// Apply a queued factory reset, if the user requested one in-app.
    FactoryReset,
    /// Provision or adopt the local PostgreSQL data directory (identity-gated).
    ProvisionDatabase,
    /// Force postgresql.conf's port into lock-step with the bind port.
    SyncDbPort,
    /// Start postgres.exe via pg_ctl and ensure the `erp` database exists.
    StartDatabase,
    /// Load or generate DPAPI-encrypted local secrets (JWT/APP_MASTER_KEY).
    LoadSecrets,
    /// Spawn the ONE bundled Node server (API + built frontend, same origin, OS-assigned port).
    StartServer,
    /// Wait until the server reports its port (it writes the port file only once it accepts
    /// connections) and answers /api/health/live. Liveness-based: the wait ends when the server is
    /// ready or when the process is dead — never on an arbitrary timeout.
    WaitServer,
}

/// The full boot order. The runner in `stack.rs` executes these top to bottom;
/// this table is the single place that defines "what boot is".
pub const ALL: &[BootStage] = &[
    BootStage::DeviceBinding,
    BootStage::Preflight,
    BootStage::FactoryReset,
    BootStage::ProvisionDatabase,
    BootStage::SyncDbPort,
    BootStage::StartDatabase,
    BootStage::LoadSecrets,
    BootStage::StartServer,
    BootStage::WaitServer,
];

impl BootStage {
    /// Short Arabic label shown on the splash screen while the stage runs.
    /// The text is progress information only — never an error report.
    pub fn label(self) -> &'static str {
        match self {
            BootStage::DeviceBinding => "التحقق من الجهاز…",
            BootStage::Preflight => "فحص ملفات التشغيل…",
            BootStage::FactoryReset => "مراجعة طلبات إعادة الضبط…",
            BootStage::ProvisionDatabase => "تجهيز قاعدة البيانات المحلية…",
            BootStage::SyncDbPort => "ضبط إعدادات قاعدة البيانات…",
            BootStage::StartDatabase => "تشغيل قاعدة البيانات…",
            BootStage::LoadSecrets => "تجهيز مفاتيح التشغيل…",
            BootStage::StartServer => "تشغيل النظام…",
            BootStage::WaitServer => "فتح الواجهة…",
        }
    }

    /// Stable machine-readable code for logs and support (NOT translated).
    pub fn code(self) -> &'static str {
        match self {
            BootStage::DeviceBinding => "device-binding",
            BootStage::Preflight => "preflight",
            BootStage::FactoryReset => "factory-reset",
            BootStage::ProvisionDatabase => "provision-db",
            BootStage::SyncDbPort => "sync-db-port",
            BootStage::StartDatabase => "start-db",
            BootStage::LoadSecrets => "load-secrets",
            BootStage::StartServer => "start-server",
            BootStage::WaitServer => "wait-server",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn boot_order_is_total_and_stable() {
        // Every stage must appear exactly once in ALL, in the documented order.
        let codes: Vec<&str> = ALL.iter().map(|s| s.code()).collect();
        assert_eq!(
            codes,
            vec![
                "device-binding",
                "preflight",
                "factory-reset",
                "provision-db",
                "sync-db-port",
                "start-db",
                "load-secrets",
                "start-server",
                "wait-server",
            ]
        );
        let uniq: HashSet<&str> = codes.iter().copied().collect();
        assert_eq!(uniq.len(), codes.len(), "duplicate stage in boot order");
    }

    #[test]
    fn every_stage_has_a_progress_label() {
        for stage in ALL {
            assert!(!stage.label().is_empty(), "missing label for {:?}", stage);
        }
    }
}
