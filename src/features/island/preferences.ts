import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type AppShortcut = { id: string; label: string };
export type IdleDisplay = "system" | "clock" | "weather";

export type WeatherCity = {
  id: number;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
};

export type IslandSettings = {
  alignment: "left" | "center" | "right";
  topOffset: number;
  backgroundColor: string;
  textColor: string;
  glass: boolean;
  showMusic: boolean;
  openOnHover: boolean;
  idleDisplay: IdleDisplay;
  weatherCity: WeatherCity | null;
  pinnedApps: AppShortcut[];
  pinnedAppIcons: Record<string, string>;
};

export type SettingsEditorProps = {
  settings: IslandSettings;
  onChange: (changes: Partial<IslandSettings>) => void;
  disabled: boolean;
};

const defaultSettings: IslandSettings = {
  alignment: "center",
  topOffset: 0,
  backgroundColor: "#000000",
  textColor: "#ffffff",
  glass: false,
  showMusic: true,
  openOnHover: false,
  idleDisplay: "system",
  weatherCity: null,
  pinnedApps: [],
  pinnedAppIcons: {},
};

export function useSavedSettings() {
  const [settings, setSettings] = useState(defaultSettings);
  const [ready, setReady] = useState(!isTauri());
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let changed = false;
    let unlisten: UnlistenFn | undefined;

    async function connect() {
      try {
        const stop = await listen<IslandSettings>("island-settings-changed", ({ payload }) => {
          changed = true;
          if (!disposed) setSettings(payload);
        });
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;

        const saved = await invoke<IslandSettings>("get_settings");
        if (!disposed) {
          if (!changed) setSettings(saved);
          setReady(true);
        }
      } catch (error) {
        if (!disposed) setError(String(error));
      }
    }

    void connect();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { settings, setSettings, ready, error };
}
