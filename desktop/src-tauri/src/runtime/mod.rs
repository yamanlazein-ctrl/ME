// Runtime layer — process lifecycle, data root, packaging, updates, recovery (Plan §1.1, §3).
// The local database is embedded SQLite inside the server process: no database server, no port.
//
// The desktop edition is a runtime layer over the single shared ERP
// implementation — never a second ERP. This module owns boot ORDER
// (`stages`), failure identity (`error`), readiness gates (`health`), and the
// process stack itself (`stack`).
// Leaf OS primitives live beside it: `device_binding`, `secret_store`,
// `db_meta`, `hidden_process`, `document_archive`.
//
// One rule governs every public entry here: a failure surfaces the SINGLE
// originating stage and cleans up what boot already started — downstream
// layers never report their own noise (Plan §0.2).

mod boot_log;
mod error;
mod health;
mod stages;
mod stack;
mod pipe;
mod supervisor;

pub use boot_log::{boot_id, event as boot_event, init as init_boot_log};
pub use error::{fail, BootFailure};
pub use stages::{BootStage, ALL as BOOT_ORDER};
pub use stack::{
    apply_startup_choice, boot_desktop_stack, boot_desktop_stack_decided, boot_desktop_stack_with_progress,
    default_launch_facts, no_window_command, BootOutcome,
    read_hub_url, request_factory_reset, show_fatal_dialog, shutdown, write_hub_url,
    BootConfig, DesktopStack, StartupEnv,
};
pub use supervisor::{RecoveryReport, StackState, SupervisorHandle};
pub use pipe::{request as pipe_request, PipeRequest, PipeResponse, PIPE_PATH};


/// Single log prefix for the whole runtime layer, so support can follow one
/// boot across runtime and server lines.
pub(crate) fn log(msg: &str) {
    eprintln!("[desktop-runtime] {}", msg);
    boot_log::trace(msg);
}
