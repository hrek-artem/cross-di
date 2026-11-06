import type { SettingsEditorProps } from "../../island/preferences";
import BrowserConnection from "../BrowserConnection";

export default function Music({ settings, onChange, disabled }: SettingsEditorProps) {
  return (
    <div className="settings-glass settings-card">
      <h2>Music</h2>
      <p>Show music from desktop players and browsers. A playing track takes priority over paused media.</p>
      <p>Browser playback appears when the website shares media with Windows. Artwork, seeking and track controls depend on the website.</p>

      <fieldset className="settings-fields" disabled={disabled} aria-label="Music display">
        <label className="settings-field">
          <span>Show now playing</span>
          <input
            type="checkbox"
            checked={settings.showMusic}
            onChange={(event) => onChange({ showMusic: event.currentTarget.checked })}
          />
        </label>
      </fieldset>
      <BrowserConnection />
    </div>
  );
}
