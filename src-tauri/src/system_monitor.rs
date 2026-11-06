use serde::Serialize;

#[cfg(windows)]
mod gpu_temperature;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemSample {
    cpu: Option<f64>,
    gpu: Option<f64>,
    ram: Option<f64>,
    disk: Option<f64>,
    upload: Option<f64>,
    download: Option<f64>,
    gpu_temperature: Option<f64>,
    system_temperature: Option<f64>,
}

#[tauri::command]
pub(crate) async fn get_system_sample() -> Result<SystemSample, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(windows_monitor::read)
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Ok(SystemSample::default())
}

#[cfg(windows)]
mod windows_monitor {
    use super::{SystemSample, gpu_temperature::GpuTemperature};
    use std::{
        collections::HashMap,
        sync::{OnceLock, mpsc},
        time::Instant,
    };
    use windows::{
        Win32::{
            NetworkManagement::{
                IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2},
                Ndis::IfOperStatusUp,
            },
            System::{
                Performance::{
                    PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE,
                    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
                    PDH_MORE_DATA, PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
                    PdhGetFormattedCounterArrayW, PdhGetFormattedCounterValue, PdhOpenQueryW,
                },
                SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            },
        },
        core::{PCWSTR, w},
    };

    type Interfaces = HashMap<u32, (u64, u64)>;
    type Request = mpsc::Sender<SystemSample>;

    pub(super) fn read() -> Result<SystemSample, String> {
        // Keep PDH handles and previous samples together on one worker.
        static MONITOR: OnceLock<mpsc::Sender<Request>> = OnceLock::new();
        let requests = MONITOR.get_or_init(|| {
            let (send, receive) = mpsc::channel::<Request>();
            std::thread::spawn(move || {
                let query = PerformanceQuery::open();
                let gpu_temperature = GpuTemperature::open();
                let mut previous = None;
                for reply in receive {
                    let (download, upload) = network_rates(&mut previous).unwrap_or_default();
                    let mut sample = query
                        .as_ref()
                        .map(PerformanceQuery::read)
                        .unwrap_or_default();
                    sample.ram = memory_usage();
                    sample.upload = upload;
                    sample.download = download;
                    sample.gpu_temperature =
                        gpu_temperature.as_ref().and_then(GpuTemperature::read);
                    let _ = reply.send(sample);
                }
            });
            send
        });
        let (reply, sample) = mpsc::channel();
        requests.send(reply).map_err(|error| error.to_string())?;
        sample.recv().map_err(|error| error.to_string())
    }

    struct PerformanceQuery {
        query: PDH_HQUERY,
        cpu: Option<PDH_HCOUNTER>,
        gpu: Option<PDH_HCOUNTER>,
        disk: Option<PDH_HCOUNTER>,
        thermal_zones: Option<PDH_HCOUNTER>,
    }

    impl PerformanceQuery {
        fn open() -> Option<Self> {
            let mut query = PDH_HQUERY::default();
            if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
                return None;
            }
            let add = |path: PCWSTR| {
                let mut counter = PDH_HCOUNTER::default();
                (unsafe { PdhAddEnglishCounterW(query, path, 0, &mut counter) } == 0)
                    .then_some(counter)
            };
            Some(Self {
                query,
                cpu: add(w!("\\Processor(_Total)\\% Processor Time")),
                gpu: add(w!("\\GPU Engine(*)\\Utilization Percentage")),
                disk: add(w!("\\PhysicalDisk(_Total)\\% Idle Time")),
                thermal_zones: add(w!("\\Thermal Zone Information(*)\\Temperature")),
            })
        }

        fn read(&self) -> SystemSample {
            if unsafe { PdhCollectQueryData(self.query) } != 0 {
                return SystemSample::default();
            }
            SystemSample {
                cpu: self.cpu.and_then(counter_value),
                gpu: self.gpu.and_then(gpu_usage),
                disk: self.disk.and_then(counter_value).map(|idle| 100.0 - idle),
                system_temperature: self.thermal_zones.and_then(thermal_zone_temperature),
                ..SystemSample::default()
            }
        }
    }

    impl Drop for PerformanceQuery {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    fn formatted(value: PDH_FMT_COUNTERVALUE) -> Option<f64> {
        if !matches!(value.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA) {
            return None;
        }
        let value = unsafe { value.Anonymous.doubleValue };
        value.is_finite().then_some(value)
    }

    fn counter_value(counter: PDH_HCOUNTER) -> Option<f64> {
        let mut value = PDH_FMT_COUNTERVALUE::default();
        if unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) } != 0 {
            return None;
        }
        formatted(value).map(|value| value.clamp(0.0, 100.0))
    }

    fn counter_array(
        counter: PDH_HCOUNTER,
        format: windows::Win32::System::Performance::PDH_FMT,
    ) -> Option<Vec<PDH_FMT_COUNTERVALUE_ITEM_W>> {
        let (mut bytes, mut count) = (0, 0);
        let status =
            unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut bytes, &mut count, None) };
        if status != PDH_MORE_DATA || bytes == 0 || bytes > 4 * 1024 * 1024 {
            return None;
        }
        let mut buffer = vec![
            PDH_FMT_COUNTERVALUE_ITEM_W::default();
            (bytes as usize).div_ceil(size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>())
        ];
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                format,
                &mut bytes,
                &mut count,
                Some(buffer.as_mut_ptr()),
            )
        };
        if status != 0 {
            return None;
        }
        buffer.truncate(count as usize);
        Some(buffer)
    }

    fn gpu_usage(counter: PDH_HCOUNTER) -> Option<f64> {
        let mut engines = HashMap::<String, f64>::new();
        for item in counter_array(counter, PDH_FMT_DOUBLE)? {
            if let Some(value) = formatted(item.FmtValue)
                && !item.szName.is_null()
                && let Ok(name) = unsafe { item.szName.to_string() }
                && let Some((_, engine)) = name.split_once("_luid_")
            {
                let engine = engine.split('#').next().unwrap_or(engine);
                *engines.entry(engine.to_owned()).or_default() += value;
            }
        }
        // Each engine is reported per process. Use the busiest physical engine.
        engines
            .into_values()
            .reduce(f64::max)
            .map(|value| value.min(100.0))
    }

    fn thermal_zone_temperature(counter: PDH_HCOUNTER) -> Option<f64> {
        use windows::Win32::System::Performance::PDH_FMT;

        const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
        counter_array(counter, PDH_FMT(PDH_FMT_DOUBLE.0 | PDH_FMT_NOCAP100))?
            .into_iter()
            .filter_map(|item| formatted(item.FmtValue))
            .map(|kelvin| kelvin - 273.15)
            .filter(|celsius| (0.0..=150.0).contains(celsius))
            .reduce(f64::max)
    }

    fn memory_usage() -> Option<f64> {
        let mut status = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
        Some(f64::from(status.dwMemoryLoad))
    }

    fn network_rates(
        previous: &mut Option<(Instant, Interfaces)>,
    ) -> Option<(Option<f64>, Option<f64>)> {
        let mut table = std::ptr::null_mut();
        if unsafe { GetIfTable2(&mut table) }.0 != 0 || table.is_null() {
            return None;
        }
        let interfaces: Interfaces = unsafe {
            let rows = std::slice::from_raw_parts(
                std::ptr::addr_of!((*table).Table).cast::<MIB_IF_ROW2>(),
                (*table).NumEntries as usize,
            );
            let interfaces = rows
                .iter()
                // The first flag identifies hardware interfaces and avoids double-counting VPNs.
                .filter(|row| {
                    row.OperStatus == IfOperStatusUp
                        && row.InterfaceAndOperStatusFlags._bitfield & 1 != 0
                })
                .map(|row| (row.InterfaceIndex, (row.InOctets, row.OutOctets)))
                .collect();
            FreeMibTable(table.cast());
            interfaces
        };
        let now = Instant::now();
        let rates = previous.as_ref().map(|(time, old)| {
            let elapsed = now.duration_since(*time).as_secs_f64();
            let mut download = 0.0;
            let mut upload = 0.0;
            for (id, (incoming, outgoing)) in &interfaces {
                if let Some((old_in, old_out)) = old.get(id) {
                    download += incoming.saturating_sub(*old_in) as f64 / elapsed;
                    upload += outgoing.saturating_sub(*old_out) as f64 / elapsed;
                }
            }
            (Some(download), Some(upload))
        });
        *previous = Some((now, interfaces));
        rates
    }
}
