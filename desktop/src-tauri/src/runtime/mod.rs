// Runtime layer — process lifecycle, DB bootstrap, ports, packaging, updates,
// recovery (Plan §1.1, §3).
//
// The desktop edition is a runtime layer over the single shared ERP
// implementation — never a second ERP. This module owns boot ORDER
// (`stages`), failure identity (`error`), port management (`ports`),
// readiness gates (`health`), and the process stack itself (`stack`).
// Leaf OS primitives live beside it: `device_binding`, `secret_store`,
// `db_meta`, `hidden_process`, `document_archive`.
//
// One rule governs every public entry here: a failure surfaces the SINGLE
// originating stage and cleans up what boot already started — downstream
// layers never report their own noise (Plan §0.2).

mod boot_log;
mod error;
mod health;
mod ports;
mod stages;
mod stack;

pub use boot_log::{boot_id, event as boot_event, init as init_boot_log};
pub use error::{fail, BootFailure};
pub use stages::{BootStage, ALL as BOOT_ORDER};
pub use stack::{
    boot_desktop_stack, boot_desktop_stack_with_progress, no_window_command,
    read_hub_url, request_factory_reset, show_fatal_dialog, shutdown, write_hub_url,
    BootConfig, DesktopStack,
};

/// Single log prefix for the whole runtime layer, so support can follow one
/// boot across postgres/backend/SSR lines.
pub(crate) fn log(msg: &str) {
    eprintln!("[desktop-runtime] {}", msg);
    boot_log::trace(msg);
}
