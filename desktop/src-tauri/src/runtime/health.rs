// Readiness gating with bounded deadlines (Plan §8 — measured, not vague).
//
// A note on the banned list (§0.1 rule 2): "adding sleep / increasing
// timeouts / telling the user to wait longer" is banned as a FIX for a race
// or ordering bug. What this module does is different and is the only honest
// way to wait for a child process that initializes on its own schedule:
// poll a readiness signal (TCP accept, HTTP 200) with a FIXED short quantum
// and a HARD total deadline, then fail loudly with the single true cause and
// clean up everything already started. The quantum (250–300ms) is a
// scheduling granularity, not a correctness mechanism: correctness comes
// from the deadline + the readiness signal itself, and boot order is enforced
// by `stages.rs`, never by timing.
//
// Concretely:
//   - postgres readiness is reported by postgres itself (`pg_ctl start -w`);
//     `wait_tcp` is only the second gate before `createdb`.
//   - backend readiness is the backend's own GET /api/health/live == 200.
//   - frontend readiness is GET /__health == 200, a lightweight event-loop
//     probe — NEVER "/" (polling "/" forced a full SSR render and caused the
//     historic 5-minute-boot false failure; see stack.rs Step 8).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Absolute ceiling for the whole boot (provision → frontend ready).
pub const BOOT_DEADLINE: Duration = Duration::from_secs(300);

pub fn check_boot_deadline(started: Instant) -> io::Result<()> {
    if started.elapsed() > BOOT_DEADLINE {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "تجاوز إقلاع النظام المهلة القصوى (300 ثانية)",
        ));
    }
    Ok(())
}

/// Wait until `host:port` accepts TCP, or the timeout expires.
pub fn wait_tcp(host: &str, port: u16, timeout: Duration) -> io::Result<()> {
    let addr: std::net::SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let start = Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("انتهت المهلة بانتظار المنفذ {host}:{port} ({timeout:?})"),
    ))
}

/// Minimal HTTP GET → true iff the status line is 2xx. Raw TCP on purpose:
/// no HTTP client dependency in the boot path, 2s per-attempt cap.
pub fn http_get_ok(host: &str, port: u16, path: &str) -> bool {
    let addr: std::net::SocketAddr = format!("{}:{}", host, port).parse().unwrap();
    let timeout = Duration::from_secs(2);
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(_) => return false,
    };
    stream.set_read_timeout(Some(timeout)).ok();
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let resp = String::from_utf8_lossy(&buf[..n]);
            resp.contains("HTTP/1.1 2")
        }
        _ => false,
    }
}

/// Poll `pred` until true or `timeout` elapses. The timeout is the contract;
/// `false` means "not ready in time", never "maybe try longer".
pub fn wait_for<F: Fn() -> bool>(pred: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_tcp_times_out_with_error() {
        // Port 1 is privileged/closed: the wait must end in a TimedOut error,
        // not hang, and the message must name the cause.
        let err = wait_tcp("127.0.0.1", 1, Duration::from_millis(200)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(err.to_string().contains("انتهت المهلة"));
    }

    #[test]
    fn wait_for_returns_false_on_deadline() {
        let start = Instant::now();
        assert!(!wait_for(|| false, Duration::from_millis(350)));
        assert!(start.elapsed() < Duration::from_secs(10), "must be bounded");
    }

    #[test]
    fn wait_for_returns_true_immediately_when_ready() {
        assert!(wait_for(|| true, Duration::from_secs(5)));
    }

    #[test]
    fn boot_deadline_rejects_expired_start() {
        let long_ago = Instant::now() - BOOT_DEADLINE - Duration::from_secs(1);
        assert!(check_boot_deadline(long_ago).is_err());
        assert!(check_boot_deadline(Instant::now()).is_ok());
    }
}
