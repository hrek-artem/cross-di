import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import AppIcon from "../AppIcon";
import type { AppShortcut } from "../preferences";

export default function AppsPage({ apps, icons }: { apps: AppShortcut[]; icons: Record<string, string> }) {
  const [error, setError] = useState("");

  async function open(app: AppShortcut) {
    setError("");
    try {
      await invoke("open_pinned_app", { id: app.id });
    } catch {
      setError(`Could not open ${app.label}.`);
    }
  }

  if (!apps.length) return <p className="island-widget-message">Pin apps from Settings → Apps.</p>;

  return (
    <>
      <div className="island-app-grid" data-count={apps.length}>
        {apps.map((app) => (
          <button key={app.id} type="button" className="island-app-tile" title={app.label} onClick={() => void open(app)}>
            <AppIcon src={icons[app.id]} />
            <span>{app.label}</span>
          </button>
        ))}
      </div>
      {error && <p className="island-widget-message" role="status">{error}</p>}
    </>
  );
}
