import type { IslandSettings, SettingsEditorProps } from "../../island/preferences";

export default function Appearance({ settings, onChange, disabled }: SettingsEditorProps) {
  return (
    <div className="settings-glass settings-card">
      <h2>Appearance</h2>
      <p>Customize the island’s colors, finish, and position.</p>

      <fieldset className="settings-fields" disabled={disabled} aria-label="Island appearance">
        <label className="settings-field">
          <span>Background color</span>
          <input type="color" value={settings.backgroundColor} onChange={(event) => onChange({ backgroundColor: event.currentTarget.value })} />
        </label>
        <label className="settings-field">
          <span>Text color</span>
          <input type="color" value={settings.textColor} onChange={(event) => onChange({ textColor: event.currentTarget.value })} />
        </label>
        <label className="settings-field">
          <span>Translucent finish</span>
          <input type="checkbox" checked={settings.glass} onChange={(event) => onChange({ glass: event.currentTarget.checked })} />
        </label>
        <label className="settings-field">
          <span className="settings-field-description">
            Open on hover
            <small>Close 300 ms after the pointer leaves.</small>
          </span>
          <input type="checkbox" checked={settings.openOnHover} onChange={(event) => onChange({ openOnHover: event.currentTarget.checked })} />
        </label>
        <label className="settings-field">
          <span>Position</span>
          <select
            value={settings.alignment}
            onChange={(event) => onChange({ alignment: event.currentTarget.value as IslandSettings["alignment"] })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="settings-field">
          <span>Top offset</span>
          <span className="settings-range">
            <input
              type="range"
              min={0}
              max={120}
              value={settings.topOffset}
              onChange={(event) => onChange({ topOffset: event.currentTarget.valueAsNumber })}
            />
            <span>{settings.topOffset} px</span>
          </span>
        </label>
      </fieldset>
    </div>
  );
}
