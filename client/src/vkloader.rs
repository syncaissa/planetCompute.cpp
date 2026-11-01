// Windows Vulkan build: one planetCompute.exe for every PC, with or without a graphics card.
// vulkan-1.dll (the Vulkan loader, normally installed with the graphics driver) is delay-loaded (build.rs), so the
// program starts without it. When the PC has none, the copy carried inside (the Khronos loader from the Vulkan SDK,
// Apache 2.0, see client/VULKAN_LOADER.txt) is written to <data>/bin and loaded before llama.cpp needs it: Vulkan
// then finds no GPU and chat runs on the processor. The image engine lives in the same folder, so it finds the copy
// too and falls back to the processor (image.rs MODES). llama.cpp reaches Vulkan only through vkGetInstanceProcAddr,
// so with no loader at all (the copy could not be written) the first call would stop the program: status() says so.

#[cfg(has_vkloader)]
static LOADER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/vulkan-1.dll"));

static STATE: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

/// Call first in main, before llama.cpp starts.
pub fn ensure() {
    STATE.get_or_init(pick);
}

/// No graphics driver on this PC (the carried loader is in use, or none): the GPU cannot be used.
pub fn no_gpu() -> bool {
    status().starts_with("Vulkan: no graphics driver") || status().starts_with("Vulkan: none")
}

/// Which Vulkan loader is in use (for --version and the program's info).
pub fn status() -> &'static str {
    STATE.get().copied().unwrap_or("not checked")
}

#[cfg(has_vkloader)]
fn pick() -> &'static str {
    use windows_sys::Win32::System::LibraryLoader::{LoadLibraryExW, LoadLibraryW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    let wide = |s: &std::ffi::OsStr| -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    };
    let copy = crate::image::data().join("bin").join("vulkan-1.dll");
    // the PC's own loader (from the graphics driver): use it, and drop a copy written on an earlier start. Only from
    // System32, never from the program's own folder (often Downloads, where a planted vulkan-1.dll would be loaded:
    // security review P9)
    let own = wide(std::ffi::OsStr::new("vulkan-1.dll"));
    if !unsafe { LoadLibraryExW(own.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) }.is_null() {
        let _ = std::fs::remove_file(&copy);
        return "Vulkan: this computer's loader";
    }
    if std::fs::metadata(&copy).map(|m| m.len() != LOADER.len() as u64).unwrap_or(true) {
        let tmp = copy.with_extension("tmp");
        let ok = copy.parent().map_or(false, |d| std::fs::create_dir_all(d).is_ok())
            && std::fs::write(&tmp, LOADER).is_ok()
            && std::fs::rename(&tmp, &copy).is_ok();
        if !ok {
            return "Vulkan: none (could not write the carried loader to the data folder): chat cannot start";
        }
    }
    // loaded by its full path; the delay-loaded imports then resolve to this module (same name, already loaded)
    if unsafe { LoadLibraryW(wide(copy.as_os_str()).as_ptr()) }.is_null() {
        return "Vulkan: none (the carried loader did not load): chat cannot start";
    }
    "Vulkan: no graphics driver found, the carried loader is used: the processor only"
}

#[cfg(not(has_vkloader))]
fn pick() -> &'static str {
    if cfg!(feature = "vulkan") { "Vulkan: this computer's loader" } else { "Vulkan: not in this build" }
}
