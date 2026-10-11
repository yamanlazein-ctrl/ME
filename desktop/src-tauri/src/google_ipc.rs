//! Google Drive connection — Tauri IPC commands (settings screen ↔ shell).
//!
//! Owns the full connect/disconnect/refresh lifecycle on top of
//! `google_oauth.rs` + `secret_store.rs`:
//!   - `google_connect_start`: binds an ephemeral loopback listener, saves a
//!     pending-session CSRF state, and opens the consent URL in the system
//!     browser (the user just clicked "connect").
//!   - `google_connect_finish`: one-shot listener wait, state check, code
//!     exchange (PKCE), refresh token persisted DPAPI-encrypted.
//!   - `google_status`: connected/email without secrets.
//!   - `google_access_token` / `push_token_to_sidecar`: short-lived access token
//!     (cached, refreshed ~5 min before expiry) pushed to the sidecar over the
//!     runtime-only pipe endpoint. Not an IPC command: the webview never sees it.
//!   - `google_disconnect`: clears stored credentials (revocation best-effort).
//!
//! Client id: set once via `google_configure` after the owner creates the
//! Desktop OAuth client; stored in the DPAPI secret store, never compiled in.
//!
//! Nothing in this module logs tokens, codes, or verifiers.

use crate::google_oauth::{
    consent_url, parse_redirect_path, parse_token_response, token_request_body, OAuthError, GOOGLE_TOKEN_URL,
};
use crate::secret_store::{load_or_generate, persist, SecretStore};
use rand::RngCore;
use std::io::BufRead;
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Pending connect session (start → finish). Replaced on every start; a stale
/// finish (different app run) fails the state check.
#[derive(Clone)]
struct PendingConnect {
    state: String,
    verifier: String,
    port: u16,
    created: Instant,
}

impl Default for PendingConnect {
    fn default() -> Self {
        Self { state: String::new(), verifier: String::new(), port: 0, created: Instant::now() - PENDING_TTL }
    }
}

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

/// Cached access token for the sidecar worker.
#[derive(Clone, Default)]
struct CachedToken {
    token: String,
    /// UNIX seconds when a refresh is due (expires − 5 min).
    refresh_due: u64,
}

pub struct GoogleState {
    pending: Mutex<PendingConnect>,
    token: Mutex<CachedToken>,
}

impl Default for GoogleState {
    fn default() -> Self {
        Self { pending: Mutex::new(PendingConnect::default()), token: Mutex::new(CachedToken::default()) }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn oauth_err(e: OAuthError) -> String {
    // Single choke point: error strings never contain token material by
    // construction (parse errors quote only Google's error code words).
    e.to_string()
}

/// Random URL-safe state/verifier material.
fn random_material(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

#[derive(serde::Serialize)]
pub struct GoogleStatus {
    pub connected: bool,
    pub configured: bool,
    pub email: Option<String>,
    pub scopes: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")] // the frontend reads `consentUrl`
pub struct ConnectStart {
    /// URL the frontend opens in the SYSTEM browser (user-initiated only).
    pub consent_url: String,
    pub state: String,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Store the OAuth client id (owner-provided, not a secret for desktop clients).
pub fn google_configure(client_id: String) -> Result<GoogleStatus, String> {
    let mut store = load_or_generate()?;
    store.google_client_id = client_id.trim().to_string();
    persist(&store)?;
    google_status_impl(&store)
}

pub fn google_status() -> Result<GoogleStatus, String> {
    let store = load_or_generate()?;
    google_status_impl(&store)
}

fn google_status_impl(store: &SecretStore) -> Result<GoogleStatus, String> {
    Ok(GoogleStatus {
        connected: !store.google_refresh_token.is_empty(),
        configured: !store.google_client_id.is_empty(),
        email: if store.google_account_email.is_empty() { None } else { Some(store.google_account_email.clone()) },
        scopes: crate::google_oauth::DRIVE_SCOPE,
    })
}

/// Bind the loopback listener, build the consent URL and open it in the system browser. Does NOT
/// talk to Google itself.
pub fn google_connect_start(state: &GoogleState) -> Result<ConnectStart, String> {
    let store = load_or_generate()?;
    if store.google_client_id.is_empty() {
        return Err("GOOGLE_NOT_CONFIGURED: client id مفقود — أعدّه من إعدادات النظام أولًا".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("GOOGLE_LOOPBACK_BIND: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let csrf = random_material(24);
    let (verifier, challenge) = crate::google_oauth::pkce_pair(&random_material(32).into_bytes());
    let url = consent_url(&store.google_client_id, port, &csrf, &challenge);
    *state.pending.lock().expect("google pending") =
        PendingConnect { state: csrf.clone(), verifier, port, created: Instant::now() };
    park_listener(port, listener);
    // The user just clicked "connect": open Google's consent page in the SYSTEM browser. The webview
    // cannot do it — its navigation guard refuses every non-app URL.
    open_in_browser(&url);
    Ok(ConnectStart { consent_url: url, state: csrf })
}

/// Wait (bounded) for the one-shot loopback redirect, validate state + PKCE,
/// exchange the code, persist the refresh token. Called right after the
/// browser returns; the listener from `google_connect_start` is consumed here.
///
/// The listener handle is stored WITH the pending session via a process-wide
/// slot so `finish` owns it (the command boundary cannot pass a TcpListener).
pub fn google_connect_finish(state: &GoogleState) -> Result<GoogleStatus, String> {
    let store = load_or_generate()?;
    if store.google_client_id.is_empty() {
        return Err("GOOGLE_NOT_CONFIGURED".into());
    }
    let pending = {
        let mut p = state.pending.lock().expect("google pending");
        if p.state.is_empty() || p.created.elapsed() > PENDING_TTL {
            return Err("GOOGLE_CONNECT_EXPIRED: ابدأ الاتصال من جديد".into());
        }
        std::mem::take(&mut *p)
    };

    // The start command parked the listener under the pending port; consume it.
    let listener = take_parked_listener(pending.port)
        .ok_or_else(|| "GOOGLE_LISTENER_LOST: أعد بدء الاتصال من جديد".to_string())?;

    // One request, bounded wait (5 min for the user to finish consent).
    let (code, _state_ok) = {
        let accepted = with_timeout(&listener, Duration::from_secs(5 * 60))?;
        let mut stream = accepted;
        let mut reader = std::io::BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).map_err(|e| format!("GOOGLE_REDIRECT_READ: {e}"))?;
        // Consume headers (bounded) then answer the browser.
        let mut header_line = String::new();
        for _ in 0..64 {
            header_line.clear();
            if reader.read_line(&mut header_line).is_err() || header_line.trim().is_empty() {
                break;
            }
        }
        let _ = std::io::Write::write_all(
            &mut stream,
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/html; charset=utf-8\r\n",
                "Connection: close\r\n\r\n",
                "<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\">",
                "<body style=\"font-family:Segoe UI,sans-serif;text-align:center;padding:3rem\">",
                "<h2>&#x2705; \u{62a}\u{645} \u{631}\u{628}\u{637} Google \u{628}\u{646}\u{62c}\u{627}\u{62d}</h2>",
                "<p>\u{64a}\u{645}\u{643}\u{646}\u{643} \u{625}\u{63a}\u{644}\u{627}\u{642} \u{647}\u{630}\u{647} \u{627}\u{644}\u{646}\u{627}\u{641}\u{630}\u{629} \u{648}\u{627}\u{644}\u{639}\u{648}\u{62f}\u{629} \u{625}\u{644}\u{649} Motard ERP.</p></body></html>",
            )
            .as_bytes(),
        );
        let path = request_line.split_whitespace().nth(1).unwrap_or("").to_string();
        parse_redirect_path(&path, &pending.state).map_err(oauth_err)?
    };

    // Exchange the authorization code (PKCE verifier) for tokens.
    let body = token_request_body(
        &store.google_client_id,
        "authorization_code",
        &code,
        &[
            ("code_verifier", &pending.verifier),
            ("redirect_uri", &format!("http://127.0.0.1:{}", pending.port)),
        ],
    );
    let exchange = http_post_token(&body)?;
    let refresh = exchange
        .refresh_token
        .clone()
        .ok_or_else(|| "GOOGLE_NO_REFRESH: لم يُعد Google refresh token — تأكد من نشر شاشة الموافقة".to_string())?;

    let mut store = load_or_generate()?;
    store.google_refresh_token = refresh;
    store.google_account_email = exchange.email.unwrap_or_default();
    persist(&store)?;

    // Prime the token cache so the worker can start immediately.
    let due = now_secs() + exchange.expires_in.saturating_sub(300);
    *state.token.lock().expect("google token") = CachedToken { token: exchange.access_token, refresh_due: due };
    // Hand the sidecar its first token now, so archiving starts without waiting for the pusher.
    let _ = push_token_to_sidecar(state);

    google_status_impl(&store)
}

/// Short-lived access token for the sidecar worker. Refreshes from Google when
/// within 5 minutes of expiry. Returns ONLY the access token + expiry — the
/// refresh token never leaves the shell.
#[derive(serde::Serialize)]
pub struct AccessTokenDelivery {
    pub access_token: String,
    /// UNIX seconds the token stops being trusted by the worker.
    pub expires_at: u64,
    pub email: String,
}

pub fn google_access_token(state: &GoogleState) -> Result<AccessTokenDelivery, String> {
    let store = load_or_generate()?;
    if store.google_refresh_token.is_empty() {
        return Err("GOOGLE_NOT_CONNECTED".into());
    }
    let now = now_secs();
    {
        let cached = state.token.lock().expect("google token");
        if !cached.token.is_empty() && now < cached.refresh_due {
            return Ok(AccessTokenDelivery {
                access_token: cached.token.clone(),
                expires_at: cached.refresh_due,
                email: store.google_account_email.clone(),
            });
        }
    }
    // Refresh.
    let body = token_request_body(&store.google_client_id, "refresh_token", &store.google_refresh_token, &[]);
    let exchange = http_post_token(&body)?;
    let due = now_secs() + exchange.expires_in.saturating_sub(300);
    *state.token.lock().expect("google token") =
        CachedToken { token: exchange.access_token.clone(), refresh_due: due };
    Ok(AccessTokenDelivery { access_token: exchange.access_token, expires_at: due, email: store.google_account_email })
}

/// Clear stored credentials (and the token cache). Revocation at Google is
/// best-effort: even if it fails, the local state is disconnected and the
/// refresh token is gone.
pub fn google_disconnect(state: &GoogleState) -> Result<GoogleStatus, String> {
    let mut store = load_or_generate()?;
    let refresh = std::mem::take(&mut store.google_refresh_token);
    store.google_account_email.clear();
    persist(&store)?;
    *state.token.lock().expect("google token") = CachedToken::default();
    *state.pending.lock().expect("google pending") = PendingConnect::default();
    let _ = push_token_to_sidecar(state); // not connected any more → the sidecar drops its token
    if !refresh.is_empty() {
        // RFC 7009 revocation — best-effort; local disconnect regardless.
        let _ = http_post_token(&format!("token={}&client_id={}", urlencode(&refresh), urlencode(&store.google_client_id)));
    }
    google_status_impl(&store)
}

// ── Token bridge to the sidecar (audit D-01) ────────────────────────────────

/// Push the current access token (or `null` when disconnected) to the sidecar over the runtime-only
/// `POST /api/desktop/runtime/drive-token`. The refresh token never leaves the shell. Returns how long
/// to wait before the next push: shortly before the token's refresh is due, at most 5 minutes (so a
/// restarted sidecar is re-fed quickly), 30 s after a failure.
pub fn push_token_to_sidecar(state: &GoogleState) -> Duration {
    let (body, wait) = match google_access_token(state) {
        Ok(t) => {
            // `expires_at` is the refresh-due mark; Google honours the token 5 more minutes.
            let body = serde_json::json!({ "accessToken": t.access_token, "expiresAt": t.expires_at + 300 });
            (body, Duration::from_secs(t.expires_at.saturating_sub(now_secs()).clamp(30, 300)))
        }
        Err(e) if e == "GOOGLE_NOT_CONNECTED" => (serde_json::json!({ "accessToken": null }), Duration::from_secs(300)),
        Err(_) => return Duration::from_secs(30), // refresh failed (offline?) — retry soon
    };
    let Ok(token) = crate::secret_store::runtime_token() else { return Duration::from_secs(30) };
    let mut headers = std::collections::HashMap::new();
    headers.insert("x-motard-runtime-token".to_string(), token);
    headers.insert("content-type".to_string(), "application/json".to_string());
    let res = crate::runtime::pipe_request(&crate::runtime::PipeRequest {
        method: "POST".into(),
        path: "/api/desktop/runtime/drive-token".into(),
        body: Some(body.to_string()),
        headers: Some(headers),
    });
    if res.status == 200 { wait } else { Duration::from_secs(30) }
}

// ── Internals ───────────────────────────────────────────────────────────────

/// Open `url` in the user's default browser (ShellExecuteW "open").
#[cfg(windows)]
fn open_in_browser(url: &str) {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // SAFETY: plain Win32 call with owned, NUL-terminated wide strings.
    unsafe {
        let _ = ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL);
    }
}

#[cfg(not(windows))]
fn open_in_browser(_url: &str) {}

fn urlencode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Park the connect listener in a process-wide slot (start → finish handoff).
static LISTENER_SLOT: Mutex<Option<(u16, TcpListener)>> = Mutex::new(None);

fn park_listener(port: u16, l: TcpListener) {
    *LISTENER_SLOT.lock().expect("listener slot") = Some((port, l));
}

fn take_parked_listener(port: u16) -> Option<TcpListener> {
    let mut slot = LISTENER_SLOT.lock().expect("listener slot");
    if slot.as_ref().map(|(p, _)| *p) == Some(port) {
        slot.take().map(|(_, l)| l)
    } else {
        None
    }
}

/// Bounded accept: poll nonblocking accept with sleeps so a user who never
/// completes consent cannot wedge the finish call forever.
fn with_timeout(listener: &TcpListener, budget: Duration) -> Result<std::net::TcpStream, String> {
    let start = Instant::now();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                return Ok(stream);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if start.elapsed() > budget {
                    return Err("GOOGLE_CONNECT_TIMEOUT: لم يكتمل تفويض Google في الوقت المحدد".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("GOOGLE_ACCEPT: {e}")),
        }
    }
}

/// Synchronous POST to the Google token endpoint. `reqwest` blocking client
/// (the shell is not async; commands run on a worker pool).
fn http_post_token(form: &str) -> Result<crate::google_oauth::TokenExchange, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("GOOGLE_HTTP: {e}"))?;
    let res = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form.to_string())
        .send()
        .map_err(|e| format!("GOOGLE_HTTP: {}", e))?;
    let text = res.text().map_err(|e| format!("GOOGLE_HTTP: {e}"))?;
    parse_token_response(&text).map_err(oauth_err)
}

use base64::Engine as _;
