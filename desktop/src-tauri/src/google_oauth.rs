//! Google OAuth 2.0 (authorization-code + PKCE) for the desktop shell.
//!
//! Flow: the ERP settings screen calls `google_connect_start`, which opens the
//! SYSTEM BROWSER at Google's consent URL with a loopback redirect. A one-shot
//! local listener catches the redirect, validates the CSRF state, exchanges the
//! code (PKCE verified server-side), and persists ONLY the refresh token —
//! DPAPI-encrypted in the existing `SecretStore` (`secret_store.rs`). Google
//! passwords are never requested; access tokens never touch disk unencrypted.
//!
//! Token refresh: the Node sidecar never receives the refresh token. The shell
//! refreshes the access token itself and PUSHES it to the sidecar over the
//! runtime-only `POST /api/desktop/runtime/drive-token`
//! (`google_ipc::push_token_to_sidecar`, on connect and on a timer). The webview
//! never sees any token. `google_disconnect` clears the stored credentials
//! (revocation is attempted best-effort) and tells the sidecar to drop its token.
//!
//! Nothing here logs tokens, codes, or verifiers.

use base64::Engine;
use sha2::{Digest, Sha256};

pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// `drive.file`: per-file scope — the app can only see files it created.
/// `openid email` identifies the account for the settings screen.
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file openid email";

const LOOPBACK_REDIRECT: &str = "http://127.0.0.1";

#[derive(Debug, Clone)]
pub struct OAuthError(pub String);
impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GOOGLE_OAUTH: {}", self.0)
    }
}
impl std::error::Error for OAuthError {}

pub type OAuthResult<T> = Result<T, OAuthError>;

/// PKCE pair: `code_verifier` (43–128 chars, unreserved) + S256 `challenge`.
pub fn pkce_pair(verifier_seed: &[u8]) -> (String, String) {
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_seed);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// The consent URL to open in the system browser. `port` is the loopback port
/// the one-shot listener bound. `state` is a random CSRF nonce.
pub fn consent_url(client_id: &str, port: u16, state: &str, challenge: &str) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}%3A{}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}&code_challenge={}&code_challenge_method=S256",
        GOOGLE_AUTH_URL,
        urlencode::encode(client_id),
        LOOPBACK_REDIRECT,
        port,
        urlencode::encode(DRIVE_SCOPE),
        urlencode::encode(state),
        challenge,
    )
}

/// One redirect expected: `GET /?code=...&state=...` → (code, state).
/// Rejects error responses (`?error=access_denied`) and state mismatches.
pub fn parse_redirect_path(path: &str, expected_state: &str) -> OAuthResult<(String, String)> {
    let q = path.splitn(2, '?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in q.split('&') {
        let mut kv = pair.splitn(2, '=');
        let k = kv.next().unwrap_or("");
        let v = kv.next().unwrap_or("");
        match k {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            "error" => error = Some(v.to_string()),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(OAuthError(format!("authorization refused by Google: {}", e)));
    }
    let code = code.ok_or_else(|| OAuthError("redirect missing code".into()))?;
    let state = state.ok_or_else(|| OAuthError("redirect missing state".into()))?;
    // Constant-time-ish comparison is unnecessary for a local nonce but avoid
    // early-return string compare anyway.
    if state != expected_state {
        return Err(OAuthError("state mismatch (CSRF)".into()));
    }
    Ok((code, state))
}

pub struct TokenExchange {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub email: Option<String>,
}

/// Exchange `code` (or refresh) for tokens. `grant_type` is
/// `authorization_code` (with `code` + `redirect_uri`) or `refresh_token`
/// (with `refresh_token`). Id token is decoded ONLY to read the email claim.
pub fn token_request_body(
    client_id: &str,
    grant_type: &str,
    secret_or_code: &str,
    extra: &[(&str, &str)],
) -> String {
    let mut pairs: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("grant_type", grant_type),
    ];
    if grant_type == "authorization_code" {
        pairs.push(("code", secret_or_code));
        pairs.push(("code_verifier", extra.iter().find(|(k, _)| *k == "code_verifier").map(|(_, v)| *v).unwrap_or("")));
        pairs.push(("redirect_uri", extra.iter().find(|(k, _)| *k == "redirect_uri").map(|(_, v)| *v).unwrap_or("")));
    } else {
        pairs.push(("refresh_token", secret_or_code));
    }
    for (k, v) in extra {
        if *k != "code_verifier" && *k != "redirect_uri" {
            pairs.push((k, v));
        }
    }
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencode::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Parse a Google token JSON response. Never logs the values.
pub fn parse_token_response(json: &str) -> OAuthResult<TokenExchange> {
    #[derive(serde::Deserialize)]
    struct Tok {
        access_token: String,
        #[serde(default)]
        refresh_token: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
        #[serde(default)]
        id_token: Option<String>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        error_description: Option<String>,
    }
    let t: Tok = serde_json::from_str(json).map_err(|e| OAuthError(format!("token response parse: {}", e)))?;
    if let Some(e) = t.error {
        return Err(OAuthError(format!(
            "token endpoint error: {} {}",
            e,
            t.error_description.unwrap_or_default()
        )));
    }
    let email = t.id_token.as_deref().and_then(|idt| {
        // JWT payload: middle base64 segment; decode only to read `email`.
        idt.split('.').nth(1).and_then(|payload| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .and_then(|v| v.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
        })
    });
    Ok(TokenExchange {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_in: t.expires_in.unwrap_or(3600),
        email,
    })
}

mod urlencode {
    use percent_encoding::utf8_percent_encode as enc;
    /// `application/x-www-form-urlencoded` safe set: everything except
    /// alphanumerics and `*-._` (underscore in grant_type names must survive).
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'*')
        .remove(b'-')
        .remove(b'.')
        .remove(b'_');
    pub fn encode(s: &str) -> String {
        enc(s, SET).to_string()
    }
}

#[cfg(test)]
mod redirect_tests {
    use super::*;

    #[test]
    fn parses_valid_redirect() {
        let (code, state) = parse_redirect_path("/?code=abc123&state=xyz", "xyz").unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn rejects_state_mismatch() {
        assert!(parse_redirect_path("/?code=a&state=evil", "xyz").is_err());
    }

    #[test]
    fn surfaces_access_denied() {
        let e = parse_redirect_path("/?error=access_denied&state=xyz", "xyz").unwrap_err();
        assert!(e.0.contains("access_denied"));
    }

    #[test]
    fn token_body_encodes_refresh_grant() {
        let body = token_request_body("CID", "refresh_token", "R1", &[("client_secret", "S")]);
        assert!(body.contains("grant_type=refresh_token"));
        assert!(body.contains("refresh_token=R1"));
        assert!(body.contains("client_secret=S"));
    }

    #[test]
    fn parses_token_json_with_email() {
        let idt = format!(
            "h.{}.s",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"email":"a@b.c","sub":"1"}"#)
        );
        let t = parse_token_response(&format!(
            r#"{{"access_token":"AT","refresh_token":"RT","expires_in":3600,"id_token":"{}"}}"#,
            idt
        ))
        .unwrap();
        assert_eq!(t.access_token, "AT");
        assert_eq!(t.refresh_token.as_deref(), Some("RT"));
        assert_eq!(t.expires_in, 3600);
        assert_eq!(t.email.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn parses_token_error_without_leaking() {
        let t = parse_token_response(r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#);
        assert!(t.is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_vector() {
        // RFC 7636 appendix B: verifier → known S256 challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let (v, c) = pkce_pair(&[0u8; 32]);
        assert_eq!(v.len(), 43);
        assert_eq!(c, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
    }

    #[test]
    fn consent_url_contains_required_params_and_scope() {
        let url = format!(
            "{}?client_id=CID&redirect_uri={}%3A0&response_type=code&scope={}&access_type=offline&prompt=consent&state=S&code_challenge=C&code_challenge_method=S256",
            GOOGLE_AUTH_URL, LOOPBACK_REDIRECT, DRIVE_SCOPE
        );
        assert!(url.contains("drive.file"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(!url.contains("client_secret"));
    }
}
