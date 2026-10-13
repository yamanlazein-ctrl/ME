//! Startup sequence, supervision, recovery actions and shutdown (ADR-001).

use crate::backend::{self, Backend, Spawn};
use crate::keys::{self, KeyOutcome, Secrets};
use crate::paths::Paths;
use crate::state::{self, Decision};
use crate::{logger, pipe};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const CONFIRM_START_NEW: &str = "بدء شركة جديدة";
const CONFIRM_RESET_KEYS: &str = "إعادة تعيين المفاتيح";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BootStatus {
    /// "starting" | "ready" | "recovery"
    pub phase: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub step: String,
    pub pre_update_available: bool,
    pub data_root: String,
    pub app_version: String,
}

pub struct Running {
    pub backend: Backend,
    pub token: String,
}

pub struct Shared {
    pub paths: Paths,
    pub resources: PathBuf,
    pub status: Mutex<BootStatus>,
    pub running: Mutex<Option<Running>>,
    pub secrets: Mutex<Option<Secrets>>,
    crashes: Mutex<Vec<Instant>>,
    pending_restore: Mutex<Option<PathBuf>>,
    pub stopping: AtomicBool,
    booting: AtomicBool,
}

impl Shared {
    pub fn new(paths: Paths, resources: PathBuf) -> Arc<Shared> {
        let status = BootStatus {
            phase: "starting".into(),
            step: "بدء التشغيل".into(),
            data_root: paths.root.display().to_string(),
            app_version: APP_VERSION.into(),
            ..Default::default()
        };
        Arc::new(Shared {
            paths,
            resources,
            status: Mutex::new(status),
            running: Mutex::new(None),
            secrets: Mutex::new(None),
            crashes: Mutex::new(Vec::new()),
            pending_restore: Mutex::new(None),
            stopping: AtomicBool::new(false),
            booting: AtomicBool::new(false),
        })
    }

    pub fn pipe(&self) -> Option<String> {
        self.running.lock().unwrap().as_ref().map(|r| r.backend.pipe.clone())
    }

    fn step(&self, s: &str) {
        let mut st = self.status.lock().unwrap();
        st.phase = "starting".into();
        st.code = None;
        st.detail = None;
        st.step = s.into();
    }

    fn recovery(&self, code: &str, detail: impl Into<String>) {
        let detail = detail.into();
        logger::error(&format!("recovery {code}: {detail}"));
        let mut st = self.status.lock().unwrap();
        st.phase = "recovery".into();
        st.code = Some(code.into());
        st.detail = Some(detail);
        st.pre_update_available = state::latest_pre_update(&self.paths).is_some();
    }
}

/// Run the startup sequence on a worker thread (the window shows `boot.html` meanwhile).
pub fn start(app: AppHandle, sh: Arc<Shared>) {
    if sh.booting.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        sh.stopping.store(false, Ordering::SeqCst);
        if let Err((code, detail)) = run(&sh) {
            sh.recovery(&code, detail);
            show_boot_page(&app);
        } else {
            supervise(app.clone(), sh.clone());
        }
        sh.booting.store(false, Ordering::SeqCst);
    });
}

type BootErr = (String, String);
fn err(code: &str, detail: impl ToString) -> BootErr {
    (code.to_string(), detail.to_string())
}

fn run(sh: &Shared) -> Result<(), BootErr> {
    let p = &sh.paths;
    p.ensure_dirs().map_err(|e| err("DATA_ROOT_UNWRITABLE", e))?;

    if p.reset_request.exists() {
        sh.step("نقل بيانات الشركة الحالية جانباً");
        let dir = state::set_aside_company(p, "factory-reset").map_err(|e| err("SET_ASIDE_FAILED", e))?;
        let _ = std::fs::remove_file(&p.reset_request);
        logger::info(&format!("factory reset: previous data kept in {}", dir.display()));
    }

    sh.step("فتح مفاتيح التثبيت");
    let secrets = match keys::load_or_create(p, state::data_exists(p)).map_err(|e| err("KEYS_ERROR", e))? {
        KeyOutcome::Loaded(s) => s,
        KeyOutcome::Created(s) => {
            logger::info("first install: new installation keys created");
            s
        }
        KeyOutcome::Recovery(problem) => {
            return Err(err(problem.code(), "ملف المفاتيح مفقود أو تالف بينما توجد بيانات. لم يُنشأ مفتاح بديل."))
        }
    };

    sh.step("فحص قاعدة البيانات");
    let (startup_state, mut install, expected) = match state::decide(p) {
        Decision::Fresh(i) => {
            state::write_install(p, &i).map_err(|e| err("DATA_ROOT_UNWRITABLE", e))?;
            ("FRESH", i, None)
        }
        Decision::Reuse { install, expected_data_id } => ("REUSE", install, expected_data_id),
        Decision::DataMissing => {
            return Err(err("DATA_MISSING", format!("لا توجد قاعدة البيانات في {}", p.db.display())))
        }
    };

    if startup_state == "REUSE" && install.last_app_version.as_deref() != Some(APP_VERSION) {
        sh.step("نسخ احتياطي قبل التحديث");
        let from = install.last_app_version.clone().unwrap_or_else(|| "unknown".into());
        let dir = state::pre_update_copy(p, &from, APP_VERSION).map_err(|e| err("PRE_UPDATE_COPY_FAILED", e))?;
        logger::info(&format!("pre-update copy {from} -> {APP_VERSION} verified at {}", dir.display()));
    }

    sh.step(if startup_state == "FRESH" { "إنشاء قاعدة بيانات الشركة" } else { "تشغيل الخادم المحلي" });
    let restore = sh.pending_restore.lock().unwrap().take();
    let spawn = Spawn {
        resources: &sh.resources,
        paths: p,
        secrets: &secrets,
        startup_state,
        install: &install,
        expected_data_id: expected.as_deref(),
        restore_archive: restore.as_deref(),
        app_version: APP_VERSION,
    };
    let mut be = backend::spawn(&spawn).map_err(|e| err("BACKEND_START_FAILED", e))?;

    wait_healthy(&mut be).map_err(|(code, detail)| {
        let _ = be.child.kill();
        (code, detail)
    })?;

    install = state::mark_ready(p, &install, APP_VERSION).map_err(|e| err("DATA_ROOT_UNWRITABLE", e))?;
    logger::info(&format!("ready state={startup_state} data={}", install.data_id));
    let token = secrets.runtime_token();
    *sh.secrets.lock().unwrap() = Some(secrets);
    *sh.running.lock().unwrap() = Some(Running { backend: be, token });
    let mut st = sh.status.lock().unwrap();
    st.phase = "ready".into();
    st.code = None;
    st.detail = None;
    Ok(())
}

fn wait_healthy(be: &mut Backend) -> Result<(), BootErr> {
    // Migrating or restoring a large company can take minutes; the process is watched the whole time.
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
    while Instant::now() < deadline {
        if let Ok(Some(code)) = be.child.try_wait() {
            std::thread::sleep(Duration::from_millis(300)); // let the tee threads read the last lines
            let reason = be.fatal.lock().unwrap().clone().unwrap_or_else(|| format!("exit {code}"));
            return Err((backend::classify(&reason).to_string(), reason));
        }
        let ok = tauri::async_runtime::block_on(pipe::request(
            &be.pipe, "GET", "/api/health/live", &[], b"", Duration::from_secs(3),
        ))
        .map(|r| r.status == 200)
        .unwrap_or(false);
        if ok {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(err("BOOT_TIMEOUT", "الخادم المحلي لم يستجب خلال 15 دقيقة"))
}

/// Restart a backend that died after a healthy boot; three deaths in five minutes stop the loop.
fn supervise(app: AppHandle, sh: Arc<Shared>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if sh.stopping.load(Ordering::SeqCst) {
            return;
        }
        let exited = {
            let mut r = sh.running.lock().unwrap();
            match r.as_mut().map(|x| x.backend.child.try_wait()) {
                Some(Ok(Some(code))) => {
                    *r = None;
                    Some(code)
                }
                None => return,
                _ => None,
            }
        };
        let Some(code) = exited else { continue };
        logger::error(&format!("backend exited unexpectedly ({code})"));
        let mut crashes = sh.crashes.lock().unwrap();
        crashes.retain(|t| t.elapsed() < Duration::from_secs(300));
        crashes.push(Instant::now());
        if crashes.len() >= 3 {
            drop(crashes);
            sh.recovery("SERVICE_STOPPED", "توقف الخادم المحلي ثلاث مرات خلال خمس دقائق");
            show_boot_page(&app);
            return;
        }
        drop(crashes);
        start(app.clone(), sh.clone());
        return;
    });
}

pub fn show_boot_page(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("if (!location.pathname.endsWith('boot.html')) location.replace('/boot.html')");
    }
}

/// Window close / Windows shutdown: finish in-flight writes, checkpoint the WAL, then stop.
pub fn shutdown(sh: &Shared) {
    sh.stopping.store(true, Ordering::SeqCst);
    let Some(mut r) = sh.running.lock().unwrap().take() else { return };
    let headers = vec![("X-Motard-Runtime-Token".to_string(), r.token.clone())];
    let _ = tauri::async_runtime::block_on(pipe::request(
        &r.backend.pipe, "POST", "/api/desktop/runtime/shutdown", &headers, b"", Duration::from_secs(15),
    ));
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = r.backend.child.try_wait() {
            logger::info("backend stopped cleanly");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    logger::warn("backend did not stop in 15 s; killed");
    let _ = r.backend.child.kill();
}

/// Recovery-screen actions. Destructive ones need the exact typed phrase.
pub fn action(app: &AppHandle, sh: &Arc<Shared>, name: &str, confirm: Option<&str>) -> Result<String, String> {
    let in_recovery = sh.status.lock().unwrap().phase == "recovery";
    let p = &sh.paths;
    match name {
        "open_logs" => {
            let _ = std::process::Command::new("explorer").arg(&p.logs).spawn();
            return Ok("ok".into());
        }
        "exit" => {
            shutdown(sh);
            app.exit(0);
            return Ok("ok".into());
        }
        _ if !in_recovery => return Err("هذا الإجراء متاح من شاشة الاستعادة فقط".into()),
        "retry" => {}
        "restore_pre_update" => {
            let m = state::restore_pre_update(p)?;
            logger::info(&format!("rolled back to the pre-update copy of {}", m.from_version));
        }
        "restore_backup" => {
            let Some(file) = rfd::FileDialog::new()
                .set_title("اختر ملف النسخة الاحتياطية")
                .add_filter("نسخة موتارد", &["zip"])
                .pick_file()
            else {
                return Ok("cancelled".into());
            };
            let dir = state::set_aside_company(p, "before-restore")?;
            logger::info(&format!("restore: previous data kept in {}", dir.display()));
            *sh.pending_restore.lock().unwrap() = Some(file);
        }
        "start_new" => {
            if confirm != Some(CONFIRM_START_NEW) {
                return Err(format!("اكتب «{CONFIRM_START_NEW}» للتأكيد"));
            }
            let dir = state::set_aside_company(p, "start-new")?;
            logger::info(&format!("start new: previous data kept in {}", dir.display()));
        }
        "reset_keys" => {
            if confirm != Some(CONFIRM_RESET_KEYS) {
                return Err(format!("اكتب «{CONFIRM_RESET_KEYS}» للتأكيد"));
            }
            keys::reset(p)?;
            logger::warn("installation keys reset by the operator; old files set aside");
        }
        other => return Err(format!("إجراء غير معروف: {other}")),
    }
    *sh.crashes.lock().unwrap() = Vec::new();
    sh.step("إعادة المحاولة");
    start(app.clone(), sh.clone());
    Ok("started".into())
}

/// Factory reset without closing the app: stop, move the company aside, boot an empty root.
pub fn factory_reset_now(app: &AppHandle, sh: &Arc<Shared>) -> Result<(), String> {
    shutdown(sh);
    let dir = state::set_aside_company(&sh.paths, "factory-reset")?;
    logger::info(&format!("factory reset: previous data kept in {}", dir.display()));
    sh.step("بدء شركة جديدة");
    show_boot_page(app);
    start(app.clone(), sh.clone());
    Ok(())
}

/// Exclusive lock on `<root>\motard.lock` for the life of the process (a second shell build or a
/// copied EXE cannot open the same database).
pub fn lock_data_root(paths: &Paths) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::create_dir_all(&paths.root).map_err(|e| e.to_string())?;
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(&paths.lock_file)
        .map_err(|e| format!("{e}"))?;
    Ok(f)
}
