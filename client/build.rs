// SD_CLI = path of a stable-diffusion.cpp sd-cli program built for this platform (CI does it, see
// stable-diffusion.cpp/PLANETCOMPUTE_SOURCE.txt). When given, it is carried inside planetCompute (cfg has_sd) and
// image generation works on this computer; without it the program builds as before and says images are not in it.
fn main() {
    // which build this is (2026-10-31, plan_old_programs #1): the commit and its time (unix seconds; the same commit always
    // gives the same number, newer commits a bigger one). PC_COMMIT / PC_BUILD_TIME override; no git = "dev" / 0.
    println!("cargo:rerun-if-env-changed=PC_COMMIT");
    println!("cargo:rerun-if-env-changed=PC_BUILD_TIME");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    let git = |args: &[&str]| std::process::Command::new("git").args(args).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty());
    let commit = std::env::var("PC_COMMIT").ok().filter(|s| !s.is_empty())
        .or_else(|| git(&["rev-parse", "--short=7", "HEAD"])).unwrap_or_else(|| "dev".into());
    let time = std::env::var("PC_BUILD_TIME").ok().filter(|s| !s.is_empty())
        .or_else(|| git(&["log", "-1", "--format=%ct"])).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let commit: String = commit.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    println!("cargo:rustc-env=PC_COMMIT={}", if commit.is_empty() { "dev" } else { &commit });
    println!("cargo:rustc-env=PC_BUILD_TIME={time}");
    println!("cargo::rustc-check-cfg=cfg(has_sd)");
    println!("cargo:rerun-if-env-changed=SD_CLI");
    if let Some(p) = std::env::var_os("SD_CLI").filter(|p| !p.is_empty()) {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("sd-cli.bin");
        std::fs::copy(&p, &out).unwrap_or_else(|e| panic!("SD_CLI {}: {e}", p.to_string_lossy()));
        println!("cargo:rerun-if-changed={}", p.to_string_lossy());
        println!("cargo:rustc-cfg=has_sd");
    }
    // Windows Vulkan build: delay-load vulkan-1.dll so the program starts on a PC without a graphics driver, and carry
    // the Khronos loader (VULKAN_LOADER_DLL, from the Vulkan SDK; CI sets it) for such PCs (src/vkloader.rs)
    println!("cargo::rustc-check-cfg=cfg(has_vkloader)");
    println!("cargo:rerun-if-env-changed=VULKAN_LOADER_DLL");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if windows && std::env::var_os("CARGO_FEATURE_VULKAN").is_some() {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:vulkan-1.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
        if let Some(p) = std::env::var_os("VULKAN_LOADER_DLL").filter(|p| !p.is_empty()) {
            let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("vulkan-1.dll");
            std::fs::copy(&p, &out).unwrap_or_else(|e| panic!("VULKAN_LOADER_DLL {}: {e}", p.to_string_lossy()));
            println!("cargo:rerun-if-changed={}", p.to_string_lossy());
            println!("cargo:rustc-cfg=has_vkloader");
        }
    }
    // the window's build step only when the window is in this build (the server build has none)
    if std::env::var_os("CARGO_FEATURE_WINDOW").is_some() {
        tauri_build::build()
    }
}
