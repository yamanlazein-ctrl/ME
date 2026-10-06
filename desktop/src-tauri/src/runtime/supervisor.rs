// Supervisor — keeps the local stack serving for the whole session.
//
// The problem this closes
// ----------------------
// On the desktop build the bundled Node server IS the application: the WebView
// can only show `http://127.0.0.1:<port>`, so the moment that process dies the
// window is left on WebView2's built-in "can't reach this page" / "no internet"
// screen. That page is a lie (the machine is usually perfectly online), it
// names a network problem the user cannot fix, and it has no button. Before
// this module nothing watched the child after boot: `boot_desktop_stack_*`
// returned, the process was never polled again, and any later fault — an
// unhandled 'error' event, an OOM kill, an antivirus action, a wedged event
// loop — ended the app for the rest of the session.
//
// What the supervisor does
// ------------------------
// One background thread owns the booted `DesktopStack` and, every couple of
// seconds, asks two questions: is the child process still alive, and does its
// named pipe still answer the liveness probe? While both are true it does nothing
// at all. The moment either stops being true it takes the window away from the
// user (through the state callback) and re-runs the SAME spawn + readiness gate
// boot uses, with an exponential backoff.
//
// Restart bound (specs/001-desktop-sqlite-engine T070, OQ-2): at most 3 restarts
// in any rolling 5 minutes. The 4th failure inside the window stops the service
// (`StackState::Failed`, SERVICE_STOPPED) and the in-app recovery dialog takes
// over with the server's own `[FATAL]` line. The database is embedded in the
// server process (SQLite), so there is no separate database process to watch.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::health::{wait_ready, WaitOutcome};
use super::log;
use super::pipe;
use super::stack::{self, BootConfig, DesktopStack};
use crate::hidden_process::hide_stray_console_async;
use crate::secret_store::SecretStore;


/// How often the local stack is checked. Short enough that a user never really
/// sits in front of a dead page, long enough to cost nothing.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Consecutive failed probes tolerated before a server that is *alive* but no
/// longer serving is treated as dead and recycled. One missed probe is just a
/// busy machine (cold AV scan, a big report export); three in a row is a wedged
/// event loop. A process that has actually EXITED needs no strikes at all.
const UNHEALTHY_STRIKES: u32 = 3;

/// Restarts allowed in any rolling `RESTART_WINDOW` (OQ-2). Restarts that keep
/// failing mean the cause is not transient (a quarantined binary, a refused
/// database); retrying forever would only be a spinner, and every extra attempt
/// destroys evidence.
const MAX_RESTARTS: u32 = 3;
/// The rolling window the restart bound is counted in.
const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);

/// The user-facing reason when the bound is reached. Deliberately says nothing
/// about the data: the database file is intact (every commit is durable), and
/// wording that suggests corruption makes users do destructive things.
pub(crate) const SERVICE_STOPPED: &str = "SERVICE_STOPPED: توقفت الخدمة الداخلية للبرنامج بعد 3 محاولات إعادة تشغيل خلال 5 دقائق \
     (internal service stopped). أغلق البرنامج ثم افتحه من جديد؛ وإن تكرر ذلك أرسل ملف logs\\crash.log للدعم الفني.";

/// Longest wait between two restarts.
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// Ceiling for ONE restart's readiness wait. Deliberately much shorter than
/// boot's 20 minutes: the schema is already migrated, so a restart that has
/// not served in five minutes is not "slow", it is stuck.
const RESTART_CEILING: Duration = Duration::from_secs(300);

/// Granularity of the interruptible sleeps, which bounds how long a shutdown
/// waits for this thread to notice it was asked to stop.
const CANCEL_SLICE: Duration = Duration::from_millis(200);

/// Windows reports `(DWORD)-1` when a process is terminated from OUTSIDE this
/// app (Task Manager, an antivirus, a stray console Ctrl+C). The raw number
/// means nothing to support; the name does. It is also why cancellation is
/// never signalled through a fake exit code — that value is a real one.
pub(crate) fn exit_code_label(code: u32) -> String {
    match code {
        0 => "0 (clean exit)".to_string(),
        0xFFFF_FFFF => format!("{code} — terminated from outside this app"),
        c => c.to_string(),
    }
}

/// What the shell's window layer should be showing right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StackState {
    /// Serving on the named pipe. The window loads from Tauri's own asset
    /// protocol, so there is no origin to report — readiness is one fact.
    Healthy,
    /// The local server is down and a restart is under way. The window must be
    /// taken away from the user — this is the state that stops WebView2's own
    /// error page from ever becoming the app.
    Recovering {
        attempt: u32,
        max_attempts: u32,
        reason: String,
    },
    /// The attempt budget is spent. The in-app recovery dialog owns the screen.
    Failed { reason: String },
}

/// Sleep, but wake up as soon as `cancelled` says so.
/// Returns false when it was cancelled, true when the full duration elapsed.
fn sleep_interruptible(total: Duration, cancelled: impl Fn() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < total {
        if cancelled() {
            return false;
        }
        std::thread::sleep(CANCEL_SLICE.min(total.saturating_sub(start.elapsed())));
    }
    !cancelled()
}

/// What one probe cycle concluded.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Still serving (or a blip we tolerate). Do nothing.
    Idle,
    /// The local server is unusable — take the window away and restart.
    Restart { reason: String },
}

/// The decision the whole supervisor turns on.
///
/// Two independent failure shapes, deliberately treated differently:
///   - the process EXITED is unambiguous, so it restarts at once;
///   - the process is alive but not answering needs corroboration, because a
///     single missed probe is a loaded machine, not a dead app — and reacting
///     to one would tear the window away from a working user.
fn decide(consecutive_unhealthy: u32, exit_code: Option<u32>) -> Action {
    if consecutive_unhealthy == 0 {
        return Action::Idle;
    }
    match exit_code {
        Some(code) => Action::Restart {
            reason: format!(
                "the local server process exited ({})",
                exit_code_label(code)
            ),
        },
        None if consecutive_unhealthy >= UNHEALTHY_STRIKES => Action::Restart {
            reason: format!(
                "the local server stopped answering its health check for {consecutive_unhealthy} consecutive probes"
            ),
        },
        None => Action::Idle,
    }
}

/// Delay before restart number `attempt` (1-based). The first retry is
/// immediate — a dead process is a fact, not a trend — then 2s, 4s, 8s, 15s.
pub(crate) fn backoff_for(attempt: u32) -> Duration {
    if attempt <= 1 {
        return Duration::ZERO;
    }
    Duration::from_secs(2u64 << (attempt - 2).min(4)).min(MAX_BACKOFF)
}

/// Verdict for the restart about to be attempted.
///
/// Split out from the monitor loop so the rule — the thing that must not be
/// wrong — is directly unit-testable without threads, sockets or a process table.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Breaker {
    /// The restart may proceed; it is attempt `n` (1-based) inside the window.
    Allow(u32),
    /// The bound is reached: stop. The payload becomes the user-facing reason.
    Trip(String),
}

/// The rolling restart bound (T070): at most `MAX_RESTARTS` restarts in any
/// `RESTART_WINDOW`. `log` holds the instants of the restarts already spent; the
/// ones older than the window fall out (so restarts outside the window reset
/// the count). An allowed restart is recorded in `log`.
pub(crate) fn restart_verdict(log: &mut std::collections::VecDeque<Instant>, now: Instant, reason: &str) -> Breaker {
    while log.front().map_or(false, |t| now.saturating_duration_since(*t) >= RESTART_WINDOW) {
        log.pop_front();
    }
    if log.len() as u32 >= MAX_RESTARTS {
        return Breaker::Trip(format!("{SERVICE_STOPPED}\n\n{reason}"));
    }
    log.push_back(now);
    Breaker::Allow(log.len() as u32)
}

/// Record one supervisor event in `logs/crash.log`, with the tails of both
/// child logs attached.
///
/// This is the file the user is told to send to support, so it must carry the
/// actual output, not just our own summary: a supervisor event means a child
/// died, and the reason is in that child's stderr (`server.log`) or in
/// `pgdata/pg.log`.
fn log_crash(
    sup: &Arc<Supervisor>,
    event: &str,
    reason: &str,
    stage: &str,
    exit_code: Option<u32>,
) {
    let app_data_root = {
        let g = sup.shared.lock().expect("supervisor state poisoned");
        g.app_data_root.clone()
    };
    let server_log = app_data_root.join("server.log");
    super::boot_log::append_crash_report(&app_data_root, event, reason, stage, exit_code, Some(&server_log), None);
}

struct Shared {
    state: StackState,
    /// Failed probes in the CURRENT outage. Reset as soon as one succeeds.
    unhealthy: u32,
    /// Instants of the restarts spent in the rolling window (T070). Not reset
    /// by a healthy probe: the bound is "3 per rolling 5 minutes", whatever
    /// happened in between.
    restart_log: std::collections::VecDeque<Instant>,
    app_data_root: PathBuf,
}

/// Cheap-to-clone control surface: the monitor thread holds one of these and
/// the shell (Tauri state, `ExitRequested`, the recovery dialog) holds others.
struct Supervisor {
    shared: Mutex<Shared>,
    stopping: AtomicBool,
    /// Set by the recovery dialog to ask for a fresh attempt budget.
    retry: AtomicBool,
}

impl Supervisor {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Publish a new state, notifying the window layer only if it CHANGED.
    /// The lock is always released before `notify` runs: the callback hops to
    /// the UI thread, which may call straight back into `SupervisorHandle`.
    fn publish(&self, next: StackState, notify: &dyn Fn(&StackState)) {
        {
            let mut g = self.shared.lock().expect("supervisor state poisoned");
            if g.state == next {
                return;
            }
            g.state = next.clone();
        }
        notify(&next);
    }

    /// One successful probe ends the current outage.
    fn mark_healthy(&self, notify: &dyn Fn(&StackState)) {
        {
            let mut g = self.shared.lock().expect("supervisor state poisoned");
            g.unhealthy = 0;
        }
        self.publish(StackState::Healthy, notify);
    }
}

/// The supervisor as the shell sees it: shared control plus the monitor thread,
/// which must be joined on the way out because its exit path runs the normal
/// `shutdown` (so the app never leaves PostgreSQL running).
pub struct SupervisorHandle {
    sup: Arc<Supervisor>,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

impl SupervisorHandle {
    /// Take ownership of a booted stack and start watching it.
    ///
    /// `notify` runs on the monitor thread, on every state CHANGE, and is never
    /// called for the initial `Healthy` state — the caller starts there, so the
    /// callback only ever has to handle the two interesting transitions.
    pub fn start(stack: DesktopStack, notify: impl Fn(&StackState) + Send + Sync + 'static) -> Self {
        // Boot already settled the ports and decrypted the secrets; a restart
        // replays exactly those, so it can never drift from the run it
        // recovers (and secrets.dat is never read a second time).
        let cfg = stack.cfg.clone();
        let store = stack.secrets.clone();
        let sup = Arc::new(Supervisor {
            shared: Mutex::new(Shared {
                state: StackState::Healthy,
                unhealthy: 0,
                restart_log: std::collections::VecDeque::new(),
                app_data_root: cfg.app_data_root.clone(),
            }),
            stopping: AtomicBool::new(false),
            retry: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&sup);
        let notify: Arc<dyn Fn(&StackState) + Send + Sync> = Arc::new(notify);
        let monitor = std::thread::Builder::new()
            .name("stack-supervisor".into())
            .spawn(move || monitor_loop(weak, stack, cfg, store, &notify))
            .expect("spawn stack supervisor thread");
        log("supervisor: watching the local stack (server child + /api/health/live)");
        SupervisorHandle {
            sup,
            monitor: Mutex::new(Some(monitor)),
        }
    }

    pub fn state(&self) -> StackState {
        self.sup.shared.lock().expect("supervisor state").state.clone()
    }

    /// True while the local server is serving on the named pipe.
    pub fn is_healthy(&self) -> bool {
        matches!(self.state(), StackState::Healthy)
    }

    /// Path of the log the recovery dialog points the user at.
    pub fn app_data_root(&self) -> PathBuf {
        self.sup
            .shared
            .lock()
            .expect("supervisor state")
            .app_data_root
            .clone()
    }

    /// What the server itself said went wrong: its last `[FATAL]` line plus a
    /// short log tail. This is the actionable text — "port unreachable" is not.
    pub fn failure_detail(&self) -> String {
        stack::server_failure_detail(&self.app_data_root())
    }

    /// Operator pressed "retry": give the next cycle a full attempt budget
    /// again instead of sitting in `Failed`.
    pub fn request_retry(&self) {
        self.sup.retry.store(true, Ordering::SeqCst);
    }

    /// Stop monitoring and tear the local stack down (server child first, then
    /// PostgreSQL). Idempotent — the session-end hook and `ExitRequested` both
    /// call it.
    pub fn stop(&self) {
        self.sup.stopping.store(true, Ordering::SeqCst);
        if let Some(handle) = self.monitor.lock().expect("supervisor monitor").take() {
            // The monitor notices the flag within one CANCEL_SLICE and its exit
            // path runs `shutdown`, so this join is bounded by one probe (~2s).
            if handle.join().is_err() {
                log("supervisor: monitor thread panicked");
            }
        }
    }
}

fn monitor_loop(
    sup: Weak<Supervisor>,
    mut stack: DesktopStack,
    mut cfg: BootConfig,
    store: SecretStore,
    notify: &Arc<dyn Fn(&StackState) + Send + Sync>,
) {
    log("supervisor: monitor started");
    loop {
        let Some(sup) = sup.upgrade() else { break };
        if sup.stopping() {
            break;
        }
        cycle(&sup, &mut stack, &mut cfg, &store, notify.as_ref());
        if !sleep_interruptible(POLL_INTERVAL, || sup.stopping()) {
            break;
        }
    }
    // The monitor owns the stack for the whole session, so this is the one
    // place the teardown can happen — main.rs no longer holds a copy to stop.
    log("supervisor: monitor finished — shutting down the local stack");
    stack::shutdown(&mut stack);
}

fn cycle(
    sup: &Arc<Supervisor>,
    stack: &mut DesktopStack,
    cfg: &mut BootConfig,
    store: &SecretStore,
    notify: &dyn Fn(&StackState),
) {
    // The operator asked for another go: forget the exhausted budget so this
    // cycle starts again at attempt 1.
    if sup.retry.swap(false, Ordering::SeqCst) {
        let mut g = sup.shared.lock().expect("supervisor state poisoned");
        g.unhealthy = 0;
        // The operator explicitly asked for another go: a fresh window, so the
        // bound does not trip again on the restarts that led here.
        g.restart_log.clear();
        log("supervisor: retry requested from the recovery dialog");
    }

    let exit_code = stack.server.as_ref().and_then(|c| c.try_exit_code());
    if exit_code.is_none() && pipe::probe_live() {
        sup.mark_healthy(notify);
        return;
    }

    let reason = {
        let mut g = sup.shared.lock().expect("supervisor state poisoned");
        g.unhealthy += 1;
        match decide(g.unhealthy, exit_code) {
            Action::Idle => return,
            Action::Restart { reason } => reason,
        }
    };

    // One lock, one decision: apply the rolling bound and spend a restart, so the
    // bound can never observe a half-updated window.
    let decision = {
        let mut g = sup.shared.lock().expect("supervisor state poisoned");
        restart_verdict(&mut g.restart_log, Instant::now(), &reason)
    };

    let attempt = match decision {
        Breaker::Trip(why) => {
            // Only on the transition: the monitor keeps polling in this state
            // (the operator may fix the cause at any moment), and an
            // unconditional line would write the same sentence every 2 s.
            let was_failed = {
                let g = sup.shared.lock().expect("supervisor state poisoned");
                matches!(g.state, StackState::Failed { .. })
            };
            if !was_failed {
                log(&format!("supervisor: {why}"));
                log_crash(
                    &sup,
                    "supervisor-stopped",
                    &why,
                    "supervisor",
                    exit_code,
                );
            }
            sup.publish(StackState::Failed { reason: why }, notify);
            return;
        }
        Breaker::Allow(n) => n,
    };

    sup.publish(
        StackState::Recovering {
            attempt,
            max_attempts: MAX_RESTARTS,
            reason: reason.clone(),
        },
        notify,
    );
    log(&format!(
        "supervisor: {reason} — restarting (attempt {attempt}/{MAX_RESTARTS})"
    ));
    // Every restart is a crash event and belongs in crash.log, not only the
    // final one: the file has to read as a timeline of the loop, and the tail
    // of the child's own output is what makes the root cause visible.
    log_crash(
        &sup,
        "supervisor-restart",
        &format!("attempt {attempt}/{MAX_RESTARTS}: {reason}"),
        "supervisor-restart",
        exit_code,
    );

    match restart(sup, stack, cfg, store, attempt) {
        Ok(()) => sup.mark_healthy(notify),
        Err(e) => {
            log(&format!("supervisor: restart attempt {attempt} failed — {e}"));
            log_crash(
                &sup,
                "supervisor-restart-failed",
                &format!("attempt {attempt} failed: {e}"),
                "supervisor-restart",
                None,
            );
        }
    }
}

fn restart(
    sup: &Arc<Supervisor>,
    stack: &mut DesktopStack,
    cfg: &mut BootConfig,
    store: &SecretStore,
    attempt: u32,
) -> Result<(), String> {
    let wait = backoff_for(attempt);
    if !wait.is_zero() {
        log(&format!(
            "supervisor: waiting {wait:?} before restart attempt {attempt}"
        ));
    }
    if !sleep_interruptible(wait, || sup.stopping()) {
        return Err("cancelled — the app is shutting down".into());
    }

    // Phase 1: there is no server port to re-pick. A named pipe is owned by
    // name, and the single-instance plugin already guarantees only one copy of
    // this app runs per user, so the pipe cannot be taken by a rival process.
    // Drop the dead handle before spawning: the new child must not be confused
    // with it.
    stack.server = None;

    // Same command as boot; after a FRESH boot `stack.startup` is already REUSE.
    let child = stack::spawn_server(cfg, store, &stack.startup)
        .map_err(|e| format!("could not start the local server process: {e}"))?;
    log(&format!(
        "supervisor: restart attempt {attempt} — server process {} spawned",
        child.id()
    ));
    hide_stray_console_async(child.id());
    // Installed before the wait so a concurrent `stop()` (which kills whatever
    // the stack holds) always has a handle on the live child.
    stack.server = Some(child);

    // No synthetic exit code for cancellation: Windows uses 0xFFFFFFFF for a
    // process terminated from outside this app, so a sentinel here would be
    // indistinguishable from a real crash. `stopping` is checked as its own
    // fact instead — cancellation latency is unchanged (one 100 ms poll).
    let outcome = wait_ready(
        stack::server_ready_probe(),
        || stack.server.as_ref().and_then(|c| c.try_exit_code()),
        |_| {},
        RESTART_CEILING,
    );
    if sup.stopping() {
        return Err("cancelled — the app is shutting down".into());
    }

    match outcome {
        WaitOutcome::Ready(()) => {
            log(&format!(
                "supervisor: restart attempt {attempt} is serving again on pipe {}",
                cfg.pipe_path
            ));
            Ok(())
        }
        WaitOutcome::ChildExited(code) => Err(format!(
            "the restarted server exited immediately ({})\n{}",
            exit_code_label(code),
            stack::server_failure_detail(&cfg.app_data_root)
        )),
        WaitOutcome::CeilingReached => Err(format!(
            "the restarted server never became healthy within {RESTART_CEILING:?}\n{}",
            stack::server_failure_detail(&cfg.app_data_root)
        )),
    }
}

/// What the recovery dialog renders, so the window layer never has to reach
/// into the supervisor's internals.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub state: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub reason: String,
}

impl RecoveryReport {
    pub fn of(state: &StackState) -> Self {
        match state {
            StackState::Healthy => RecoveryReport {
                state: "healthy".into(),
                attempt: 0,
                max_attempts: MAX_RESTARTS,
                reason: String::new(),
            },
            StackState::Recovering {
                attempt,
                max_attempts,
                reason,
            } => RecoveryReport {
                state: "recovering".into(),
                attempt: *attempt,
                max_attempts: *max_attempts,
                reason: reason.clone(),
            },
            StackState::Failed { reason } => RecoveryReport {
                state: "failed".into(),
                attempt: MAX_RESTARTS,
                max_attempts: MAX_RESTARTS,
                reason: reason.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Restart bound (T067/T070, OQ-2): 3 restarts per rolling 5 minutes ──
    //
    // The numbers are the specification, so they are pinned here literally
    // instead of re-using the constants (which would let the tests follow any change).

    use std::collections::VecDeque;
    const FIVE_MIN: Duration = Duration::from_secs(300);

    #[test]
    fn the_spec_is_three_restarts_per_rolling_five_minutes() {
        assert_eq!(MAX_RESTARTS, 3);
        assert_eq!(RESTART_WINDOW, FIVE_MIN);
    }

    #[test]
    fn three_restarts_inside_the_window_are_allowed_and_the_fourth_stops_the_service() {
        let t0 = Instant::now();
        let mut log = VecDeque::new();
        assert_eq!(restart_verdict(&mut log, t0, "x"), Breaker::Allow(1));
        assert_eq!(restart_verdict(&mut log, t0 + Duration::from_secs(1), "x"), Breaker::Allow(2));
        assert_eq!(restart_verdict(&mut log, t0 + Duration::from_secs(60), "x"), Breaker::Allow(3));
        let Breaker::Trip(why) = restart_verdict(&mut log, t0 + Duration::from_secs(299), "exited 1") else {
            panic!("the 4th failure inside the window must stop the service");
        };
        assert!(why.starts_with("SERVICE_STOPPED"), "{why}");
        assert!(why.contains("internal service stopped"), "{why}");
        assert!(why.contains("exited 1"), "keeps the real cause: {why}");
    }

    #[test]
    fn the_stop_message_contains_no_corruption_wording() {
        let mut log = VecDeque::new();
        let t0 = Instant::now();
        for _ in 0..3 {
            restart_verdict(&mut log, t0, "r");
        }
        let Breaker::Trip(why) = restart_verdict(&mut log, t0, "r") else { panic!() };
        let lower = why.to_lowercase();
        for word in ["corrupt", "damaged", "تلف", "تالف", "فساد", "معطوب"] {
            assert!(!lower.contains(word), "must not suggest data corruption ({word}): {why}");
        }
    }

    #[test]
    fn restarts_outside_the_window_reset_the_count() {
        let t0 = Instant::now();
        let mut log = VecDeque::new();
        for i in 0..3 {
            assert_eq!(restart_verdict(&mut log, t0 + Duration::from_secs(i), "x"), Breaker::Allow(i as u32 + 1));
        }
        // 5 minutes after the first restart it has left the window: allowed again
        assert_eq!(restart_verdict(&mut log, t0 + FIVE_MIN, "x"), Breaker::Allow(3));
        // long after everything: a full budget
        assert_eq!(restart_verdict(&mut log, t0 + FIVE_MIN * 3, "x"), Breaker::Allow(1));
    }

    #[test]
    fn a_refused_restart_spends_nothing() {
        let t0 = Instant::now();
        let mut log = VecDeque::new();
        for _ in 0..3 {
            restart_verdict(&mut log, t0, "x");
        }
        assert!(matches!(restart_verdict(&mut log, t0, "x"), Breaker::Trip(_)));
        assert_eq!(log.len(), 3, "a stop is not a restart");
    }
    #[test]
    fn a_healthy_probe_never_restarts_anything() {
        assert_eq!(decide(0, None), Action::Idle);
    }

    #[test]
    fn a_dead_process_restarts_without_waiting_for_corroboration() {
        // One strike is enough: an exited process is a fact, and the user should
        // not sit through UNHEALTHY_STRIKES of a dead page.
        assert_eq!(
            decide(1, Some(1)),
            Action::Restart {
                reason: "the local server process exited (1)".into()
            }
        );
    }

    #[test]
    fn an_external_kill_is_named_not_just_numbered() {
        // 0xFFFFFFFF is what Windows reports for a process killed from outside
        // (Task Manager, antivirus). Support needs the meaning, and this value
        // is a REAL exit code — which is exactly why cancellation is never
        // signalled by faking one.
        let label = exit_code_label(0xFFFF_FFFF);
        assert!(label.contains("terminated from outside"), "{label}");
        assert_eq!(exit_code_label(0), "0 (clean exit)");
        assert_eq!(exit_code_label(1), "1");
    }

    #[test]
    fn an_alive_but_silent_server_needs_corroboration() {
        // A single missed probe is a busy machine, not a dead app — restarting
        // (and taking the window away) here would be a false alarm.
        assert_eq!(decide(1, None), Action::Idle);
        assert_eq!(decide(UNHEALTHY_STRIKES - 1, None), Action::Idle);
        assert!(matches!(
            decide(UNHEALTHY_STRIKES, None),
            Action::Restart { .. }
        ));
    }

    #[test]
    fn backoff_is_immediate_first_then_grows_and_saturates() {
        assert_eq!(backoff_for(1), Duration::ZERO);
        assert_eq!(backoff_for(2), Duration::from_secs(2));
        assert_eq!(backoff_for(3), Duration::from_secs(4));
        assert_eq!(backoff_for(4), Duration::from_secs(8));
        // Never unbounded, never zero again: a crash loop must not spin.
        for attempt in 5..50 {
            let d = backoff_for(attempt);
            assert!(d > Duration::ZERO && d <= MAX_BACKOFF, "attempt {attempt}: {d:?}");
        }
    }

    #[test]
    fn backoff_wakes_early_when_cancelled() {
        // A shutdown must not have to sit through a 15 s backoff.
        let start = Instant::now();
        assert!(!sleep_interruptible(Duration::from_secs(30), || true));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn recovery_report_carries_the_state_the_dialog_branches_on() {
        // The window script switches on `state`; a rename that silently blanks
        // the dialog would look like "the fix does nothing".
        let json = serde_json::to_string(&RecoveryReport::of(&StackState::Failed {
            reason: "r".into(),
        }))
        .unwrap();
        assert!(json.contains("\"state\":\"failed\""), "{json}");
        assert!(json.contains("\"maxAttempts\":3"), "{json}");

        let recovering = RecoveryReport::of(&StackState::Recovering {
            attempt: 2,
            max_attempts: MAX_RESTARTS,
            reason: "boom".into(),
        });
        assert_eq!((recovering.state.as_str(), recovering.attempt), ("recovering", 2));
        assert_eq!(recovering.reason, "boom");
    }

    #[test]
    fn failure_detail_surfaces_the_servers_own_fatal_line() {
        // "port unreachable" is not actionable; the server's own message is.
        let dir = std::env::temp_dir().join("motard-supervisor-detail-test");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("server.log");
        std::fs::write(
            &log,
            "[FATAL] Server startup failed: EADDRINUSE 127.0.0.1:20001\nunrelated noise\n",
        )
        .unwrap();
        let detail = stack::server_failure_detail(&dir);
        assert!(detail.contains("EADDRINUSE"), "{detail}");
        assert!(detail.contains("unrelated noise"), "{detail}");

        std::fs::remove_file(&log).unwrap();
        let empty = stack::server_failure_detail(&dir);
        assert!(empty.contains("no [FATAL] line"), "{empty}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
