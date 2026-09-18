// BootFailure — one failure, one cause (Plan §0.2, §9.1).
//
// Root cause this closes: the historic cascade
//   Postgres fails → backend fails → frontend fires dozens of API errors
//   → user concludes "invoices and inventory are corrupted"
// happened because every layer reported its own downstream symptom. Here a
// boot failure carries exactly one originating `BootStage` plus a stable
// machine `code`, and the boot routine stops at the first failure after
// cleaning up what it started. The UI shows ONE dialog (built at the failure
// site, where the true cause is known) — never a storm of downstream noise.
//
// `detail` is the low-level cause for logs/support. User-facing Arabic text
// is composed at the failure site in `stack.rs`, where the full context
// (paths, ports, likely causes) is available.

use super::stages::BootStage;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootFailure {
    pub stage: BootStage,
    pub code: &'static str,
    pub detail: String,
}

impl BootFailure {
    pub fn new(stage: BootStage, code: &'static str, detail: impl Into<String>) -> Self {
        BootFailure {
            stage,
            code,
            detail: detail.into(),
        }
    }

    /// One log line identifying the single true root cause.
    pub fn log_line(&self) -> String {
        format!(
            "boot failed at stage '{}' ({}): {}",
            self.stage.code(),
            self.code,
            self.detail
        )
    }
}

impl fmt::Display for BootFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.log_line())
    }
}

impl std::error::Error for BootFailure {}

/// Convenience for the `return Err(fail(...))` sites in `stack.rs`.
pub fn fail<T>(
    stage: BootStage,
    code: &'static str,
    detail: impl Into<String>,
) -> Result<T, BootFailure> {
    Err(BootFailure::new(stage, code, detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_identifies_single_stage_and_code() {
        let f = BootFailure::new(BootStage::StartDatabase, "pg_ctl-start", "exit 1");
        assert_eq!(f.stage, BootStage::StartDatabase);
        assert_eq!(f.code, "pg_ctl-start");
        let line = f.log_line();
        assert!(line.contains("start-db"), "log must name the stage: {line}");
        assert!(line.contains("pg_ctl-start"), "log must name the code: {line}");
    }
}
