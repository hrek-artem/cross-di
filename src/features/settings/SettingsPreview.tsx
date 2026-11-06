import IslandCapsule from "../island/IslandCapsule";
import type { IslandSettings } from "../island/preferences";

const sampleTrack = { title: "Sample track", artist: "Music preview", playing: true };

type Props = {
  settings: IslandSettings;
  showIdle: boolean;
  disabled: boolean;
  saving: boolean;
  status: string;
  onApply: () => void;
};

export default function SettingsPreview({ settings, showIdle, disabled, saving, status, onApply }: Props) {
  const idlePreview = showIdle || !settings.showMusic;
  return (
    <aside className="settings-glass settings-preview-panel" aria-label="Island preview">
      <h2>Preview</h2>
      <div
        className="settings-preview-screen"
        data-alignment={settings.alignment}
        style={{ paddingTop: 12 + settings.topOffset / 4 }}
      >
        <IslandCapsule settings={settings} track={idlePreview ? null : sampleTrack} idlePreview={idlePreview} />
      </div>
      <button className="settings-apply" type="button" disabled={disabled} onClick={onApply}>
        {saving ? "Applying…" : "Apply changes"}
      </button>
      <p className="settings-apply-status" role="status">{status}</p>
    </aside>
  );
}
