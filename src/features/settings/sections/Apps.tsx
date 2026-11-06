import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import AppIcon, { useAppIcons } from "../../island/AppIcon";
import type { AppShortcut, SettingsEditorProps } from "../../island/preferences";

export default function Apps({ settings, onChange, disabled }: SettingsEditorProps) {
  const [catalog, setCatalog] = useState<AppShortcut[] | null>(null);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState(false);
  const { pinnedApps } = settings;
  const icons = useAppIcons(pinnedApps, settings.pinnedAppIcons);
  const available = catalog?.filter((app) => !pinnedApps.some((pinned) => pinned.id === app.id));
  const selected = available?.find((app) => app.id === selection);

  useEffect(() => {
    let active = true;
    void invoke<AppShortcut[]>("get_installed_apps")
      .then((apps) => { if (active) setCatalog(apps); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);

  return (
    <div className="settings-glass settings-card">
      <h2>Apps</h2>
      <p>Pin up to six apps to the island, then select Apply changes.</p>
      <fieldset className="settings-fields" disabled={disabled} aria-label="Pinned apps">
        <div className="settings-field settings-app-picker">
          <select aria-label="Installed app" value={selection} onChange={(event) => setSelection(event.currentTarget.value)} disabled={!available?.length || pinnedApps.length >= 6}>
            <option value="">{error ? "Could not load installed apps" : catalog ? "Choose an app" : "Loading apps…"}</option>
            {available?.map((app) => <option key={app.id} value={app.id}>{app.label}</option>)}
          </select>
          <button type="button" className="settings-pin-button" disabled={!selected || pinnedApps.length >= 6} onClick={() => {
            if (!selected) return;
            onChange({ pinnedApps: [...pinnedApps, selected] });
            setSelection("");
          }}>Pin</button>
        </div>
        {pinnedApps.map((app) => (
          <div className="settings-field" key={app.id}>
            <span className="settings-pinned-app"><AppIcon src={icons[app.id]} />{app.label}</span>
            <button type="button" className="settings-pin-button" aria-label={`Remove ${app.label}`} onClick={() => onChange({ pinnedApps: pinnedApps.filter((pinned) => pinned.id !== app.id) })}>Remove</button>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
