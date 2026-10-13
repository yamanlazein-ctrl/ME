//! One HTTP/1.1 exchange over the backend's named pipe (`Connection: close`, read to EOF).

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;

const ERROR_PIPE_BUSY: i32 = 231;

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub async fn request(
    pipe: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    timeout: Duration,
) -> Result<Response, String> {
    tokio::time::timeout(timeout, exchange(pipe, method, path, headers, body))
        .await
        .map_err(|_| "PIPE_TIMEOUT".to_string())?
}

async fn exchange(
    pipe: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<Response, String> {
    let mut client = loop {
        match ClientOptions::new().open(pipe) {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(e) => return Err(format!("PIPE_UNAVAILABLE: {e}")),
        }
    };
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if matches!(lk.as_str(), "host" | "connection" | "content-length" | "transfer-encoding")
            || k.contains(['\r', '\n'])
            || v.contains(['\r', '\n'])
        {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    client.write_all(head.as_bytes()).await.map_err(|e| format!("PIPE_WRITE: {e}"))?;
    client.write_all(body).await.map_err(|e| format!("PIPE_WRITE: {e}"))?;
    let mut raw = Vec::new();
    client.read_to_end(&mut raw).await.map_err(|e| format!("PIPE_READ: {e}"))?;
    parse(&raw)
}

pub fn parse(raw: &[u8]) -> Result<Response, String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("BAD_RESPONSE: no header end")?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| "BAD_RESPONSE: header not utf-8")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or("BAD_RESPONSE: status line")?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let rest = &raw[end + 4..];
    let chunked = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked { dechunk(rest)? } else { rest.to_vec() };
    let headers = headers.into_iter().filter(|(k, _)| !k.eq_ignore_ascii_case("transfer-encoding")).collect();
    Ok(Response { status, headers, body })
}

fn dechunk(mut b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = b.windows(2).position(|w| w == b"\r\n").ok_or("BAD_CHUNK: size line")?;
        let size_txt = std::str::from_utf8(&b[..eol]).map_err(|_| "BAD_CHUNK")?;
        let size = usize::from_str_radix(size_txt.split(';').next().unwrap().trim(), 16).map_err(|_| "BAD_CHUNK: size")?;
        b = &b[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if b.len() < size {
            return Err("BAD_CHUNK: truncated".into());
        }
        out.extend_from_slice(&b[..size]);
        b = b.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_chunked_bodies() {
        let r = parse(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: a=1\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"{\"ok\":true}"[..]));
        assert!(r.headers.iter().any(|(k, v)| k == "Set-Cookie" && v == "a=1"));

        let r = parse(b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n\xd8\xa7\xd8\xa8\r\n3;x=y\r\nabc\r\n0\r\n\r\n").unwrap();
        assert_eq!(r.status, 201);
        assert_eq!(r.body, "اب".bytes().chain(*b"abc").collect::<Vec<_>>());
        assert!(r.headers.is_empty());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse(b"nonsense").is_err());
        assert!(parse(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\nab").is_err());
    }
}
