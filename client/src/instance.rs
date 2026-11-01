// One planetCompute per port: a newly started program REPLACES the one already running (so testing a new
// build never talks to an old one by mistake). Asks the old one to quit (/local/quit), then force-closes it.
// A port held by some other program is never touched.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// A tiny HTTP/1.1 call to the local web server; the body, or None if nothing answered.
fn local_call(port: u16, method: &str, path: &str) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-planetcompute: quit\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        crate::server::local_token()   // the same secret for every copy of this installation (security review E1)
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}

fn wait_bind(port: u16, secs: u64) -> Option<std::net::TcpListener> {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Ok(l) = crate::server::bind(port) {
            return Some(l);
        }
        if Instant::now() > end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn run_quietly(cmd: &str, args: &[&str]) {
    let mut c = std::process::Command::new(cmd);
    c.args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the windowed program
    }
    let _ = c.status();
}

fn kill_pid(pid: u32) {
    if pid == std::process::id() {
        return;
    }
    #[cfg(windows)]
    run_quietly("taskkill", &["/F", "/PID", &pid.to_string()]);
    #[cfg(not(windows))]
    run_quietly("kill", &["-9", &pid.to_string()]);
}

/// For builds older than /local/quit: every other planetCompute process, whatever its file is called
/// (planetcompute.exe, planetCompute-0.1.0-windows-x86_64.exe, ...).
fn kill_others_by_name() {
    let me = std::process::id();
    #[cfg(windows)]
    run_quietly("taskkill", &["/F", "/IM", "planetCompute*", "/FI", &format!("PID ne {me}")]);
    #[cfg(not(windows))]
    if let Ok(o) = std::process::Command::new("pgrep").args(["-i", "^planetcompute"]).output() {
        for pid in String::from_utf8_lossy(&o.stdout).split_whitespace().filter_map(|p| p.parse::<u32>().ok()) {
            if pid != me {
                kill_pid(pid);
            }
        }
    }
}

/// Take the port, replacing a running planetCompute if there is one.
/// Ok((listener, Some(old pid or 0))) when one was replaced; Err(message) when the port belongs to another program.
pub fn take_port(port: u16) -> Result<(std::net::TcpListener, Option<u32>), String> {
    if let Ok(l) = crate::server::bind(port) {
        return Ok((l, None));
    }
    let info = local_call(port, "GET", "/local/info")
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .filter(|v| v.get("version").is_some() && v.get("port").is_some());
    let Some(info) = info else {
        return Err(format!("port {port} is used by another program. Start planetCompute with --port <n>."));
    };
    let old = info.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32);
    let _ = local_call(port, "POST", "/local/quit");
    if let Some(l) = wait_bind(port, 5) {
        return Ok((l, Some(old.unwrap_or(0))));
    }
    match old {
        Some(pid) => kill_pid(pid),
        None => kill_others_by_name(),
    }
    wait_bind(port, 5)
        .map(|l| (l, Some(old.unwrap_or(0))))
        .ok_or_else(|| format!("the planetCompute already running on port {port} did not stop. Close it, or use --port <n>."))
}
