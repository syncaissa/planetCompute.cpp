// The planetcompute.ai APIs the website console uses (BrowserCFWorkerCode/worker.js).

pub const SITE: &str = "https://planetcompute.ai";

/// The site's session cookie (worker.js COOKIE).
pub const COOKIE: &str = "pc_session";

/// The local web server (http://127.0.0.1:7526): the console and, later, Harness's llama.cpp-style API (/v1).
/// Chosen to differ from Sushila's port; the simulators use 7526 (Contributor) and 7527 (Harness).
/// Override with --port.
pub const LOCAL_PORT: u16 = 7526;
