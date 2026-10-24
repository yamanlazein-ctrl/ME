//! Google Drive link, owned by the shell (OAuth 2.0 authorization code + PKCE, loopback redirect).
//!
//! - The admin enters the OAuth client of the company's Google Cloud project (a "Desktop app"
//!   client: id, and its secret when Google issued one). Stored DPAPI-sealed in
//!   `<root>\keys\google.dat` with the refresh token once connected; the WebView never sees either.
//! - Connect: a one-shot listener on 127.0.0.1:<random port> receives Google's redirect from the
//!   system browser; state (CSRF) and PKCE are checked; only the refresh token is stored.
//! - The Node backend receives short-lived ACCESS tokens only, pushed over the runtime route
//!   `POST /api/desktop/runtime/drive-token` (runtime token), on connect, before expiry and after
//!   every backend (re)start. `null` on disconnect.
//! - Nothing here logs a token, a code, a verifier or a secret; errors carry Google's error code only.

use crate::paths::Paths;
use crate::{fsutil, keys, logger};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PURPOSE: &[u8] = b"MotardERP/google/v1";
/// `drive.file`: the app sees only the files it created. `openid email` names the account.
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";
/// Push a fresh access token this long before the current one expires.
const REFRESH_MARGIN_SECS: u64 = 300;
pub const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// The company's OAuth client, injected by the RELEASE BUILD from the environment
/// (`MOTARD_GOOGLE_CLIENT_ID`, optional `MOTARD_GOOGLE_CLIENT_SECRET`). Nothing is committed to the
/// repository. A build without them has no bundled client and the advanced override is needed.
const BUNDLED_CLIENT_ID: Option<&str> = option_env!("MOTARD_GOOGLE_CLIENT_ID");
const BUNDLED_CLIENT_SECRET: Option<&str> = option_env!("MOTARD_GOOGLE_CLIENT_SECRET");

/// The OAuth client a link is made with. `Clone` only: never `Debug`, so a secret cannot be printed.
#[derive(Clone)]
pub struct ClientCreds {
    pub id: String,
    pub secret: Option<String>,
    /// "bundled" (release build) or "override" (advanced, set by the admin).
    pub source: &'static str,
}

fn bundled_from(id: Option<&str>, secret: Option<&str>) -> Option<ClientCreds> {
    let id = id?.trim();
    if id.is_empty() {
        return None;
    }
    Some(ClientCreds {
        id: id.to_string(),
        secret: secret.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        source: "bundled",
    })
}

fn bundled_creds() -> Option<ClientCreds> {
    bundled_from(BUNDLED_CLIENT_ID, BUNDLED_CLIENT_SECRET)
}

/// The client to use now: the advanced override when one is stored, otherwise the bundled one.
fn resolve_client(s: &Store, bundled: Option<ClientCreds>) -> Option<ClientCreds> {
    if !s.client_id.is_empty() {
        return Some(ClientCreds {
            id: s.client_id.clone(),
            secret: s.client_secret.clone(),
            source: "override",
        });
    }
    bundled
}

/// A link is valid only with the client it was made with (its refresh token belongs to that client).
fn link_matches(s: &Store, client: &ClientCreds) -> bool {
    match s.linked_client_id.as_deref() {
        Some(id) => id == client.id,
        // A link stored by 3.0.6, before `linked_client_id` existed, was made with the stored client
        // — the only client that version knew. Without this, the first token refresh after the
        // update unlinked every existing Google Drive connection.
        None => !s.client_id.is_empty() && s.client_id == client.id,
    }
}

#[derive(Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Store {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    email: Option<String>,
    /// The client id the refresh token was issued to. Set on connect; a different client means the
    /// link no longer applies (see `link_matches`).
    #[serde(default)]
    linked_client_id: Option<String>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GoogleStore(<redacted>)")
    }
}

struct Pending {
    listener: TcpListener,
    port: u16,
    state: String,
    verifier: String,
}

#[derive(Clone)]
struct Cached {
    access_token: String,
    expires_at: u64,
}

pub struct Google {
    paths: Paths,
    endpoints: Endpoints,
    pending: Mutex<Option<Pending>>,
    cached: Mutex<Option<Cached>>,
    /// The backend pipe the current access token was pushed to (a restarted backend has a new one).
    pushed_to: Mutex<Option<String>>,
    /// Serialises refresh/connect/disconnect so two threads never race on the store.
    busy: Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_b64url(n: usize) -> Result<String, String> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).map_err(|e| format!("random source failed: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn consent_url(endpoints: &Endpoints, client_id: &str, port: u16, state: &str, challenge: &str) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}&code_challenge={}&code_challenge_method=S256",
        endpoints.auth,
        enc(client_id),
        enc(&redirect_uri(port)),
        enc(SCOPE),
        enc(state),
        challenge
    )
}

/// `GET /?code=…&state=…` (or `?error=…`) → the code, after the CSRF state check. None for any
/// other request the browser makes on the way (favicon).
pub fn parse_redirect(request_line: &str, expected_state: &str) -> Option<Result<String, String>> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if code.is_none() && error.is_none() {
        return None;
    }
    if state.as_deref() != Some(expected_state) {
        return Some(Err("GOOGLE_STATE_MISMATCH: رد Google لا يطابق طلب الربط".into()));
    }
    if let Some(e) = error {
        return Some(Err(format!("GOOGLE_DENIED: رفض Google الربط ({e})")));
    }
    Some(Ok(code.unwrap()))
}

struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    email: Option<String>,
}

/// Google's token JSON. An error reply becomes its error CODE only (never the body: no echo).
fn parse_token_reply(status: u16, body: &str) -> Result<TokenReply, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| format!("GOOGLE_TOKEN_BAD_REPLY ({status})"))?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Err(format!("GOOGLE_TOKEN_{}", e.to_ascii_uppercase()));
    }
    let access_token = v.get("access_token").and_then(Value::as_str).ok_or("GOOGLE_TOKEN_MISSING")?.to_string();
    let email = v
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(|t| t.split('.').nth(1))
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c.get("email").and_then(Value::as_str).map(str::to_string));
    Ok(TokenReply {
        access_token,
        refresh_token: v.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        expires_in: v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600),
        email,
    })
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<(u16, String), String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS: {e}"))?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .timeout(Duration::from_secs(30))
        .build();
    match agent.post(url).send_form(form) {
        Ok(r) => Ok((r.status(), r.into_string().map_err(|e| e.to_string())?)),
        Err(ureq::Error::Status(code, r)) => Ok((code, r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("GOOGLE_UNREACHABLE: تعذّر الاتصال بـ Google ({})", e.kind())),
    }
}

fn open_in_browser(url: &str) -> Result<(), String> {
    // The WebView cannot navigate to Google; the user signs in in their own browser.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("تعذّر فتح المتصفح: {e}"))
}

impl Google {
    pub fn new(paths: Paths) -> Google {
        Google::with_endpoints(paths, Endpoints::default())
    }

    pub fn with_endpoints(paths: Paths, endpoints: Endpoints) -> Google {
        Google {
            paths,
            endpoints,
            pending: Mutex::new(None),
            cached: Mutex::new(None),
            pushed_to: Mutex::new(None),
            busy: Mutex::new(()),
        }
    }

    fn load(&self) -> Store {
        let Ok(sealed) = std::fs::read(&self.paths.google) else { return Store::default() };
        keys::dpapi::unprotect_with(&sealed, PURPOSE)
            .ok()
            .and_then(|plain| serde_json::from_slice(&plain).ok())
            .unwrap_or_else(|| {
                logger::warn("google.dat unreadable (another Windows user or damaged): Drive link must be set again");
                Store::default()
            })
    }

    fn save(&self, s: &Store) -> Result<(), String> {
        let plain = serde_json::to_vec(s).map_err(|e| e.to_string())?;
        let sealed = keys::dpapi::protect_with(&plain, PURPOSE)?;
        fsutil::atomic_write(&self.paths.google, &sealed).map_err(|e| format!("حفظ إعداد Google: {e}"))
    }

    /// The status the UI shows. `connected` only when the stored link matches the client in use.
    pub fn status(&self) -> Value {
        let s = self.load();
        let client = resolve_client(&s, bundled_creds());
        let linked = s.refresh_token.is_some()
            && client.as_ref().is_some_and(|c| link_matches(&s, c));
        json!({
            "connected": linked,
            "configured": client.is_some(),
            "source": client.as_ref().map(|c| c.source),
            "email": if linked { s.email.clone() } else { None },
            "scopes": if linked { SCOPE } else { "" },
        })
    }

    /// Advanced: set an OAuth client override. A different client invalidates the existing link.
    pub fn configure(&self, client_id: &str, client_secret: Option<&str>) -> Result<Value, String> {
        let _g = self.busy.lock().unwrap();
        let id = client_id.trim();
        if !id.ends_with(".apps.googleusercontent.com") || id.len() > 200 || id.contains(char::is_whitespace) {
            return Err("معرّف العميل (Client ID) غير صالح — يجب أن ينتهي بـ ‎.apps.googleusercontent.com".into());
        }
        let secret = client_secret.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let mut s = self.load();
        if s.client_id != id {
            s.refresh_token = None;
            s.email = None;
            s.linked_client_id = None;
            *self.cached.lock().unwrap() = None;
        }
        s.client_id = id.to_string();
        s.client_secret = secret;
        self.save(&s)?;
        Ok(self.status())
    }

    /// Bind the loopback listener, then open Google's consent page in the system browser.
    pub fn connect_start(&self, open: &dyn Fn(&str) -> Result<(), String>) -> Result<Value, String> {
        let s = self.load();
        let client = resolve_client(&s, bundled_creds())
            .ok_or("هذه النسخة لا تحتوي على ربط Google مُعدّ — تواصل مع الدعم أو أدخل معرّف العميل في الإعدادات المتقدمة")?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("تعذّر فتح منفذ الرد المحلي: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let state = random_b64url(24)?;
        let verifier = random_b64url(48)?;
        let url = consent_url(&self.endpoints, &client.id, port, &state, &pkce_challenge(&verifier));
        *self.pending.lock().unwrap() = Some(Pending { listener, port, state: state.clone(), verifier });
        open(&url)?;
        Ok(json!({ "consentUrl": url, "state": state }))
    }

    pub fn open_default(url: &str) -> Result<(), String> {
        open_in_browser(url)
    }

    /// Wait for the browser's redirect, exchange the code, store the refresh token.
    pub fn connect_finish(&self, timeout: Duration) -> Result<Value, String> {
        let pending = self.pending.lock().unwrap().take().ok_or("لم يبدأ الربط — اضغط «ربط حساب Google»")?;
        let code = wait_for_redirect(&pending, timeout)?;
        let _g = self.busy.lock().unwrap();
        let mut s = self.load();
        let client = resolve_client(&s, bundled_creds()).ok_or("لا يوجد معرّف عميل لربط Google")?;
        let redirect = redirect_uri(pending.port);
        let mut form = vec![
            ("client_id", client.id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("code_verifier", pending.verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
        ];
        if let Some(secret) = client.secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let (status, body) = post_form(&self.endpoints.token, &form)?;
        let reply = parse_token_reply(status, &body)?;
        let refresh = reply
            .refresh_token
            .ok_or("GOOGLE_NO_REFRESH_TOKEN: لم يُعد Google رمز التحديث — أعد الربط ووافق على الصلاحية")?;
        s.refresh_token = Some(refresh);
        s.email = reply.email;
        s.linked_client_id = Some(client.id.clone());
        self.save(&s)?;
        *self.cached.lock().unwrap() = Some(Cached { access_token: reply.access_token, expires_at: now() + reply.expires_in });
        *self.pushed_to.lock().unwrap() = None; // push on the next tick
        logger::info("google drive linked");
        Ok(self.status())
    }

    /// Forget the link (best-effort revoke at Google). The backend is told by the next push.
    pub fn disconnect(&self) -> Result<Value, String> {
        let _g = self.busy.lock().unwrap();
        let mut s = self.load();
        if let Some(rt) = s.refresh_token.take() {
            let _ = post_form(&self.endpoints.revoke, &[("token", rt.as_str())]);
        }
        s.email = None;
        s.linked_client_id = None;
        self.save(&s)?;
        *self.cached.lock().unwrap() = None;
        *self.pushed_to.lock().unwrap() = None;
        logger::info("google drive unlinked");
        Ok(self.status())
    }

    /// A valid access token (refreshed when it is within the margin of expiry), or None when the
    /// device is not linked. A refused refresh token (revoked at Google) unlinks the device.
    pub fn current_token(&self) -> Result<Option<(String, u64)>, String> {
        let _g = self.busy.lock().unwrap();
        let mut s = self.load();
        let Some(refresh) = s.refresh_token.clone() else { return Ok(None) };
        // A link made with a client that is no longer the one in use cannot be refreshed: unlink it.
        let client = resolve_client(&s, bundled_creds()).filter(|c| link_matches(&s, c));
        let Some(client) = client else {
            logger::warn("google link belongs to another OAuth client: link removed");
            s.refresh_token = None;
            s.email = None;
            s.linked_client_id = None;
            self.save(&s)?;
            *self.cached.lock().unwrap() = None;
            return Ok(None);
        };
        if let Some(c) = self.cached.lock().unwrap().clone() {
            if c.expires_at > now() + REFRESH_MARGIN_SECS {
                return Ok(Some((c.access_token, c.expires_at)));
            }
        }
        let mut form = vec![
            ("client_id", client.id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
        ];
        if let Some(secret) = client.secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let (status, body) = post_form(&self.endpoints.token, &form)?;
        match parse_token_reply(status, &body) {
            Ok(r) => {
                let c = Cached { access_token: r.access_token, expires_at: now() + r.expires_in };
                *self.cached.lock().unwrap() = Some(c.clone());
                Ok(Some((c.access_token, c.expires_at)))
            }
            Err(code) if code == "GOOGLE_TOKEN_INVALID_GRANT" => {
                logger::warn("google refresh token refused (revoked or expired): link removed");
                s.refresh_token = None;
                s.email = None;
                s.linked_client_id = None;
                self.save(&s)?;
                *self.cached.lock().unwrap() = None;
                Ok(None)
            }
            Err(code) => Err(code),
        }
    }

    /// One refresher tick: hand the backend on `pipe` a valid token (or `null` once unlinked) when
    /// it does not have the current one. `push` performs the HTTP call to the runtime route.
    pub fn sync_backend(&self, pipe: &str, push: &dyn Fn(Value) -> Result<(), String>) -> Result<(), String> {
        let token = self.current_token()?;
        let pushed_key = match &token {
            Some((t, _)) => format!("{pipe}|{}", fsutil::hex(&Sha256::digest(t.as_bytes()))),
            None => format!("{pipe}|none"),
        };
        if self.pushed_to.lock().unwrap().as_deref() == Some(pushed_key.as_str()) {
            return Ok(());
        }
        let body = match token {
            Some((t, exp)) => json!({ "accessToken": t, "expiresAt": exp }),
            None => json!({ "accessToken": Value::Null }),
        };
        push(body)?;
        *self.pushed_to.lock().unwrap() = Some(pushed_key);
        Ok(())
    }
}

fn wait_for_redirect(p: &Pending, timeout: Duration) -> Result<String, String> {
    p.listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match p.listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = answer(stream, &p.state) {
                    return result;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(format!("منفذ الرد المحلي: {e}")),
        }
    }
    Err("GOOGLE_TIMEOUT: انتهت مهلة الربط (5 دقائق) — أعد المحاولة".into())
}

/// Read one browser request; reply with a small Arabic page. None for unrelated requests.
fn answer(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let result = parse_redirect(&line, state);
    let (title, text) = match &result {
        Some(Ok(_)) => ("تم الربط", "تم ربط حساب Google ببرنامج موتارد. يمكنك إغلاق هذه الصفحة والعودة إلى البرنامج."),
        Some(Err(_)) => ("لم يتم الربط", "لم يكتمل ربط حساب Google. عد إلى البرنامج وأعد المحاولة."),
        None => ("", ""),
    };
    let page = format!(
        "<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"font-family:Segoe UI,Tahoma,sans-serif;text-align:center;padding:48px\"><h2>{title}</h2><p>{text}</p></body></html>"
    );
    let status = if result.is_some() { "200 OK" } else { "404 Not Found" };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn paths() -> Paths {
        let p = Paths::at(&std::env::temp_dir().join(format!("motard-google-{}", uuid::Uuid::new_v4())));
        p.ensure_dirs().unwrap();
        p
    }

    /// A fake Google token endpoint: answers each POST with the next canned reply, records bodies.
    fn fake_token_server(replies: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/token", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 16384];
                let mut got = Vec::new();
                loop {
                    let n = s.read(&mut buf).unwrap();
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if got.len() >= i + 4 + len {
                            seen2.lock().unwrap().push(text[i + 4..].to_string());
                            break;
                        }
                    }
                }
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        (url, seen)
    }

    fn id_token(email: &str) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"email":"{email}"}}"#));
        format!("h.{payload}.s")
    }

    #[test]
    fn consent_url_carries_pkce_state_and_loopback_redirect() {
        let url = consent_url(&Endpoints::default(), "abc.apps.googleusercontent.com", 5555, "st", &pkce_challenge("v"));
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5555"));
        assert!(url.contains("code_challenge_method=S256") && url.contains("access_type=offline"));
        assert!(url.contains("drive.file"));
        // S256 = base64url(sha256(verifier)), cross-checked with Node's crypto:
        // createHash("sha256").update(v).digest("base64url")
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mJ92K9DzONTlaRZr1_LC1f9r8E8FO5U2s6ZwC0bAA"), "nRkcXSimWfNgNOJxEf7G5hVSfyuQQrL8BUNB6sLEXcI");
    }

    #[test]
    fn the_redirect_is_accepted_only_with_the_right_state() {
        assert_eq!(parse_redirect("GET /?state=s1&code=c%2F1 HTTP/1.1", "s1"), Some(Ok("c/1".into())));
        assert!(matches!(parse_redirect("GET /?state=evil&code=c HTTP/1.1", "s1"), Some(Err(e)) if e.starts_with("GOOGLE_STATE_MISMATCH")));
        assert!(matches!(parse_redirect("GET /?state=s1&error=access_denied HTTP/1.1", "s1"), Some(Err(e)) if e.contains("access_denied")));
        assert_eq!(parse_redirect("GET /favicon.ico HTTP/1.1", "s1"), None);
    }

    #[test]
    fn a_token_error_never_echoes_the_reply() {
        let e = parse_token_reply(400, r#"{"error":"invalid_grant","error_description":"Token ya29.LEAK"}"#).err().unwrap();
        assert_eq!(e, "GOOGLE_TOKEN_INVALID_GRANT");
        assert!(parse_token_reply(200, "not json").is_err());
    }

    #[test]
    fn the_bundled_client_is_used_unless_an_override_is_stored() {
        let bundled = bundled_from(Some("123-rel.apps.googleusercontent.com"), Some("  GOCSPX-rel ")).unwrap();
        assert_eq!(bundled.source, "bundled");
        assert_eq!(bundled.secret.as_deref(), Some("GOCSPX-rel"), "secret is trimmed");
        assert!(bundled_from(Some("   "), None).is_none(), "a blank build value is no client");
        assert!(bundled_from(None, None).is_none(), "a build without the variable has no client");

        let none = Store::default();
        assert_eq!(resolve_client(&none, Some(bundled.clone())).unwrap().source, "bundled");
        let over = Store { client_id: "9-ovr.apps.googleusercontent.com".into(), ..Store::default() };
        let got = resolve_client(&over, Some(bundled)).unwrap();
        assert_eq!((got.source, got.id.as_str()), ("override", "9-ovr.apps.googleusercontent.com"));
        assert!(resolve_client(&none, None).is_none());
    }

    #[test]
    fn a_link_made_with_another_client_does_not_count() {
        let client = ClientCreds { id: "1-a.apps.googleusercontent.com".into(), secret: None, source: "bundled" };
        let linked = Store { linked_client_id: Some("1-a.apps.googleusercontent.com".into()), ..Store::default() };
        assert!(link_matches(&linked, &client));
        let other = Store { linked_client_id: Some("2-b.apps.googleusercontent.com".into()), ..Store::default() };
        assert!(!link_matches(&other, &client));
        assert!(!link_matches(&Store::default(), &client), "no link recorded means no match");
    }

    /// An installation linked under 3.0.6 stored no `linked_client_id`. Its link was made with the
    /// stored (override) client and must survive the update, not be removed on the first refresh.
    #[test]
    fn a_link_stored_before_the_update_still_counts() {
        let legacy = Store {
            client_id: "7-old.apps.googleusercontent.com".into(),
            refresh_token: Some("1//refresh".into()),
            ..Store::default()
        };
        let client = resolve_client(&legacy, None).expect("the stored client is the override");
        assert!(link_matches(&legacy, &client));
        // …but it is not a link to some OTHER client.
        let bundled = ClientCreds { id: "1-rel.apps.googleusercontent.com".into(), secret: None, source: "bundled" };
        assert!(!link_matches(&legacy, &bundled));
    }

    #[test]
    fn configure_validates_and_seals_the_client() {
        let p = paths();
        let g = Google::new(p.clone());
        assert!(g.configure("not a client", None).is_err());
        let st = g.configure("123-abc.apps.googleusercontent.com", Some("GOCSPX-secret")).unwrap();
        assert_eq!(st["configured"], true);
        assert_eq!(st["connected"], false);
        let raw = std::fs::read(&p.google).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("GOCSPX-secret"), "sealed, not plain");
        assert!(keys::dpapi::unprotect(&raw).is_err(), "not readable as the installation keys");
        std::fs::remove_dir_all(&p.root).ok();
    }

    #[test]
    fn full_link_flow_with_a_fake_google() {
        let p = paths();
        let (token_url, seen) = fake_token_server(vec![
            (200, format!(r#"{{"access_token":"ya29.first","refresh_token":"1//refresh","expires_in":3600,"id_token":"{}"}}"#, id_token("archive@co.sy"))),
            (200, r#"{"access_token":"ya29.second","expires_in":3600}"#.into()),
            (400, r#"{"error":"invalid_grant"}"#.into()),
        ]);
        let g = Google::with_endpoints(p.clone(), Endpoints { token: token_url, revoke: "http://127.0.0.1:9/revoke".into(), ..Endpoints::default() });
        g.configure("123-abc.apps.googleusercontent.com", Some("GOCSPX-s")).unwrap();

        // The "browser": follow the consent URL's redirect to the loopback listener.
        let opened = Arc::new(Mutex::new(String::new()));
        let o2 = opened.clone();
        let start = g.connect_start(&move |u| { *o2.lock().unwrap() = u.to_string(); Ok(()) }).unwrap();
        let url = opened.lock().unwrap().clone();
        let state = start["state"].as_str().unwrap().to_string();
        let port: u16 = url.split("127.0.0.1%3A").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET /?state={state}&code=AUTHCODE HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut page = String::new();
            let _ = s.read_to_string(&mut page);
            assert!(page.contains("200 OK") && page.contains("تم الربط"));
        });
        let st = g.connect_finish(Duration::from_secs(10)).unwrap();
        assert_eq!((st["connected"].as_bool(), st["email"].as_str()), (Some(true), Some("archive@co.sy")));
        let exchange = seen.lock().unwrap()[0].clone();
        for part in ["grant_type=authorization_code", "code=AUTHCODE", "code_verifier=", "client_secret=GOCSPX-s", "redirect_uri=http%3A%2F%2F127.0.0.1%3A"] {
            assert!(exchange.contains(part), "missing {part} in {exchange}");
        }

        // The backend gets the access token once per pipe; a restarted backend (new pipe) gets it again.
        let pushes = Arc::new(Mutex::new(Vec::<Value>::new()));
        let p2 = pushes.clone();
        let push = move |b: Value| { p2.lock().unwrap().push(b); Ok(()) };
        g.sync_backend("pipe-1", &push).unwrap();
        g.sync_backend("pipe-1", &push).unwrap();
        g.sync_backend("pipe-2", &push).unwrap();
        assert_eq!(pushes.lock().unwrap().len(), 2);
        assert_eq!(pushes.lock().unwrap()[0]["accessToken"], "ya29.first");
        assert!(!String::from_utf8_lossy(&std::fs::read(&p.google).unwrap()).contains("1//refresh"));

        // Near expiry → refresh with the stored refresh token; then Google revokes it → unlinked, null pushed.
        g.cached.lock().unwrap().as_mut().unwrap().expires_at = now() + 10;
        g.sync_backend("pipe-2", &push).unwrap();
        assert_eq!(pushes.lock().unwrap()[2]["accessToken"], "ya29.second");
        assert!(seen.lock().unwrap()[1].contains("grant_type=refresh_token") && seen.lock().unwrap()[1].contains("refresh_token=1%2F%2Frefresh"));
        g.cached.lock().unwrap().as_mut().unwrap().expires_at = now() + 10;
        g.sync_backend("pipe-2", &push).unwrap();
        assert_eq!(pushes.lock().unwrap()[3]["accessToken"], Value::Null);
        assert_eq!(g.status()["connected"], false);
        std::fs::remove_dir_all(&p.root).ok();
    }
}
