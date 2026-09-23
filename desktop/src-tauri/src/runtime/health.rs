// Readiness gating — LIVENESS-based, not deadline-based.
//
// A fixed timeout ("fail if the server is not up in 60 s") is wrong for a desktop app: a cold start on a slow
// disk with real-time antivirus scanning legitimately takes minutes, and the old 60 s / 120 s / 300 s deadlines
// turned "slow" into a fatal error, killed the half-started stack and made the next boot start from scratch.
//
// What decides the outcome here is the child process itself:
//   - it reports ready            -> continue,
//   - it has EXITED               -> fail immediately with its exit code (the real, single cause),
//   - it is alive but not ready   -> keep waiting and keep telling the user how long it has been,
//                                    up to a very generous safety ceiling that only exists to bound a
//                                    genuinely wedged process.
// Boot order is enforced by `stages.rs`, never by timing.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Result of waiting for a child process to become ready.
#[derive(Debug, PartialEq, Eq)]
pub enum WaitOutcome<T> {
    Ready(T),
    /// The child ended before it became ready (exit code as reported by the OS).
    ChildExited(u32),
    /// Still alive but never became ready within the safety ceiling.
    CeilingReached,
}

/// Poll `ready` until it yields a value, the child dies, or `ceiling` elapses.
/// `on_tick` receives the elapsed time roughly once per second (progress for the splash).
pub fn wait_ready<T>(
    mut ready: impl FnMut() -> Option<T>,
    mut child_exit_code: impl FnMut() -> Option<u32>,
    mut on_tick: impl FnMut(Duration),
    ceiling: Duration,
) -> WaitOutcome<T> {
    let start = Instant::now();
    let mut last_tick = Duration::ZERO;
    loop {
        if let Some(v) = ready() {
            return WaitOutcome::Ready(v);
        }
        if let Some(code) = child_exit_code() {
            // One last look: the child may have written its readiness signal just before exiting.
            return match ready() {
                Some(v) => WaitOutcome::Ready(v),
                None => WaitOutcome::ChildExited(code),
            };
        }
        let elapsed = start.elapsed();
        if elapsed >= ceiling {
            return WaitOutcome::CeilingReached;
        }
        if elapsed.saturating_sub(last_tick) >= Duration::from_secs(1) {
            last_tick = elapsed;
            on_tick(elapsed);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    fn wait_ready_returns_as_soon_as_the_signal_appears() {
        let mut n = 0;
        let out = wait_ready(
            || {
                n += 1;
                (n >= 3).then_some("up")
            },
            || None,
            |_| {},
            Duration::from_secs(5),
        );
        assert_eq!(out, WaitOutcome::Ready("up"));
    }

    #[test]
    fn wait_ready_fails_immediately_when_the_child_dies() {
        let start = Instant::now();
        let out = wait_ready::<()>(|| None, || Some(3), |_| {}, Duration::from_secs(60));
        assert_eq!(out, WaitOutcome::ChildExited(3));
        assert!(start.elapsed() < Duration::from_secs(2), "a dead child must not be waited on");
    }

    #[test]
    fn wait_ready_keeps_waiting_for_a_slow_but_alive_child() {
        // Slow start (ready only after ~0.5 s) must succeed — being slow is not an error.
        let t0 = Instant::now();
        let out = wait_ready(
            || (t0.elapsed() > Duration::from_millis(500)).then_some(1),
            || None,
            |_| {},
            Duration::from_secs(10),
        );
        assert_eq!(out, WaitOutcome::Ready(1));
    }

    #[test]
    fn wait_ready_only_gives_up_at_the_safety_ceiling() {
        let out = wait_ready::<()>(|| None, || None, |_| {}, Duration::from_millis(300));
        assert_eq!(out, WaitOutcome::CeilingReached);
    }
}
