// llama.cpp inside the program (llama-cpp-2 crate, statically linked). Shown as planetCompute.cpp, PlanetCompute's
// copy of llama.cpp (planetCompute-CPP/llama.cpp), always with the llama.cpp commit it is based on (MIT licence:
// the original's name and notice stay). Today the copy is unchanged; speed patches will go on top of it.
const ENGINE: &str = "planetCompute.cpp (based on llama.cpp d812350)";

#[cfg(feature = "llama")]
use std::sync::OnceLock;

/// llama.cpp's backend, started once per process and shared (Harness generation, the version line).
#[cfg(feature = "llama")]
pub fn backend() -> Result<&'static llama_cpp_2::llama_backend::LlamaBackend, String> {
    static BACKEND: OnceLock<Result<llama_cpp_2::llama_backend::LlamaBackend, String>> = OnceLock::new();
    BACKEND.get_or_init(|| llama_cpp_2::llama_backend::LlamaBackend::init().map_err(|e| e.to_string())).as_ref().map_err(|e| e.clone())
}

#[cfg(feature = "llama")]
pub fn info() -> String {
    match backend() {
        Ok(_) => {
            let sys = unsafe { std::ffi::CStr::from_ptr(llama_cpp_sys_2::llama_print_system_info()) };
            format!("{ENGINE}: {}", sys.to_string_lossy().trim())
        }
        Err(e) => format!("{ENGINE}: failed to start ({e})"),
    }
}

#[cfg(not(feature = "llama"))]
pub fn info() -> String {
    format!("{ENGINE}: not in this build")
}

/// The computer's devices as llama.cpp's ggml sees them (the image engine is built on the same ggml and sees the same
/// ones): (description, "GPU" / "iGPU" / "CPU" / "other", total bytes, free bytes). The CPU's are the computer's memory.
#[cfg(feature = "llama")]
pub fn devices() -> Vec<(String, String, u64, u64)> {
    if backend().is_err() {
        return Vec::new();
    }
    use llama_cpp_2::LlamaBackendDeviceType as T;
    llama_cpp_2::list_llama_ggml_backend_devices()
        .into_iter()
        .map(|d| {
            let kind = match d.device_type {
                T::Gpu => "GPU",
                T::IntegratedGpu => "iGPU",
                T::Cpu => "CPU",
                _ => "other",
            };
            (if d.description.is_empty() { d.name } else { d.description }, kind.to_string(), d.memory_total as u64, d.memory_free as u64)
        })
        .collect()
}

#[cfg(not(feature = "llama"))]
pub fn devices() -> Vec<(String, String, u64, u64)> {
    Vec::new()
}
