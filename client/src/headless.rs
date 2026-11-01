// `planetCompute --headless`: no window. This program contributes natively (contribute.rs), controlled from its
// page: http://localhost:<port> on this computer, `ssh -L <port>:localhost:<port> <server>` from another one, or
// the tunnel link from anywhere. `--contribute` agrees and starts at once; `--cores N`, `--cap P`.

pub fn run(listener: std::net::TcpListener, port: u16, args: &[String]) -> i32 {
    println!("planetCompute {} --headless ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    println!("{}", super::engine::info());
    // the secret only on a terminal someone is watching, never into a log file (security review P4)
    if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        println!("Sign in and contribute at http://localhost:{port}/local/?t={}", super::server::local_token());
        println!("  (the ?t= part is this program's secret: keep the link to yourself)");
    } else {
        let _ = super::server::local_token(); // make the file now, so the path printed below exists
        let f = super::server::config_file("local_token").map(|p| p.display().to_string()).unwrap_or_else(|| "local_token in its config folder".into());
        println!("Sign in and contribute at http://localhost:{port}/local/?t=<secret>: the secret is in {f} (readable only by this user)");
    }
    println!("  from another computer: ssh -L {port}:localhost:{port} <this server>, then open that link there");
    let hub = match super::sherpa::hub_opts(args) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("planetCompute: {e}");
            return 2;
        }
    };
    match &hub {
        Some(o) => match o.job {
            Some((m, k, n, t)) => println!(
                "planetCompute {} started as a SherpaHub (its own job {m}x{k}x{n}, tiles of {t}x{t}{}; also the jobs given on the admin tab)",
                env!("CARGO_PKG_VERSION"),
                if o.repeat { ", one after another" } else { "" }
            ),
            None => println!("planetCompute {} started as a SherpaHub (it leads the jobs given on the admin tab SherpaHubs)", env!("CARGO_PKG_VERSION")),
        },
        None => println!("planetCompute {} started in regular mode", env!("CARGO_PKG_VERSION")),
    }
    let engine = super::contribute::Engine::new(args);
    let s = engine.settings.lock().unwrap().clone();
    println!(
        "Contributing: {} ({} core{} at up to {}%){}",
        if s.running { "on" } else { "off" },
        s.cores,
        if s.cores == 1 { "" } else { "s" },
        s.cap,
        if s.agreed { "" } else { ". Start it on the page (I agree), or run with --contribute" }
    );
    if s.running {
        println!("  Sharing compute uses this computer's electricity and may add to the wear of its hardware: these costs and the");
        println!("  equipment are your responsibility, and planetcompute.ai is not liable for them (https://planetcompute.ai/#electricity).");
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(super::server::serve(listener, port, Some(engine))) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("local web server stopped: {e}");
            1
        }
    }
}
