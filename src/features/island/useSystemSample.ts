import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type SystemSample = Record<
  "cpu" | "gpu" | "ram" | "disk" | "upload" | "download" | "gpuTemperature" | "systemTemperature",
  number | null
>;

export function percent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

export function temperature(sample: SystemSample | null) {
  const value = sample?.gpuTemperature ?? sample?.systemTemperature;
  const label = sample?.gpuTemperature != null ? "GPU temperature" : "System thermal zone";
  return { label, value: value == null ? "—" : `${Math.round(value)}°C` };
}

export function useSystemSample(enabled: boolean) {
  const [sample, setSample] = useState<SystemSample | null>(null);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let active = true;
    let timer: number;
    async function poll() {
      const value = await invoke<SystemSample>("get_system_sample").catch(() => null);
      if (!active) return;
      setSample(value);
      timer = window.setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  return sample;
}
