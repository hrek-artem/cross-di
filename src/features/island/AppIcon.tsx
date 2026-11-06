import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AppShortcut } from "./preferences";
import "./AppIcon.css";

const emptyIcons: Record<string, string> = {};

export function useAppIcons(apps: AppShortcut[], cached: Record<string, string> = emptyIcons) {
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = apps.filter((app) => !cached[app.id]).map((app) => app.id);
    if (!ids.length) return;
    let active = true;
    void invoke<Record<string, string>>("get_app_icons", { ids })
      .then((icons) => { if (active) setIcons(icons); })
      .catch(() => {});
    return () => { active = false; };
  }, [apps, cached]);

  return { ...icons, ...cached };
}

export default function AppIcon({ src }: { src?: string }) {
  return (
    <span className="app-shortcut-icon" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25">
          <rect x="3" y="3" width="14" height="14" rx="4" /><path d="M7 8h6m-6 4h6" />
        </svg>
      )}
    </span>
  );
}
