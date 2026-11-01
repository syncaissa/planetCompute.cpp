// planetCompute: one program. Its console is a local web server (127.0.0.1:7526) with two tabs,
// planetComputeContribute and planetComputeHarness, shown in the program's window, in any browser on this
// computer, or with `planetCompute --headless` (no window; Ubuntu servers).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod contribute;
mod engine;
mod headless;
mod image;
mod instance;
mod llm;
mod models;
mod openai;
mod sandbox;
mod server;
mod sherpa;
mod sherpa_prompts;
#[cfg(feature = "window")]
mod tray;
// the server build (no window): quitting just ends the program
#[cfg(not(feature = "window"))]
mod tray {
    pub fn quit() {
        crate::image::stop_engines();
        std::process::exit(0);
    }
    pub fn close_answer(_hide: bool) {}
}
mod tunnel;
mod vkloader;
mod webshare;
mod wsrelay;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Which build this is (build.rs): the commit and its time in unix seconds ("dev" / 0 without git). Every build says
/// "0.1.0", so the website tells builds apart by these (plan_old_programs #1): they ride in the User-Agent of every
/// request and socket, and in each status report.
pub const BUILD: &str = env!("PC_COMMIT");
pub const BUILD_TIME_S: &str = env!("PC_BUILD_TIME");
pub const UA: &str = concat!("planetCompute/", env!("CARGO_PKG_VERSION"), "+", env!("PC_COMMIT"), ".", env!("PC_BUILD_TIME"));
pub fn build_time() -> u64 {
    BUILD_TIME_S.parse().unwrap_or(0)
}
/// A unix time as "2026-10-31 11:05 UTC" (no date library in the program).
pub fn utc_text(t: u64) -> String {
    let (days, s) = ((t / 86400) as i64, t % 86400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", s / 3600, s % 3600 / 60)
}
fn build_date() -> String {
    if build_time() == 0 { "no date".into() } else { utc_text(build_time()) }
}
/// This build's OS name in the website's versions table (admin tab Versions; user 2026-11-01).
pub const VERSION_OS: &str = if cfg!(target_os = "windows") { "Windows" } else if cfg!(target_os = "macos") { "Mac" }
    else if !cfg!(feature = "window") { "LinuxNoUI" } else if cfg!(feature = "vulkan") { "LinuxWithGPU" } else { "Linux" };
/// This build's version in that table: the first 7 characters of its commit (e.g. 01de581).
pub fn version_id() -> &'static str { &BUILD[..BUILD.len().min(7)] }
/// This build's name on planetcompute.ai/download (the keys of /download/latest.json).
pub const DOWNLOAD_KEY: &str = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "mac" }
    else if !cfg!(feature = "window") { "linux-server" } else if cfg!(feature = "vulkan") { "linux-vulkan" } else { "linux" };

const HELP: &str = "planetCompute: share compute, receive compute

Usage:
  planetCompute               open the window (tabs: Share Compute, Receive Compute)
  planetCompute --headless    no window: sign in and share this computer at http://localhost:7526
  planetCompute --version     print the version and the llama.cpp build
  planetCompute --workpack-check   WorkPack kernel conformance hashes and speed (docs/SHERPAHUB.md)
  planetCompute --help        this text

Options:
  --port <n>                  the local web server's port (default 7526): http://localhost:<n>
  --contribute                with --headless: I agree, and start sharing at once (remembered). Sharing compute uses
                              this computer's electricity and may add to the wear of its hardware; these costs and
                              the equipment are your responsibility, and planetcompute.ai is not liable for them
                              (https://planetcompute.ai/#electricity). Set --cores and --cap to what you are
                              comfortable with.
  --cores <n>, --cap <p>      with --headless: cores to use, and the cap per core in percent (10-100)
  --sherpahub                 with --headless: also run as a SherpaHub, leading a BatchMode job (admin accounts
                              for now; docs/SHERPAHUB.md). --sherpa-job MxKxN (default 2048x4096x2048),
                              --sherpa-tile T (default 64), --sherpa-repeat (start the next job when one is done)
";

/// The local web server's port: --port <n>, else 7526.
fn local_port(args: &[String]) -> u16 {
    args.iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(api::LOCAL_PORT)
}

/// A release build on Windows has no console of its own; reuse the terminal it was started from.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
#[cfg(not(windows))]
fn attach_console() {}

fn main() {
    let first = std::env::args().nth(1).unwrap_or_default();
    // the engines' sandbox launcher (sandbox.rs, Linux and macOS): lock in, then become the engine; before anything else
    #[cfg(unix)]
    if first == sandbox::EXEC_FLAG {
        std::process::exit(sandbox::exec_main());
    }
    // Windows Vulkan build: the PC's Vulkan loader, or the one carried inside, before llama.cpp starts (vkloader.rs)
    vkloader::ensure();
    // the model engine copy (llm.rs, security review E5), only as the first argument: it never replaces the running
    // program
    if first == llm::WORKER_FLAG {
        std::process::exit(llm::worker_main());
    }
    // inside the sandbox for --sandbox-check: what may it do?
    if first == sandbox::PROBE_FLAG {
        std::process::exit(sandbox::probe_main());
    }
    // One TLS crypto provider for the whole program (reqwest and the tunnel WebSocket both use rustls).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    let port = local_port(&args);
    if has("--help") || has("-h") {
        attach_console();
        print!("{HELP}");
        return;
    }
    if has("--version") || has("-V") {
        attach_console();
        println!("planetCompute {VERSION} build {BUILD} ({}) ({} {}), local web server port {port}\n{}\n{}\n{}", build_date(), std::env::consts::OS, std::env::consts::ARCH, engine::info(), vkloader::status(), sandbox::describe());
        return;
    }
    if has("--workpack-check") {
        attach_console();
        std::process::exit(workpack_check());
    }
    if has(sandbox::CHECK_FLAG) {
        attach_console();
        std::process::exit(sandbox::check_main());
    }
    // A planetCompute already running on this port is replaced by this one (newest build wins).
    let (listener, replaced) = match instance::take_port(port) {
        Ok(x) => x,
        Err(e) => {
            attach_console();
            eprintln!("planetCompute: {e}");
            std::process::exit(2);
        }
    };
    // the server build has no window: always headless
    if has("--headless") || !cfg!(feature = "window") {
        attach_console();
        if let Some(pid) = replaced {
            println!("Replaced the planetCompute that was running on port {port} (process {pid}).");
        }
        std::process::exit(headless::run(listener, port, &args));
    }
    #[cfg(feature = "window")]
    window(listener, port);
}

/// The window (Tauri): the program's own page, the tray icon, close to the tray.
#[cfg(feature = "window")]
fn window(listener: std::net::TcpListener, port: u16) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server::serve(listener, port, None).await {
            eprintln!("local web server stopped: {e}");
        }
    });
    // 127.0.0.1 rather than localhost: macOS lets apps load plain http from IP addresses without extra settings.
    // the program's own page: its header (Contribute Compute | Harness Compute | My Content | Local Tunnel URL) stays
    // on top; the website's console runs inside it (Contribute Compute, Compute)
    // ?t=: this program's secret (security review E1); the page turns it into a cookie and drops it from the address
    let url: tauri::Url = format!("http://127.0.0.1:{port}/local/?t={}", server::local_token()).parse().expect("local URL");
    let app = tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.clone()))
                .title("planetCompute")
                .inner_size(1100.0, 760.0)
                .min_inner_size(380.0, 560.0)
                .build()?;
            tray::add(app.handle());
            Ok(())
        })
        // with the tray icon, the close button hides the window: contributing and the queue go on (Quit is in the tray)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if tray::shown() {
                    api.prevent_close();
                    tray::close_pressed(window);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("planetCompute: could not start the window");
    // the program ends (Quit, or closed without a tray icon): no picture engine is left running behind it
    app.run(|_, event| {
        if let tauri::RunEvent::Exit = event {
            image::stop_engines();
        }
    });
}

/// --workpack-check (docs/TESTING.md test 63): the kernel conformance hashes (must equal the crate's and the
/// browser's on every machine) and the speed of matmul_i8 here. Exit 0 only if the fast kernel equals the naive one.
fn workpack_check() -> i32 {
    use workpack::kernels::*;
    let mut ok = true;
    for &(seed, m, k, n) in VECTORS.iter() {
        let (a, bt) = vector_inputs(seed, m, k, n);
        let fast = vector_hash(seed, m, k, n);
        let same = fast == sha256_i32(&matmul_i8_naive(&a, &bt, m, k, n));
        ok &= same;
        println!("VECTOR {seed} {m}x{k}x{n} {fast}{}", if same { "" } else { "  FAIL (fast != naive)" });
    }
    let (m, k, n) = (256, 1024, 256);
    let (a, bt) = vector_inputs(7, m, k, n);
    let mut c = vec![0i32; m * n];
    let t = std::time::Instant::now();
    let mut reps = 0u32;
    while t.elapsed().as_millis() < 1500 {
        matmul_i8(&a, &bt, m, k, n, &mut c);
        reps += 1;
    }
    let gops = 2.0 * (m * k * n) as f64 * reps as f64 / t.elapsed().as_secs_f64() / 1e9;
    println!("SPEED matmul_i8 {m}x{k}x{n} one core: {gops:.2} GOP/s ({} {})", std::env::consts::OS, std::env::consts::ARCH);
    println!("{}", if ok { "ALL PASS" } else { "FAILED" });
    if ok { 0 } else { 1 }
}
