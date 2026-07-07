//! Interactive OAuth 2.0 (loopback redirect + PKCE) for read-only Google
//! Calendar and Microsoft Graph access. Tokens live in the OS keychain.
//!
//! Client IDs are read from env vars (`NOVALIS_GOOGLE_CLIENT_ID`,
//! `NOVALIS_MS_CLIENT_ID`) so this open-source binary ships no secrets. PKCE
//! means no client secret is needed (the loopback flow for installed apps).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use novalis_core::models::CalendarEvent;

use crate::engine::CommandError;

pub(crate) const KEYRING_SERVICE: &str = "app.novalis";

struct Provider {
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    client_id_env: &'static str,
    extra_auth: &'static [(&'static str, &'static str)],
}

fn provider(id: &str) -> Option<Provider> {
    match id {
        "google" => Some(Provider {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scope: "https://www.googleapis.com/auth/calendar.readonly",
            client_id_env: "NOVALIS_GOOGLE_CLIENT_ID",
            extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "outlook" => Some(Provider {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "Calendars.Read offline_access",
            client_id_env: "NOVALIS_MS_CLIENT_ID",
            extra_auth: &[],
        }),
        _ => None,
    }
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    access: String,
    refresh: Option<String>,
    /// Unix epoch seconds when the access token expires.
    expiry: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn kerr(e: keyring::Error) -> CommandError {
    CommandError::internal(format!("keychain error: {e}"))
}

fn entry(provider_id: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("oauth:{provider_id}")).map_err(kerr)
}

fn store_tokens(provider_id: &str, t: &Tokens) -> Result<(), CommandError> {
    let json = serde_json::to_string(t).map_err(|e| CommandError::internal(e.to_string()))?;
    entry(provider_id)?.set_password(&json).map_err(kerr)
}

fn load_tokens(provider_id: &str) -> Option<Tokens> {
    let json = entry(provider_id).ok()?.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn is_connected(provider_id: &str) -> bool {
    load_tokens(provider_id).is_some()
}

pub fn disconnect(provider_id: &str) -> Result<(), CommandError> {
    if let Ok(e) = entry(provider_id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

fn client_id(p: &Provider) -> Result<String, CommandError> {
    std::env::var(p.client_id_env).map_err(|_| CommandError {
        kind: "oauthConfig".to_string(),
        message: format!(
            "{} is not set. Register an OAuth client (desktop/loopback) and set this env var.",
            p.client_id_env
        ),
    })
}

fn pkce() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn tokens_from_resp(
    resp: &serde_json::Value,
    prev_refresh: Option<String>,
) -> Result<Tokens, CommandError> {
    let access = resp
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            // Never echo the raw provider response to the frontend; log the
            // provider's error code (not the body) for diagnosis.
            let code = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            log::warn!("oauth token endpoint returned no access_token (error: {code})");
            CommandError::internal("token endpoint returned no access token")
        })?
        .to_string();
    let refresh = resp
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(prev_refresh);
    let expires_in = resp
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    Ok(Tokens {
        access,
        refresh,
        expiry: now() + expires_in,
    })
}

/// Run the interactive flow: open the system browser, capture the loopback
/// redirect, exchange the code, and store tokens. Blocks until the user
/// completes (or a timeout).
pub fn connect(app: &tauri::AppHandle, provider_id: &str) -> Result<(), CommandError> {
    let p = provider(provider_id).ok_or_else(|| CommandError::internal("unknown provider"))?;
    let client_id = client_id(&p)?;

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| CommandError::internal(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| CommandError::internal(e.to_string()))?
        .port();
    let redirect = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce();
    let state = uuid::Uuid::new_v4().to_string();

    let mut url = reqwest::Url::parse_with_params(
        p.auth_url,
        &[
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("scope", p.scope),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
        ],
    )
    .map_err(|e| CommandError::internal(e.to_string()))?;
    {
        let mut qp = url.query_pairs_mut();
        for (k, v) in p.extra_auth {
            qp.append_pair(k, v);
        }
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| CommandError::internal(format!("could not open browser: {e}")))?;

    let code = wait_for_code(&listener, &state)?;
    let tokens = exchange_code(&p, &client_id, &redirect, &code, &verifier)?;
    store_tokens(provider_id, &tokens)
}

fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, CommandError> {
    listener
        .set_nonblocking(true)
        .map_err(|e| CommandError::internal(e.to_string()))?;
    let deadline = Instant::now() + Duration::from_secs(180);

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                let mut buf = [0u8; 8192];
                let n = stream
                    .read(&mut buf)
                    .map_err(|e| CommandError::internal(e.to_string()))?;
                let req = String::from_utf8_lossy(&buf[..n]);
                let target = req
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/");

                let body = "<html><body style=\"font-family:system-ui;padding:3rem;text-align:center\"><h2>Connected to Novalis</h2><p>You can close this window.</p></body></html>";
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                );

                let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
                    .map_err(|e| CommandError::internal(e.to_string()))?;
                let params: HashMap<String, String> = url.query_pairs().into_owned().collect();

                if let Some(err) = params.get("error") {
                    return Err(CommandError {
                        kind: "oauthDenied".to_string(),
                        message: err.clone(),
                    });
                }
                if params.get("state").map(String::as_str) != Some(expected_state) {
                    return Err(CommandError::internal("OAuth state mismatch"));
                }
                return params
                    .get("code")
                    .cloned()
                    .ok_or_else(|| CommandError::internal("no authorization code in redirect"));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(CommandError {
                        kind: "oauthTimeout".to_string(),
                        message: "Timed out waiting for authorization".to_string(),
                    });
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(CommandError::internal(e.to_string())),
        }
    }
}

fn exchange_code(
    p: &Provider,
    client_id: &str,
    redirect: &str,
    code: &str,
    verifier: &str,
) -> Result<Tokens, CommandError> {
    let resp: serde_json::Value = reqwest::blocking::Client::new()
        .post(p.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("code_verifier", verifier),
        ])
        .send()
        .and_then(|r| r.json())
        .map_err(|e| CommandError::internal(format!("token exchange failed: {e}")))?;
    tokens_from_resp(&resp, None)
}

/// A valid access token, refreshing if the stored one is near expiry.
fn access_token(provider_id: &str) -> Result<String, CommandError> {
    let p = provider(provider_id).ok_or_else(|| CommandError::internal("unknown provider"))?;
    let t = load_tokens(provider_id).ok_or_else(|| CommandError {
        kind: "notConnected".to_string(),
        message: format!("{provider_id} is not connected"),
    })?;
    if t.expiry > now() + 60 {
        return Ok(t.access);
    }
    let refresh = t.refresh.clone().ok_or_else(|| CommandError {
        kind: "notConnected".to_string(),
        message: "no refresh token; please reconnect".to_string(),
    })?;
    let client_id = client_id(&p)?;
    let resp: serde_json::Value = reqwest::blocking::Client::new()
        .post(p.token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .and_then(|r| r.json())
        .map_err(|e| CommandError::internal(format!("token refresh failed: {e}")))?;
    let refreshed = tokens_from_resp(&resp, Some(refresh))?;
    store_tokens(provider_id, &refreshed)?;
    Ok(refreshed.access)
}

/// Fetch concrete event occurrences from the provider over `[start, end]`
/// (`YYYY-MM-DD`), tagged with `source_id`.
pub fn fetch_events(
    provider_id: &str,
    source_id: &str,
    start: &str,
    end: &str,
) -> Result<Vec<CalendarEvent>, CommandError> {
    let token = access_token(provider_id)?;
    let client = reqwest::blocking::Client::new();
    match provider_id {
        "google" => {
            let url = format!(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin={start}T00:00:00Z&timeMax={end}T23:59:59Z&maxResults=2500"
            );
            let resp: serde_json::Value = client
                .get(url)
                .bearer_auth(token)
                .send()
                .and_then(|r| r.json())
                .map_err(|e| CommandError::internal(format!("Google fetch failed: {e}")))?;
            Ok(novalis_core::calendar::remote::parse_google_events(
                &resp, source_id,
            ))
        }
        "outlook" => {
            let url = format!(
                "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime={start}T00:00:00Z&endDateTime={end}T23:59:59Z&$top=1000"
            );
            let resp: serde_json::Value = client
                .get(url)
                .bearer_auth(token)
                .send()
                .and_then(|r| r.json())
                .map_err(|e| {
                    CommandError::internal(format!("Microsoft Graph fetch failed: {e}"))
                })?;
            Ok(novalis_core::calendar::remote::parse_ms_events(
                &resp, source_id,
            ))
        }
        _ => Err(CommandError::internal("unknown provider")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        let (verifier, challenge) = pkce();
        // RFC 7636 S256: challenge = BASE64URL-NOPAD(SHA256(verifier)).
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
        // 32 SHA-256 bytes → 43 unpadded base64url chars, URL-safe alphabet.
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains(['+', '/', '=']));
    }

    #[test]
    fn pkce_verifier_is_rfc7636_safe_and_unique() {
        let (v1, _) = pkce();
        let (v2, _) = pkce();
        assert_ne!(v1, v2, "verifiers must be unpredictable per flow");
        // Two simple-format UUIDs → 64 chars, all within the unreserved set.
        assert_eq!(v1.len(), 64);
        assert!(v1.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn token_response_parses_access_refresh_and_expiry() {
        let before = now();
        let t = tokens_from_resp(
            &json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 100 }),
            None,
        )
        .unwrap();
        let after = now();
        assert_eq!(t.access, "at");
        assert_eq!(t.refresh.as_deref(), Some("rt"));
        assert!(t.expiry >= before + 100 && t.expiry <= after + 100);
    }

    #[test]
    fn token_response_without_access_token_is_an_error() {
        // (`match` instead of unwrap_err: `Tokens` deliberately has no Debug —
        // it holds secrets.)
        let err = match tokens_from_resp(&json!({ "expires_in": 100 }), None) {
            Ok(_) => panic!("a response without access_token must fail"),
            Err(e) => e,
        };
        assert_eq!(err.kind, "internal");
        // The message is deliberately generic — the provider response body
        // must not be echoed to the frontend.
        assert!(err.message.contains("no access token"));
        assert!(!err.message.contains("expires_in"));
    }

    #[test]
    fn refresh_keeps_the_previous_refresh_token_when_omitted() {
        // Google refresh responses typically omit refresh_token — the stored
        // one must survive, or the user gets logged out after one hour.
        let t = tokens_from_resp(
            &json!({ "access_token": "at2", "expires_in": 100 }),
            Some("old-rt".to_string()),
        )
        .unwrap();
        assert_eq!(t.refresh.as_deref(), Some("old-rt"));

        // But a rotated refresh token in the response wins over the old one.
        let t = tokens_from_resp(
            &json!({ "access_token": "at3", "refresh_token": "new-rt" }),
            Some("old-rt".to_string()),
        )
        .unwrap();
        assert_eq!(t.refresh.as_deref(), Some("new-rt"));
    }

    #[test]
    fn token_expiry_defaults_to_an_hour_when_missing() {
        let before = now();
        let t = tokens_from_resp(&json!({ "access_token": "at" }), None).unwrap();
        assert!(t.expiry >= before + 3600);
        assert!(t.refresh.is_none());
    }
}
