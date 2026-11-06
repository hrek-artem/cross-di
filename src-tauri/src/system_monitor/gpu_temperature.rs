use std::ffi::c_void;
use windows::{
    Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW},
    },
    core::{s, w},
};

type NvmlDevice = *mut c_void;
type Shutdown = unsafe extern "C" fn() -> i32;
type ReadTemperature = unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> i32;

pub(super) struct GpuTemperature {
    module: HMODULE,
    device: NvmlDevice,
    shutdown: Shutdown,
    temperature: ReadTemperature,
}

impl GpuTemperature {
    pub(super) fn open() -> Option<Self> {
        let module =
            unsafe { LoadLibraryExW(w!("nvml.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()? };
        let result = unsafe { Self::initialize(module) };
        if result.is_none() {
            unsafe {
                let _ = FreeLibrary(module);
            }
        }
        result
    }

    unsafe fn initialize(module: HMODULE) -> Option<Self> {
        // NVML exports these C entry points. The module stays loaded while we use them.
        unsafe {
            let init: unsafe extern "C" fn() -> i32 =
                std::mem::transmute(GetProcAddress(module, s!("nvmlInit_v2"))?);
            let shutdown: Shutdown =
                std::mem::transmute(GetProcAddress(module, s!("nvmlShutdown"))?);
            let handle: unsafe extern "C" fn(u32, *mut NvmlDevice) -> i32 =
                std::mem::transmute(GetProcAddress(module, s!("nvmlDeviceGetHandleByIndex_v2"))?);
            let temperature: ReadTemperature =
                std::mem::transmute(GetProcAddress(module, s!("nvmlDeviceGetTemperature"))?);
            if init() != 0 {
                return None;
            }
            let mut device = std::ptr::null_mut();
            if handle(0, &mut device) != 0 || device.is_null() {
                shutdown();
                return None;
            }
            Some(Self {
                module,
                device,
                shutdown,
                temperature,
            })
        }
    }

    pub(super) fn read(&self) -> Option<f64> {
        const NVML_TEMPERATURE_GPU: u32 = 0;
        let mut temperature = 0;
        let status =
            unsafe { (self.temperature)(self.device, NVML_TEMPERATURE_GPU, &mut temperature) };
        (status == 0 && temperature > 0 && temperature <= 150).then(|| f64::from(temperature))
    }
}

impl Drop for GpuTemperature {
    fn drop(&mut self) {
        unsafe {
            (self.shutdown)();
            let _ = FreeLibrary(self.module);
        }
    }
}
