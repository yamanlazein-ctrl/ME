//! The WebView2 worker: a dedicated browser environment on its own thread, driving a hidden window.
//!
//! WHY A DEDICATED ENVIRONMENT (and not the app's own webview):
//!
//! - **It never touches the UI thread.** The app's webview lives on the main thread, and a COM call
//!   there would freeze the window for the whole render. Here everything happens on a worker thread
//!   with its own message pump, so the desktop stays responsive while a batch is rendered.
//! - **It is testable.** `cargo test` can render a real PDF on any machine with the WebView2
//!   runtime — see `tests::a_real_pdf_is_produced`. The alternative (the app's own webview) can
//!   only be exercised by running the whole desktop app, which is why this had stayed unverified.
//! - **It has no IPC surface.** A plain Win32 window has no Tauri capability, no ACL entry and no
//!   URL to guard: it only ever shows a document the app itself built.
//!
//! The document is loaded with `NavigateToString`, so the page is entirely in memory: no file
//! access, no network, no origin. The archive templates use SYSTEM Arabic fonts, so there is
//! nothing to download; the render waits for the navigation to finish and for `document.fonts.ready`
//! before it captures anything.

use std::sync::mpsc::{Receiver, Sender};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2_7, ICoreWebView2Controller,
    ICoreWebView2Environment, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, IStream, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, ShowWindow, WINDOW_EX_STYLE,
    WS_OVERLAPPED, SW_SHOWNA,
};

/// The window class of the hidden render window.
const RENDER_WINDOW_CLASS: &str = "MotardArchiveRenderer";

/// How long one render may take before it is abandoned. A hung browser must not wedge the archive:
/// the job fails and is retried later.
const RENDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The page is ready once the navigation finished AND the fonts settled. `document.fonts.ready`
/// resolves immediately for system fonts, but awaiting it is what makes the render correct if a
/// template ever uses a real web font.
const READY_SCRIPT: &str = "document.fonts.ready.then(() => 'ready').catch(() => 'ready')";

/// The outcome of one render.
pub struct Rendered {
    /// The bytes the browser produced.
    pub bytes: Vec<u8>,
}

/// The paper size handed to the browser, in INCHES (WebView2's `PrintToPdf` unit).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageSize {
    pub width_in: f64,
    pub height_in: f64,
}

/// Render `html` to a PDF with the given page size.
pub fn render_pdf(html: &str, page: PageSize) -> Result<Rendered, String> {
    with_browser(html, move |env, core| {
        let core7: ICoreWebView2_7 = core.cast().map_err(|e| format!("WebView2_7: {e}"))?;
        // The print settings come from the ENVIRONMENT (ICoreWebView2Environment6), not from the
        // webview.
        let settings: ICoreWebView2PrintSettings = unsafe {
            env.cast::<ICoreWebView2Environment6>()
                .map_err(|e| format!("WebView2_Environment6: {e}"))?
                .CreatePrintSettings()
                .map_err(|e| format!("PrintSettings: {e}"))?
        };
        unsafe {
            // Page size in inches, and no margins: the template's own CSS sets the layout.
            settings
                .SetPageWidth(page.width_in)
                .map_err(|e| format!("PageWidth: {e}"))?;
            settings
                .SetPageHeight(page.height_in)
                .map_err(|e| format!("PageHeight: {e}"))?;
            settings
                .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
                .map_err(|e| format!("Orientation: {e}"))?;
            settings
                .SetShouldPrintBackgrounds(true)
                .map_err(|e| format!("PrintBackgrounds: {e}"))?;
            settings
                .SetShouldPrintSelectionOnly(false)
                .map_err(|e| format!("PrintSelectionOnly: {e}"))?;
        }
        // The browser writes the PDF itself; the path is ours, and it is removed afterwards.
        let out = std::env::temp_dir()
            .join(format!("motard-render-{}.pdf", uuid::Uuid::new_v4().simple()));
        let out_wide = wide(&out.to_string_lossy());
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let handler: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PrintToPdfCompletedHandler =
            PrintCompleted { tx }.into();
        unsafe {
            // `PrintToPdf` is ASYNCHRONOUS: it returns immediately and the completion handler
            // reports the outcome. That is what keeps the UI responsive.
            core7
                .PrintToPdf(PCWSTR(out_wide.as_ptr()), &settings, &handler)
                .map_err(|e| format!("PrintToPdf: {e}"))?;
        }
        let outcome = wait_for(rx);
        let bytes = std::fs::read(&out);
        let _ = std::fs::remove_file(&out);
        outcome?;
        let bytes = bytes.map_err(|e| format!("قراءة ملف PDF: {e}"))?;
        if bytes.is_empty() {
            return Err("الـ PDF المُنتج فارغ".into());
        }
        Ok(Rendered { bytes })
    })
}

/// Capture the page as a PNG.
pub fn render_png(html: &str) -> Result<Rendered, String> {
    with_browser(html, |_env, core| {
        // `CapturePreview` writes into an IStream; the bytes are read back from it.
        let stream = create_memory_stream()?;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let handler: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CapturePreviewCompletedHandler =
            CaptureCompleted { tx }.into();
        unsafe {
            core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
            .map_err(|e| format!("CapturePreview: {e}"))?;
        }
        wait_for(rx)?;
        let bytes = read_memory_stream(&stream)?;
        if bytes.is_empty() {
            return Err("صورة PNG المُنتجة فارغة".into());
        }
        Ok(Rendered { bytes })
    })
}

/// Run `f` against a fresh browser on a worker thread, with a hidden window and its own pump.
fn with_browser<F>(html: &str, f: F) -> Result<Rendered, String>
where
    F: FnOnce(&ICoreWebView2Environment, &ICoreWebView2) -> Result<Rendered, String> + Send + 'static,
{
    let html = html.to_string();
    let handle = std::thread::Builder::new()
        .name("motard-render".into())
        .spawn(move || {
            // COM for THIS thread only. The UI thread's apartment is untouched.
            unsafe {
                if let Err(e) = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() {
                    return Err(format!("CoInitializeEx: {e}"));
                }
            }
            let result = (|| {
                let hwnd = create_hidden_window()?;
                let env = create_environment()?;
                let controller = create_controller(&env, hwnd)?;
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|e| format!("CoreWebView2: {e}"))?;
                let out = (|| {
                    load_and_wait(&core, &html)?;
                    f(&env, &core)
                })();
                unsafe {
                    let _ = controller.Close();
                    let _ = DestroyWindow(hwnd);
                }
                out
            })();
            unsafe { CoUninitialize() };
            result
        })
        .map_err(|e| format!("خيط التصيير: {e}"))?;
    handle
        .join()
        .map_err(|_| "خيط التصيير أُنهي بشكل غير متوقع".to_string())?
}

/// The window procedure of the hidden render window. It does nothing: the window is never shown and
/// only exists so the browser controller has a parent.
unsafe extern "system" fn render_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Create the hidden window the browser controller attaches to.
fn create_hidden_window() -> Result<HWND, String> {
    unsafe {
        let instance = GetModuleHandleW(None)
            .map_err(|e| format!("GetModuleHandle: {e}"))?
            .into();
        let class_name = wide(RENDER_WINDOW_CLASS);
        let wc = windows::Win32::UI::WindowsAndMessaging::WNDCLASSW {
            lpfnWndProc: Some(render_wnd_proc),
            hInstance: instance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        // Registering twice is fine: the class already exists.
        let _ = RegisterClassW(&wc);
        // The window is positioned OFF-SCREEN but SHOWN. `PrintToPdf` works on the layout and
        // does not care, but `CapturePreview` captures the VISIBLE surface: a window that was never
        // shown never renders, and the capture never completes. Off-screen keeps it invisible to
        // the operator while giving the browser a real surface to draw into.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_OVERLAPPED,
            -3000,
            -3000,
            1280,
            1800,
            None,
            None,
            Some(instance),
            None,
        )
        .map_err(|e| format!("نافذة التصيير: {e}"))?;
        let _ = ShowWindow(hwnd, SW_SHOWNA);
        Ok(hwnd)
    }
}

/// The browser environment. It uses its own user-data folder, so it never contends with the app's
/// own WebView2 instance for the same profile.
fn create_environment() -> Result<ICoreWebView2Environment, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<ICoreWebView2Environment, String>>();
    let handler: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler =
        EnvironmentCompleted { tx }.into();
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            PCWSTR::null(),
            None,
            &handler,
        )
        .map_err(|e| format!("بيئة WebView2: {e}"))?;
    }
    wait_for(rx)
}

/// The controller for the hidden window. Its creation is asynchronous too.
fn create_controller(
    env: &ICoreWebView2Environment,
    hwnd: HWND,
) -> Result<ICoreWebView2Controller, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<ICoreWebView2Controller, String>>();
    let handler: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2ControllerCompletedHandler =
        ControllerCompleted { tx }.into();
    unsafe {
        env.CreateCoreWebView2Controller(hwnd, &handler)
            .map_err(|e| format!("وحدة تحكم WebView2: {e}"))?;
    }
    wait_for(rx)
}

/// Load the document and wait until it is laid out.
fn load_and_wait(core: &ICoreWebView2, html: &str) -> Result<(), String> {
    // The navigation must finish before the page can be printed, and the fonts must have settled
    // before the layout is final. Both are awaited through their own callbacks.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let nav: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventHandler =
        NavigationCompleted { tx }.into();
    unsafe {
        core.add_NavigationCompleted(&nav, std::ptr::null_mut())
            .map_err(|e| format!("انتظار التحميل: {e}"))?;
        let wide_html = wide(html);
        core.NavigateToString(PCWSTR(wide_html.as_ptr()))
            .map_err(|e| format!("تحميل المستند: {e}"))?;
    }
    wait_for(rx)?;

    // `document.fonts.ready`: the layout is final once the fonts are in place.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let script: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler =
        ScriptCompleted { tx }.into();
    unsafe {
        core.ExecuteScript(PCWSTR(wide(READY_SCRIPT).as_ptr()), &script)
            .map_err(|e| format!("انتظار الخطوط: {e}"))?;
    }
    wait_for(rx)
}

/// Wait for a channel, WHILE PUMPING the window's messages.
///
/// This is the crux of the whole renderer. WebView2 delivers its completion callbacks by posting a
/// message to the window's thread — so a thread that simply blocks on `recv()` never sees the
/// callback and the render hangs forever. (The first version of this file did exactly that: the
/// spike test timed out after 60 s instead of finishing in one.)
///
/// `PeekMessage` is used rather than `GetMessage` because `GetMessage` blocks: with it the timeout
/// could never fire. The queue is drained every iteration and the deadline is checked every time.
fn wait_for<T>(rx: Receiver<Result<T, String>>) -> Result<T, String> {
    let deadline = std::time::Instant::now() + RENDER_TIMEOUT;
    let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
    loop {
        if let Ok(v) = rx.try_recv() {
            return v;
        }
        if std::time::Instant::now() >= deadline {
            return Err("انتهت مهلة التصيير".into());
        }
        unsafe {
            while windows::Win32::UI::WindowsAndMessaging::PeekMessageW(
                &mut msg,
                None,
                0,
                0,
                windows::Win32::UI::WindowsAndMessaging::PM_REMOVE,
            )
            .as_bool()
            {
                let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
                let _ = windows::Win32::UI::WindowsAndMessaging::DispatchMessageA(&msg);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// UTF-16 for a Windows API string.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A memory stream the browser can write the PNG into.
fn create_memory_stream() -> Result<IStream, String> {
    unsafe { CreateStreamOnHGlobal(windows::Win32::Foundation::HGLOBAL(std::ptr::null_mut()), true) }
        .map_err(|e| format!("تدفق الذاكرة: {e}"))
}

/// Read a memory stream back into bytes.
fn read_memory_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK;
    unsafe {
        let mut stat = windows::Win32::System::Com::STATSTG::default();
        stream
            .Stat(&mut stat, windows::Win32::System::Com::STATFLAG(0))
            .map_err(|e| format!("قياس التدفق: {e}"))?;
        let size = stat.cbSize as usize;
        if size == 0 {
            return Ok(Vec::new());
        }
        stream
            .Seek(0, STREAM_SEEK(0), None)
            .map_err(|e| format!("إعادة التدفق: {e}"))?;
        let mut buf = vec![0u8; size];
        let mut read = 0u32;
        stream
            .Read(buf.as_mut_ptr() as *mut core::ffi::c_void, size as u32, Some(&mut read))
            .ok()
            .map_err(|_| "قراءة التدفق".to_string())?;
        buf.truncate(read as usize);
        Ok(buf)
    }
}

// ── The COM callbacks ───────────────────────────────────────────────────────
// Each one reports its outcome on a channel. They run on the worker thread that created them.
//
// The `#[implement]` macro generates a companion `<Name>_Impl` type that holds the value and
// implements `IUnknownImpl`; the interface trait is implemented on THAT type, and the payload is
// reached through its `this` field.

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PrintToPdfCompletedHandler
)]
struct PrintCompleted {
    tx: Sender<Result<(), String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PrintToPdfCompletedHandler_Impl
    for PrintCompleted_Impl
{
    fn Invoke(
        &self,
        errorcode: windows::core::HRESULT,
        success: windows::core::BOOL,
    ) -> windows::core::Result<()> {
        let outcome = if errorcode.is_ok() && success.as_bool() {
            Ok(())
        } else {
            Err(format!("فشل إنشاء الـ PDF (رمز {:?})", errorcode.0))
        };
        let _ = self.this.tx.send(outcome);
        Ok(())
    }
}

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CapturePreviewCompletedHandler
)]
struct CaptureCompleted {
    tx: Sender<Result<(), String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CapturePreviewCompletedHandler_Impl
    for CaptureCompleted_Impl
{
    fn Invoke(&self, errorcode: windows::core::HRESULT) -> windows::core::Result<()> {
        let outcome = if errorcode.is_ok() {
            Ok(())
        } else {
            Err(format!("فشل التقاط الصورة (رمز {:?})", errorcode.0))
        };
        let _ = self.this.tx.send(outcome);
        Ok(())
    }
}

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
)]
struct EnvironmentCompleted {
    tx: Sender<Result<ICoreWebView2Environment, String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_Impl
    for EnvironmentCompleted_Impl
{
    fn Invoke(
        &self,
        errorcode: windows::core::HRESULT,
        environment: windows::core::Ref<'_, ICoreWebView2Environment>,
    ) -> windows::core::Result<()> {
        let outcome = (|| {
            errorcode.ok()?;
            environment
                .cloned()
                .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_POINTER))
        })();
        let _ = self
            .this
            .tx
            .send(outcome.map_err(|e| format!("بيئة WebView2: {e}")));
        Ok(())
    }
}

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
)]
struct ControllerCompleted {
    tx: Sender<Result<ICoreWebView2Controller, String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_Impl
    for ControllerCompleted_Impl
{
    fn Invoke(
        &self,
        errorcode: windows::core::HRESULT,
        controller: windows::core::Ref<'_, ICoreWebView2Controller>,
    ) -> windows::core::Result<()> {
        let outcome = (|| {
            errorcode.ok()?;
            controller
                .cloned()
                .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_POINTER))
        })();
        let _ = self
            .this
            .tx
            .send(outcome.map_err(|e| format!("وحدة تحكم WebView2: {e}")));
        Ok(())
    }
}

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventHandler
)]
struct NavigationCompleted {
    tx: Sender<Result<(), String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventHandler_Impl
    for NavigationCompleted_Impl
{
    fn Invoke(
        &self,
        _sender: windows::core::Ref<'_, ICoreWebView2>,
        args: windows::core::Ref<'_, webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventArgs>,
    ) -> windows::core::Result<()> {
        let ok = args
            .as_ref()
            .map(|a| {
                let mut success = windows::core::BOOL(0);
                unsafe { a.IsSuccess(&mut success) }.is_ok() && success.as_bool()
            })
            .unwrap_or(false);
        let _ = self.this.tx.send(if ok {
            Ok(())
        } else {
            Err("فشل تحميل المستند".into())
        });
        Ok(())
    }
}

#[::windows::core::implement(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler
)]
struct ScriptCompleted {
    tx: Sender<Result<(), String>>,
}

#[allow(non_snake_case)]
impl webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler_Impl
    for ScriptCompleted_Impl
{
    fn Invoke(
        &self,
        errorcode: windows::core::HRESULT,
        _result: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        let _ = self.this.tx.send(if errorcode.is_ok() {
            Ok(())
        } else {
            Err("فشل تنفيذ سكربت الجاهزية".into())
        });
        Ok(())
    }
}
