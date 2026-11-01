// The engines run in the operating system's sandbox (security review E5, second step). The model engine (llm.rs, a
// second copy of this program started with --llm-worker) and the image engine (image.rs, sd-cli) read model files from
// many places, and an engine's file reader can have memory bugs. A hostile file that took over an engine must find
// nothing to take: it may read the models and its own folder (and the system's libraries and drivers), write only the
// pictures folder (the image engine; the model engine writes nothing), and it has no network and cannot start other
// programs. It holds no sign-in either: answers go back over its input/output pipes only.
//   Linux:   Landlock (which files) + seccomp (no sockets, io_uring, ptrace, bpf; the model engine: no programs), set
//            by a launcher copy of this program (--sandbox-exec) that then becomes the engine (exec). Both stay on
//            the engine for good. Landlock needs Linux 5.13+ with it switched on; without it only seccomp applies.
//   macOS:   the system sandbox (sandbox_init), set the same way: no network, no writes, none of your folders.
//   Windows: an AppContainer (no network capability; files only where this program gave it access) in a job
//            (one process: no other programs; it ends when this program ends).
// `planetCompute --sandbox-check` starts both kinds of engine sandboxed and shows what they can and cannot do (CI).

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(unix)]
pub const EXEC_FLAG: &str = "--sandbox-exec";
pub const PROBE_FLAG: &str = "--sandbox-probe";
pub const CHECK_FLAG: &str = "--sandbox-check";

/// What an engine may use: read (the models, the engine's own folder) and write (the pictures folder).
#[derive(Clone, Default)]
pub struct Rules {
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
}

impl Rules {
    /// The model engine: reads the models; writes nothing.
    pub fn llm() -> Rules {
        Rules { read: vec![crate::models::dir(), crate::image::data().join("bin")], write: vec![] }
    }
    /// The image engine: reads the models and its own folder; writes the pictures folder.
    pub fn image() -> Rules {
        Rules { read: vec![crate::models::dir(), crate::image::data().join("bin")], write: vec![crate::image::folder()] }
    }
}

/// Which of the engine's input and outputs are pipes to this program (the rest go nowhere).
pub struct Io {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

pub struct Exit {
    pub ok: bool,
    pub code: Option<i32>,
}

/// A sandboxed engine process.
pub struct Proc {
    #[cfg(unix)]
    child: std::process::Child,
    #[cfg(windows)]
    child: win::Child,
    pub stdin: Option<Box<dyn Write + Send>>,
    pub stdout: Option<Box<dyn Read + Send>>,
    pub stderr: Option<Box<dyn Read + Send>>,
}

impl Proc {
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    pub fn wait(&mut self) -> std::io::Result<Exit> {
        #[cfg(unix)]
        return self.child.wait().map(|s| Exit { ok: s.success(), code: s.code() });
        #[cfg(windows)]
        return self.child.wait();
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<Exit>> {
        #[cfg(unix)]
        return self.child.try_wait().map(|o| o.map(|s| Exit { ok: s.success(), code: s.code() }));
        #[cfg(windows)]
        return self.child.try_wait();
    }
}

/// Start `exe args` in the sandbox with these rules (and these extra environment variables).
pub fn spawn(exe: &Path, args: &[String], envs: &[(String, String)], rules: &Rules, io: Io) -> Result<Proc, String> {
    for d in rules.read.iter().chain(&rules.write) {
        let _ = std::fs::create_dir_all(d);
    }
    // where this program keeps its data, for the engine (an AppContainer may see other folders by those names)
    let mut envs = envs.to_vec();
    envs.push(("PC_ENGINE_DATA".into(), crate::image::data().to_string_lossy().into_owned()));
    #[cfg(unix)]
    {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        let s = |v: &[PathBuf]| v.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let spec = json!({"read": s(&rules.read), "write": s(&rules.write)});
        let pipe = |on: bool| if on { Stdio::piped() } else { Stdio::null() };
        let mut c = Command::new(me);
        c.arg(EXEC_FLAG).arg(spec.to_string()).arg(exe).args(args).envs(envs.iter().map(|(k, v)| (k, v)));
        c.stdin(pipe(io.stdin)).stdout(pipe(io.stdout)).stderr(pipe(io.stderr));
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().map(|x| Box::new(x) as Box<dyn Write + Send>);
        let stdout = child.stdout.take().map(|x| Box::new(x) as Box<dyn Read + Send>);
        let stderr = child.stderr.take().map(|x| Box::new(x) as Box<dyn Read + Send>);
        Ok(Proc { child, stdin, stdout, stderr })
    }
    #[cfg(windows)]
    {
        let (child, stdin, stdout, stderr) = win::spawn(exe, args, &envs, rules, &io)?;
        Ok(Proc {
            child,
            stdin: stdin.map(|x| Box::new(x) as Box<dyn Write + Send>),
            stdout: stdout.map(|x| Box::new(x) as Box<dyn Read + Send>),
            stderr: stderr.map(|x| Box::new(x) as Box<dyn Read + Send>),
        })
    }
}

/// `planetCompute --sandbox-exec <rules> <engine> <args...>` (Linux, macOS): lock this process in, then become the
/// engine. Nothing else has run yet in this copy (no other thread), and what is set here stays across the exec.
#[cfg(unix)]
pub fn exec_main() -> i32 {
    use std::os::unix::process::CommandExt;
    let a: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if a.len() < 4 {
        eprintln!("planetCompute: {EXEC_FLAG} needs the rules and the engine");
        return 97;
    }
    let spec: Value = serde_json::from_str(&a[2].to_string_lossy()).unwrap_or_default();
    let list = |k: &str| spec[k].as_array().into_iter().flatten().filter_map(|x| x.as_str()).map(PathBuf::from).collect::<Vec<_>>();
    let exe = PathBuf::from(&a[3]);
    if let Err(e) = lock(&list("read"), &list("write"), &exe) {
        eprintln!("planetCompute: the engine sandbox could not start: {e}");
        return 97;
    }
    let e = Command::new(&exe).args(&a[4..]).exec();
    eprintln!("planetCompute: could not start the engine in its sandbox: {e}");
    97
}

#[cfg(target_os = "linux")]
fn lock(read: &[PathBuf], write: &[PathBuf], exe: &Path) -> Result<(), String> {
    linux::landlock(read, write, exe)?;
    linux::seccomp(&linux::DENY)
}

#[cfg(target_os = "macos")]
fn lock(read: &[PathBuf], write: &[PathBuf], exe: &Path) -> Result<(), String> {
    mac::lock(read, write, exe)
}

/// The model engine's own extra lock, first thing in it (one thread): it may not start any program (Linux; macOS and
/// Windows already allow it none but itself).
pub fn worker_lock() -> Result<(), String> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return linux::seccomp(&[libc::SYS_execve, libc::SYS_execveat]);
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    Ok(())
}

/// What the sandbox is on this computer (for --version, /local/info and the paper's tests).
pub fn describe() -> String {
    #[cfg(target_os = "linux")]
    {
        let net = if cfg!(target_arch = "x86_64") { "seccomp: no network, no other programs (model engine)" } else { "no seccomp on this processor" };
        let abi = linux::landlock_abi();
        if abi >= 1 {
            format!("Linux sandbox: Landlock ABI {abi} (files: the models, the engine's folder, pictures only); {net}")
        } else {
            format!("Linux sandbox: {net}; Landlock is not available on this kernel, so the engines' files are not limited")
        }
    }
    #[cfg(target_os = "macos")]
    return "macOS sandbox: no network, no writing outside the pictures folder, none of your folders, no other programs".into();
    #[cfg(windows)]
    return "Windows sandbox: AppContainer (no network; files only where given) in a job (no other programs)".into();
}

/// `planetCompute --sandbox-probe <what to try>`: run inside the sandbox by --sandbox-check; says what it could do.
pub fn probe_main() -> i32 {
    let v: Value = serde_json::from_str(&std::env::args().nth(2).unwrap_or_default()).unwrap_or_default();
    let p = |k: &str| PathBuf::from(v[k].as_str().unwrap_or(""));
    if v["worker"] == true {
        if let Err(e) = worker_lock() {
            println!("{}", json!({"error": e}));
            return 97;
        }
    }
    let try_write = |f: PathBuf| {
        let ok = std::fs::write(&f, b"x").is_ok();
        let _ = std::fs::remove_file(&f);
        ok
    };
    let r = json!({
        "read_inside": std::fs::read(p("inside_file")).is_ok() && std::fs::read_dir(p("inside_dir")).is_ok(),
        "read_outside": std::fs::read(p("outside_file")).is_ok(),
        "read_beside": std::fs::read(p("beside_file")).is_ok(),
        "list_home": std::fs::read_dir(p("home")).map(|mut d| d.next().is_some()).unwrap_or(false),
        "write_inside": try_write(p("write_inside")),
        "write_outside": try_write(p("write_outside")),
        "network": can_connect(),
        "start_program": can_start_program(),
    });
    println!("{r}");
    0
}

fn can_connect() -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([1, 1, 1, 1], 443)), Duration::from_secs(4)).is_ok()
}

fn can_start_program() -> bool {
    #[cfg(windows)]
    let mut c = Command::new(r"C:\Windows\System32\cmd.exe");
    #[cfg(windows)]
    c.args(["/c", "exit 0"]);
    #[cfg(unix)]
    let mut c = Command::new("/bin/sh");
    #[cfg(unix)]
    c.args(["-c", "exit 0"]);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// `planetCompute --sandbox-check`: start each kind of engine sandboxed and check what it can and cannot do.
pub fn check_main() -> i32 {
    println!("{}", describe());
    let models = crate::models::dir();
    let images = crate::image::folder();
    for d in [&models, &images] {
        let _ = std::fs::create_dir_all(d);
    }
    let pid = std::process::id();
    let inside = models.join(format!("sandbox-check-{pid}.txt"));
    let outside = std::env::temp_dir().join(format!("planetCompute-sandbox-check-{pid}.txt"));
    let _ = std::fs::write(&inside, b"inside");
    let _ = std::fs::write(&outside, b"outside");
    let home = dirs::home_dir().unwrap_or_default();
    // what this program itself may do, so that a "no" below is the sandbox's doing
    let (net, prog) = (can_connect(), can_start_program());
    let me = match std::env::current_exe() {
        Ok(x) => x,
        Err(e) => {
            println!("FAIL cannot find this program: {e}");
            return 1;
        }
    };
    // a file next to the program (its folder may be Downloads): the engine may not read it
    let beside = me.with_file_name(format!("sandbox-check-beside-{pid}.txt"));
    let beside_ok = std::fs::write(&beside, b"beside").is_ok();
    let mut fails = 0;
    for (name, rules, worker, may_write) in [("model engine", Rules::llm(), true, &models), ("image engine", Rules::image(), false, &images)] {
        let spec = json!({"worker": worker, "inside_file": inside.to_string_lossy(), "inside_dir": models.to_string_lossy(),
            "outside_file": outside.to_string_lossy(), "home": home.to_string_lossy(), "beside_file": beside.to_string_lossy(),
            "write_inside": may_write.join(format!("sandbox-write-{pid}.txt")).to_string_lossy(),
            "write_outside": std::env::temp_dir().join(format!("planetCompute-sandbox-write-{pid}.txt")).to_string_lossy()});
        let got = spawn(&me, &[PROBE_FLAG.to_string(), spec.to_string()], &[], &rules, Io { stdin: false, stdout: true, stderr: false })
            .and_then(|mut p| {
                let mut s = String::new();
                if let Some(mut o) = p.stdout.take() {
                    let _ = o.read_to_string(&mut s);
                }
                let _ = p.wait();
                serde_json::from_str::<Value>(s.trim()).map_err(|_| format!("no answer from the sandboxed {name} ({})", s.trim()))
            });
        let r = match got {
            Ok(r) => r,
            Err(e) => {
                println!("FAIL {name}: {e}");
                fails += 1;
                continue;
            }
        };
        let mut check = |what: &str, ok: bool| {
            println!("{} {name}: {what}", if ok { "PASS" } else { "FAIL" });
            if !ok {
                fails += 1;
            }
        };
        check("reads the models", r["read_inside"] == true);
        check("cannot read a file outside its folders", r["read_outside"] == false);
        check("cannot list your home folder", r["list_home"] == false);
        if beside_ok {
            check("cannot read a file next to the program", r["read_beside"] == false);
        }
        if worker {
            check("cannot write into the models folder (writes nothing)", r["write_inside"] == false);
        } else {
            check("writes the pictures folder", r["write_inside"] == true);
        }
        check("cannot write outside its folders", r["write_outside"] == false);
        if net {
            check("has no network", r["network"] == false);
        } else {
            println!("SKIP {name}: network (this computer has none to refuse)");
        }
        if prog {
            check("cannot start another program", r["start_program"] == false);
        } else {
            println!("SKIP {name}: starting a program (this program itself cannot)");
        }
    }
    let _ = std::fs::remove_file(&inside);
    let _ = std::fs::remove_file(&outside);
    let _ = std::fs::remove_file(&beside);
    if fails == 0 {
        println!("ALL PASS");
    }
    fails
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const EXECUTE: u64 = 1 << 0;
    const WRITE_FILE: u64 = 1 << 1;
    const READ_FILE: u64 = 1 << 2;
    const READ_DIR: u64 = 1 << 3;
    const MAKE_CHAR: u64 = 1 << 6;
    const MAKE_SOCK: u64 = 1 << 9;
    const MAKE_FIFO: u64 = 1 << 10;
    const MAKE_BLOCK: u64 = 1 << 11;
    const MAKE_SYM: u64 = 1 << 12;
    const REFER: u64 = 1 << 13;
    const TRUNCATE: u64 = 1 << 14;

    /// The system's own files the engines need (libraries, drivers, CPU facts); none of them is anyone's data.
    const SYSTEM: [&str; 14] = ["/usr", "/lib", "/lib64", "/lib32", "/libx32", "/etc", "/opt", "/sys", "/proc/self", "/proc/cpuinfo",
        "/proc/meminfo", "/proc/stat", "/proc/driver", "/run/opengl-driver"];
    /// Devices: the GPU (Vulkan / CUDA) and the harmless ones.
    const DEVICES: [&str; 7] = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/dri", "/dev/kfd"];
    /// The program loader a dynamically linked engine is started with.
    const LOADERS: [&str; 4] = ["/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "/usr/lib64/ld-linux-x86-64.so.2",
        "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"];

    /// No sockets of any kind (no network), no io_uring (it can open sockets too), no reading or writing other
    /// processes, no kernel programs, keys or performance counters.
    #[cfg(target_arch = "x86_64")]
    pub const DENY: [libc::c_long; 13] = [libc::SYS_socket, libc::SYS_ptrace, libc::SYS_process_vm_readv, libc::SYS_process_vm_writev,
        libc::SYS_bpf, libc::SYS_userfaultfd, libc::SYS_io_uring_setup, libc::SYS_io_uring_enter, libc::SYS_io_uring_register,
        libc::SYS_keyctl, libc::SYS_add_key, libc::SYS_request_key, libc::SYS_perf_event_open];
    #[cfg(not(target_arch = "x86_64"))]
    pub const DENY: [libc::c_long; 0] = [];

    /// The Landlock version of this kernel (0: none).
    pub fn landlock_abi() -> i64 {
        let v = unsafe { libc::syscall(SYS_LANDLOCK_CREATE_RULESET, std::ptr::null::<u8>(), 0usize, 1u32) };
        v.max(0) as i64
    }

    fn no_new_privs() -> Result<(), String> {
        let r = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) };
        if r != 0 { Err(format!("no_new_privs: {}", std::io::Error::last_os_error())) } else { Ok(()) }
    }

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }

    #[repr(C, packed)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }

    pub fn landlock(read: &[PathBuf], write: &[PathBuf], exe: &Path) -> Result<(), String> {
        let abi = landlock_abi();
        if abi < 1 {
            return Ok(()); // not on this kernel: seccomp still applies (describe() says so)
        }
        let mut handled: u64 = (1 << 13) - 1; // every file right of ABI 1
        if abi >= 2 {
            handled |= REFER;
        }
        if abi >= 3 {
            handled |= TRUNCATE;
        }
        let file_rights = (EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE) & handled;
        let attr = RulesetAttr { handled_access_fs: handled };
        let fd = unsafe { libc::syscall(SYS_LANDLOCK_CREATE_RULESET, &attr as *const RulesetAttr, std::mem::size_of::<RulesetAttr>(), 0u32) };
        if fd < 0 {
            return Err(format!("landlock: {}", std::io::Error::last_os_error()));
        }
        let fd = fd as libc::c_int;
        // a path that is not on this computer is skipped; a rule that cannot be added only takes access away
        let add = |p: &Path, want: u64| {
            let Ok(c) = CString::new(p.as_os_str().as_bytes()) else { return };
            let pfd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
            if pfd < 0 {
                return;
            }
            let dir = std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false);
            let rule = PathBeneath { allowed_access: if dir { want & handled } else { want & file_rights }, parent_fd: pfd };
            let r = unsafe { libc::syscall(SYS_LANDLOCK_ADD_RULE, fd, 1u32, &rule as *const PathBeneath, 0u32) };
            if r < 0 {
                eprintln!("planetCompute sandbox: {} not allowed ({})", p.display(), std::io::Error::last_os_error());
            }
            unsafe { libc::close(pfd) };
        };
        for p in SYSTEM {
            add(Path::new(p), READ_FILE | READ_DIR);
        }
        for p in DEVICES {
            add(Path::new(p), READ_FILE | WRITE_FILE | READ_DIR);
        }
        if let Ok(rd) = std::fs::read_dir("/dev") {
            for e in rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("nvidia")) {
                add(e.path().as_path(), READ_FILE | WRITE_FILE | READ_DIR);
            }
        }
        for p in read {
            add(p.as_path(), READ_FILE | READ_DIR);
        }
        for p in write {
            // make, change and remove plain files and folders there; never run them, and never links, sockets, pipes or
            // device files (security review P10: a link in the pictures folder must not point elsewhere)
            add(p.as_path(), handled & !(EXECUTE | MAKE_SYM | MAKE_CHAR | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK));
        }
        add(exe, EXECUTE | READ_FILE); // the engine itself is the only program it may run
        for p in LOADERS {
            add(Path::new(p), EXECUTE | READ_FILE);
        }
        let r = no_new_privs().map(|_| unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, fd, 0u32) });
        unsafe { libc::close(fd) };
        match r {
            Ok(0) => Ok(()),
            Ok(_) => Err(format!("landlock: {}", std::io::Error::last_os_error())),
            Err(e) => Err(e),
        }
    }

    #[repr(C)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }

    /// A seccomp filter: these system calls answer EPERM; another processor architecture or the x32 calls too.
    #[cfg(target_arch = "x86_64")]
    pub fn seccomp(deny: &[libc::c_long]) -> Result<(), String> {
        const LD_ABS_W: u16 = 0x20;
        const JEQ_K: u16 = 0x15;
        const JGE_K: u16 = 0x35;
        const RET_K: u16 = 0x06;
        const ARCH_X86_64: u32 = 0xC000_003E;
        const ALLOW: u32 = 0x7fff_0000;
        const ERRNO: u32 = 0x0005_0000;
        let errno_at = 4 + deny.len() + 1; // after the checks and the ALLOW
        let to = |i: usize| (errno_at - (i + 1)) as u8;
        let mut f = vec![
            SockFilter { code: LD_ABS_W, jt: 0, jf: 0, k: 4 },               // the architecture
            SockFilter { code: JEQ_K, jt: 0, jf: to(1), k: ARCH_X86_64 },
            SockFilter { code: LD_ABS_W, jt: 0, jf: 0, k: 0 },               // the call's number
            SockFilter { code: JGE_K, jt: to(3), jf: 0, k: 0x4000_0000 },    // x32 calls
        ];
        for (j, nr) in deny.iter().enumerate() {
            f.push(SockFilter { code: JEQ_K, jt: to(4 + j), jf: 0, k: *nr as u32 });
        }
        f.push(SockFilter { code: RET_K, jt: 0, jf: 0, k: ALLOW });
        f.push(SockFilter { code: RET_K, jt: 0, jf: 0, k: ERRNO | libc::EPERM as u32 });
        let prog = SockFprog { len: f.len() as u16, filter: f.as_ptr() };
        no_new_privs()?;
        let r = unsafe { libc::prctl(libc::PR_SET_SECCOMP, 2 as libc::c_ulong, &prog as *const SockFprog as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) };
        if r != 0 { Err(format!("seccomp: {}", std::io::Error::last_os_error())) } else { Ok(()) }
    }

    #[cfg(not(target_arch = "x86_64"))]
    pub fn seccomp(_deny: &[libc::c_long]) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    use std::path::{Path, PathBuf};

    extern "C" {
        fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
        fn sandbox_free_error(errorbuf: *mut c_char);
    }

    fn real(p: &Path) -> PathBuf {
        std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
    }

    fn q(p: &Path) -> String {
        format!("\"{}\"", real(p).to_string_lossy().replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// The user's cache folder (/private/var/folders/.../C): Metal keeps its compiled GPU programs there.
    fn cache_dir() -> Option<PathBuf> {
        let mut buf = vec![0u8; 1024];
        let n = unsafe { libc::confstr(65538, buf.as_mut_ptr() as *mut c_char, buf.len()) }; // _CS_DARWIN_USER_CACHE_DIR
        if n == 0 || n > buf.len() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(buf.as_ptr() as *const c_char) }.to_string_lossy().into_owned();
        Some(PathBuf::from(s))
    }

    pub fn lock(read: &[PathBuf], write: &[PathBuf], exe: &Path) -> Result<(), String> {
        let any = |v: &[PathBuf]| v.iter().map(|p| format!(" (subpath {})", q(p))).collect::<String>();
        // the engine's own folder and the ones above it, as lists of names only (not what is in their files or in the
        // folders below): Metal looks for its GPU programs next to the program and stops the engine when it may not
        // (never the home folder itself or /Users: stop below the home folder)
        let home = dirs::home_dir().map(|h| real(&h));
        let mut up = String::new();
        let mut d = real(exe).parent().map(|p| p.to_path_buf());
        while let Some(x) = d {
            if Some(&x) == home.as_ref() || x == Path::new("/Users") || x == Path::new("/") {
                break;
            }
            up.push_str(&format!(" (literal {})", q(&x)));
            d = x.parent().map(|p| p.to_path_buf());
        }
        let mut rw = write.to_vec();
        rw.extend(cache_dir());
        // later rules win: everything is allowed, then the network, programs, writing and your folders are taken
        // away, then the engine's own folders are given back
        let profile = format!(
            "(version 1)\n(allow default)\n(deny network*)\n(deny process-fork)\n(deny process-exec)\n(allow process-exec (literal {exe}))\n\
             (deny appleevent-send)\n\
             (deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\") (global-name \"com.apple.pasteboard.1\") \
             (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.dock.server\"))\n\
             (deny file-write*)\n(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n\
             (deny file-read-data (subpath \"/Users\") (subpath \"/Volumes\") (subpath \"/private/var/folders\") (subpath \"/private/tmp\") \
             (subpath \"/Library/Keychains\") (subpath \"/private/var/root\"))\n\
             (allow file-read-data (literal {exe}){up}{r})\n{w}",
            exe = q(exe),
            r = any(read),
            // only with folders named: an empty rule would allow every file
            w = if rw.is_empty() { String::new() } else { format!("(allow file-read-data file-write*{})\n", any(&rw)) }
        );
        let c = CString::new(profile).map_err(|e| e.to_string())?;
        let mut err: *mut c_char = std::ptr::null_mut();
        if unsafe { sandbox_init(c.as_ptr(), 0, &mut err) } == 0 {
            return Ok(());
        }
        let msg = if err.is_null() { "sandbox_init failed".to_string() } else { unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned() };
        if !err.is_null() {
            unsafe { sandbox_free_error(err) };
        }
        Err(msg)
    }
}

#[cfg(windows)]
mod win {
    use super::{Exit, Io, Rules};
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    type Psid = *mut c_void;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill: u32,
        flags: u32,
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: Handle,
        std_output: Handle,
        std_error: Handle,
    }
    #[repr(C)]
    struct StartupInfoExW {
        info: StartupInfoW,
        attributes: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }
    #[repr(C)]
    struct SecurityCapabilities {
        sid: Psid,
        capabilities: *mut c_void,
        count: u32,
        reserved: u32,
    }
    #[repr(C)]
    struct TrusteeW {
        multiple: *mut TrusteeW,
        multiple_op: i32,
        form: i32,
        kind: i32,
        name: *mut u16,
    }
    #[repr(C)]
    struct ExplicitAccessW {
        permissions: u32,
        mode: i32,
        inheritance: u32,
        trustee: TrusteeW,
    }
    #[repr(C)]
    struct BasicLimit {
        per_process_user_time: i64,
        per_job_user_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(read: *mut Handle, write: *mut Handle, sa: *const SecurityAttributes, size: u32) -> i32;
        fn SetHandleInformation(h: Handle, mask: u32, flags: u32) -> i32;
        fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *const SecurityAttributes, disposition: u32, flags: u32, template: Handle) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(list: *mut c_void, flags: u32, attribute: usize, value: *const c_void, size: usize, previous: *mut c_void, returned: *mut usize) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(app: *const u16, cmd: *mut u16, pa: *const SecurityAttributes, ta: *const SecurityAttributes, inherit: i32, flags: u32,
                          env: *const c_void, cwd: *const u16, si: *const StartupInfoW, pi: *mut ProcessInformation) -> i32;
        fn ResumeThread(h: Handle) -> u32;
        fn TerminateProcess(h: Handle, code: u32) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
        fn CreateJobObjectW(sa: *const SecurityAttributes, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetNamedSecurityInfoW(name: *const u16, kind: i32, info: u32, owner: *mut Psid, group: *mut Psid, dacl: *mut *mut c_void,
                                 sacl: *mut *mut c_void, descriptor: *mut *mut c_void) -> u32;
        fn SetEntriesInAclW(count: u32, entries: *const ExplicitAccessW, old: *const c_void, new: *mut *mut c_void) -> u32;
        fn SetNamedSecurityInfoW(name: *const u16, kind: i32, info: u32, owner: Psid, group: Psid, dacl: *const c_void, sacl: *const c_void) -> u32;
    }
    #[link(name = "userenv")]
    extern "system" {
        fn CreateAppContainerProfile(name: *const u16, display: *const u16, description: *const u16, capabilities: *const c_void, count: u32, sid: *mut Psid) -> i32;
        fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Psid) -> i32;
    }

    const CONTAINER: &str = "planetCompute.engine";
    const SE_FILE_OBJECT: i32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const GRANT_ACCESS: i32 = 1;
    const TRUSTEE_IS_SID: i32 = 0;
    const TRUSTEE_IS_WELL_KNOWN_GROUP: i32 = 5;
    const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 3;
    const READ_EXECUTE: u32 = 0x0012_00A9; // FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
    const ALL_ACCESS: u32 = 0x001F_01FF; // FILE_ALL_ACCESS
    const ALREADY_EXISTS: i32 = 0x8007_00B7u32 as i32;
    const HANDLE_FLAG_INHERIT: u32 = 1;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_SUSPENDED: u32 = 0x4;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const STARTF_USESTDHANDLES: u32 = 0x100;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_LIMITS: u32 = 0x8 | 0x400 | 0x2000; // ACTIVE_PROCESS (1), DIE_ON_UNHANDLED_EXCEPTION, KILL_ON_JOB_CLOSE
    const INFINITE: u32 = 0xFFFF_FFFF;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// The engines' AppContainer (made once; its SID kept for the program's life).
    fn container() -> Result<Psid, String> {
        static SID: std::sync::OnceLock<Result<usize, String>> = std::sync::OnceLock::new();
        SID.get_or_init(|| {
            let name = wide(CONTAINER.as_ref());
            let shown = wide("planetCompute engine".as_ref());
            let mut sid: Psid = null_mut();
            let hr = unsafe { CreateAppContainerProfile(name.as_ptr(), shown.as_ptr(), shown.as_ptr(), null(), 0, &mut sid) };
            if hr == ALREADY_EXISTS {
                let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
                if hr != 0 {
                    return Err(format!("AppContainer: error {hr:#x}"));
                }
            } else if hr != 0 {
                return Err(format!("AppContainer: error {hr:#x}"));
            }
            Ok(sid as usize)
        })
        .clone()
        .map(|s| s as Psid)
    }

    /// Give the container access to a file or folder (a folder: everything in it, now and later). Once per run.
    fn grant(path: &Path, sid: Psid, access: u32) -> Result<(), String> {
        static DONE: std::sync::Mutex<Vec<(std::path::PathBuf, u32)>> = std::sync::Mutex::new(Vec::new());
        let key = (path.to_path_buf(), access);
        if DONE.lock().unwrap().contains(&key) {
            return Ok(());
        }
        let dir = path.is_dir();
        let w = wide(path.as_os_str());
        let (mut dacl, mut sd, mut new): (*mut c_void, *mut c_void, *mut c_void) = (null_mut(), null_mut(), null_mut());
        let e = unsafe { GetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut dacl, null_mut(), &mut sd) };
        if e != 0 {
            return Err(format!("{}: cannot read its permissions (error {e})", path.display()));
        }
        let ea = ExplicitAccessW {
            permissions: access,
            mode: GRANT_ACCESS,
            inheritance: if dir { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { 0 },
            trustee: TrusteeW { multiple: null_mut(), multiple_op: 0, form: TRUSTEE_IS_SID, kind: TRUSTEE_IS_WELL_KNOWN_GROUP, name: sid as *mut u16 },
        };
        let e = unsafe { SetEntriesInAclW(1, &ea, dacl, &mut new) };
        unsafe { LocalFree(sd) };
        if e != 0 {
            return Err(format!("{}: cannot add the engine's access (error {e})", path.display()));
        }
        let e = unsafe { SetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), new, null()) };
        unsafe { LocalFree(new) };
        if e != 0 {
            return Err(format!("{}: cannot give the engine access (error {e})", path.display()));
        }
        DONE.lock().unwrap().push(key);
        Ok(())
    }

    /// One argument as Windows programs read their command line.
    fn quote(arg: &str, out: &mut String) {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            out.push_str(arg);
            return;
        }
        out.push('"');
        let mut slashes = 0;
        for c in arg.chars() {
            if c == '\\' {
                slashes += 1;
                continue;
            }
            let n = if c == '"' { slashes * 2 + 1 } else { slashes };
            out.extend(std::iter::repeat('\\').take(n));
            slashes = 0;
            out.push(c);
        }
        out.extend(std::iter::repeat('\\').take(slashes * 2));
        out.push('"');
    }

    pub struct Child {
        process: usize,
        job: usize,
    }

    impl Child {
        pub fn kill(&mut self) -> std::io::Result<()> {
            if unsafe { TerminateProcess(self.process as Handle, 1) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
        fn exit(&self) -> Exit {
            let mut code = 0u32;
            unsafe { GetExitCodeProcess(self.process as Handle, &mut code) };
            Exit { ok: code == 0, code: Some(code as i32) }
        }
        pub fn wait(&mut self) -> std::io::Result<Exit> {
            unsafe { WaitForSingleObject(self.process as Handle, INFINITE) };
            Ok(self.exit())
        }
        pub fn try_wait(&mut self) -> std::io::Result<Option<Exit>> {
            Ok(if unsafe { WaitForSingleObject(self.process as Handle, 0) } == 0 { Some(self.exit()) } else { None })
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.process as Handle);
                CloseHandle(self.job as Handle); // the job ends the engine if it still runs
            }
        }
    }

    pub fn spawn(exe: &Path, args: &[String], envs: &[(String, String)], rules: &Rules, io: &Io) -> Result<(Child, Option<File>, Option<File>, Option<File>), String> {
        let sid = container()?;
        for d in &rules.read {
            grant(d, sid, READ_EXECUTE)?;
        }
        for d in &rules.write {
            grant(d, sid, ALL_ACCESS)?;
        }
        // the engine program itself (already readable where Windows installs programs, so a refusal there is fine)
        let _ = grant(exe, sid, READ_EXECUTE);
        let sa = SecurityAttributes { length: std::mem::size_of::<SecurityAttributes>() as u32, descriptor: null_mut(), inherit: 1 };
        let nul = unsafe { CreateFileW(wide("NUL".as_ref()).as_ptr(), 0xC000_0000, 3, &sa, 3, 0, null_mut()) };
        if nul as isize == -1 {
            return Err(format!("cannot open NUL: {}", std::io::Error::last_os_error()));
        }
        // (the engine's end, this program's end) of each pipe; this program's ends are not inherited
        let pipe = |on: bool, engine_reads: bool| -> Result<(Handle, Handle), String> {
            if !on {
                return Ok((nul, null_mut()));
            }
            let (mut r, mut w): (Handle, Handle) = (null_mut(), null_mut());
            if unsafe { CreatePipe(&mut r, &mut w, &sa, 0) } == 0 {
                return Err(format!("cannot make a pipe: {}", std::io::Error::last_os_error()));
            }
            let (engine, ours) = if engine_reads { (r, w) } else { (w, r) };
            unsafe { SetHandleInformation(ours, HANDLE_FLAG_INHERIT, 0) };
            Ok((engine, ours))
        };
        let close = |h: Handle| {
            if !h.is_null() && h != nul {
                unsafe { CloseHandle(h) };
            }
        };
        let (in_e, in_o) = pipe(io.stdin, true)?;
        let (out_e, out_o) = pipe(io.stdout, false)?;
        let (err_e, err_o) = pipe(io.stderr, false)?;
        let mut handles: Vec<Handle> = vec![in_e];
        for h in [out_e, err_e] {
            if !handles.contains(&h) {
                handles.push(h);
            }
        }
        // the attributes: the AppContainer, and which handles the engine inherits (only its three)
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size) };
        let mut list = vec![0u8; size.max(64)];
        let attrs = list.as_mut_ptr() as *mut c_void;
        let caps = SecurityCapabilities { sid, capabilities: null_mut(), count: 0, reserved: 0 };
        let ok = unsafe {
            InitializeProcThreadAttributeList(attrs, 2, 0, &mut size) != 0
                && UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &caps as *const SecurityCapabilities as *const c_void,
                    std::mem::size_of::<SecurityCapabilities>(), null_mut(), null_mut()) != 0
                && UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.as_ptr() as *const c_void,
                    handles.len() * std::mem::size_of::<Handle>(), null_mut(), null_mut()) != 0
        };
        let fail = |what: String| {
            for h in [in_e, in_o, out_e, out_o, err_e, err_o] {
                close(h);
            }
            unsafe { CloseHandle(nul) };
            what
        };
        if !ok {
            return Err(fail(format!("cannot set up the sandbox: {}", std::io::Error::last_os_error())));
        }
        let mut si: StartupInfoExW = unsafe { std::mem::zeroed() };
        si.info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
        si.info.flags = STARTF_USESTDHANDLES;
        si.info.std_input = in_e;
        si.info.std_output = out_e;
        si.info.std_error = err_e;
        si.attributes = attrs;
        let mut cmd = String::new();
        quote(&exe.to_string_lossy(), &mut cmd);
        for a in args {
            cmd.push(' ');
            quote(a, &mut cmd);
        }
        let mut cmd = wide(cmd.as_ref());
        // the environment: this program's, with the engine's extra variables
        let mut vars: Vec<(String, String)> = std::env::vars_os()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            .filter(|(k, _)| !envs.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)))
            .collect();
        vars.extend(envs.iter().cloned());
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in &vars {
            block.extend(format!("{k}={v}").encode_utf16());
            block.push(0);
        }
        block.push(0);
        let cwd = wide(rules.read.first().map(|p| p.as_os_str()).unwrap_or_else(|| exe.as_os_str()));
        let mut pi: ProcessInformation = unsafe { std::mem::zeroed() };
        let started = unsafe {
            CreateProcessW(wide(exe.as_os_str()).as_ptr(), cmd.as_mut_ptr(), null(), null(), 1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                block.as_ptr() as *const c_void, cwd.as_ptr(), &si.info, &mut pi) != 0
        };
        let why = std::io::Error::last_os_error();
        unsafe { DeleteProcThreadAttributeList(attrs) };
        for h in [in_e, out_e, err_e] {
            close(h); // the engine has its own now
        }
        unsafe { CloseHandle(nul) };
        if !started {
            for h in [in_o, out_o, err_o] {
                close(h);
            }
            return Err(format!("cannot start it in its sandbox: {why}"));
        }
        // its job: one process (it starts no other program), ended when this program ends
        let job = unsafe { CreateJobObjectW(null(), null()) };
        let mut lim: ExtendedLimit = unsafe { std::mem::zeroed() };
        lim.basic.flags = JOB_LIMITS;
        lim.basic.active_processes = 1;
        let jailed = !job.is_null()
            && unsafe { SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, &lim as *const ExtendedLimit as *const c_void, std::mem::size_of::<ExtendedLimit>() as u32) } != 0
            && unsafe { AssignProcessToJobObject(job, pi.process) } != 0;
        if !jailed {
            let why = std::io::Error::last_os_error();
            unsafe {
                TerminateProcess(pi.process, 1);
                CloseHandle(pi.thread);
                CloseHandle(pi.process);
                if !job.is_null() {
                    CloseHandle(job);
                }
            }
            for h in [in_o, out_o, err_o] {
                close(h);
            }
            return Err(format!("cannot limit it to one process: {why}"));
        }
        unsafe {
            ResumeThread(pi.thread);
            CloseHandle(pi.thread);
        }
        let file = |h: Handle| if h.is_null() { None } else { Some(unsafe { File::from_raw_handle(h) }) };
        Ok((Child { process: pi.process as usize, job: job as usize }, file(in_o), file(out_o), file(err_o)))
    }
}
