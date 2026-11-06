import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";
import { useSavedSettings, type IslandSettings } from "../island/preferences";
import About from "./sections/About";
import Apps from "./sections/Apps";
import Appearance from "./sections/Appearance";
import Idle from "./sections/Idle";
import Music from "./sections/Music";
import SettingsPreview from "./SettingsPreview";
import "./Settings.css";

const sections = [
  {
    id: "appearance",
    title: "Appearance",
    icon: <path d="M4 7h16M4 12h16M4 17h16M8 5v4m8 1v4m-6 1v4" />,
    Content: Appearance,
  },
  {
    id: "music",
    title: "Music",
    icon: <path d="M9 18V6l11-2v12M9 18c0 1.1-1.1 2-2.5 2S4 19.1 4 18s1.1-2 2.5-2S9 16.9 9 18Zm11-2c0 1.1-1.1 2-2.5 2s-2.5-.9-2.5-2 1.1-2 2.5-2 2.5.9 2.5 2Z" />,
    Content: Music,
  },
  {
    id: "idle",
    title: "Idle display",
    icon: <path d="M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
    Content: Idle,
  },
  {
    id: "apps",
    title: "Apps",
    icon: <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" />,
    Content: Apps,
  },
  {
    id: "about",
    title: "About",
    icon: <path d="M12 11v5m0-8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
    Content: About,
  },
] as const;

export default function Settings() {
  const settingsWindow = getCurrentWindow();
  const [activeSection, setActiveSection] = useState<(typeof sections)[number]>(sections[0]);
  const { settings, setSettings, ready, error } = useSavedSettings();
  const [changes, setChanges] = useState<Partial<IslandSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const draft = { ...settings, ...changes };
  const cityRequired = draft.idleDisplay === "weather" && !draft.weatherCity;
  const hasChanges = (Object.keys(changes) as (keyof IslandSettings)[]).some(
    (key) => draft[key] !== settings[key],
  );

  function updateDraft(update: Partial<IslandSettings>) {
    setChanges((previous) => ({ ...previous, ...update }));
    setSaveStatus("");
  }

  async function applySettings() {
    setSaving(true);
    setSaveStatus("");
    try {
      const saved = await invoke<IslandSettings>("save_settings", { settings: draft });
      setSettings(saved);
      setChanges({});
      setSaveStatus("Changes applied.");
    } catch (error) {
      setSaveStatus(`Could not save settings. ${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-titlebar">
        <div
          className="settings-drag-area"
          onMouseDown={(event) => {
            if (event.button === 0) {
              void settingsWindow.startDragging().catch(console.error);
            }
          }}
        >
          Cross Dynamic Island
        </div>
        <div className="settings-window-controls">
          <button
            className="settings-window-button"
            type="button"
            aria-label="Minimize settings"
            title="Minimize"
            onClick={() => void settingsWindow.minimize().catch(console.error)}
          >
            −
          </button>
          <button
            className="settings-window-button"
            type="button"
            aria-label="Close settings"
            title="Close"
            onClick={() => void settingsWindow.hide().catch(console.error)}
          >
            ×
          </button>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-glass settings-sidebar" aria-label="Settings sections">
          {sections.map((section) => (
            <button
              key={section.id}
              className="settings-nav-item"
              type="button"
              aria-current={activeSection.id === section.id ? "true" : undefined}
              onClick={() => setActiveSection(section)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                {section.icon}
              </svg>
              {section.title}
            </button>
          ))}
        </nav>

        <main className="settings-content">
          <section className="settings-section" key={activeSection.id} aria-label={activeSection.title}>
            <activeSection.Content settings={draft} onChange={updateDraft} disabled={!ready || saving} />
          </section>
        </main>

        <SettingsPreview
          settings={draft}
          showIdle={activeSection.id === "idle"}
          disabled={!ready || !hasChanges || saving || cityRequired}
          saving={saving}
          status={error ? `Could not load settings. ${error}` : cityRequired ? "Choose a city before applying." : saveStatus}
          onApply={applySettings}
        />
      </div>
    </div>
  );
}
