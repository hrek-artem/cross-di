import { useEffect, useRef, useState, type CSSProperties } from "react";
import IslandCover from "./IslandCover";
import IslandVideo from "./IslandVideo";
import { positionAt, type NowPlaying, type PlaybackAction } from "./media";

const icons = {
  previous: "M3 3h2v10H3zm10 0v10L6 8z",
  next: "M11 3h2v10h-2zM3 3v10l7-5z",
  play: "M5 3v10l8-5z",
  pause: "M4 3h3v10H4zm5 0h3v10H9z",
};

type Props = {
  visible: boolean;
  track: NowPlaying | null;
  cover?: string | null;
  source?: string;
  playbackPending: boolean;
  onControl: (action: PlaybackAction) => void;
  onCollapse: () => void;
  onOpenSource?: () => void;
  video?: MediaStream | null;
  videoFill: boolean;
  onVideoFill: () => void;
  onActivity: () => void;
};

function timeLabel(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default function IslandPlayer({ visible, track, cover, source, playbackPending, onControl, onCollapse, onOpenSource, video, videoFill, onVideoFill, onActivity }: Props) {
  const [clock, setClock] = useState(() => performance.now());
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const pendingVolume = useRef<number | null>(null);
  const lastVolume = useRef(0.5);
  const volume = volumeDraft ?? track?.volume ?? 1;
  useEffect(() => { if (track && track.volume > 0) lastVolume.current = track.volume; }, [track?.volume]);
  function clearVolume() {
    pendingVolume.current = null;
    setVolumeDraft(null);
  }
  function finishVolume() {
    const level = pendingVolume.current;
    clearVolume();
    if (level !== null) onControl({ type: "volume", level });
  }
  const rate = track?.rate ?? 0;
  const duration = track?.duration ?? 0;

  useEffect(() => {
    if (!visible || rate === 0 || duration === 0) return;
    const timer = window.setInterval(() => setClock(performance.now()), 32);
    return () => window.clearInterval(timer);
  }, [visible, rate, duration]);

  const position = Math.min(duration, seekDraft ?? (track ? positionAt(track, clock) : 0));
  const progress = duration > 0 ? position / duration : 0;

  function clearSeek() {
    pendingSeek.current = null;
    setSeekDraft(null);
  }

  function finishSeek() {
    if (pendingSeek.current !== null) onControl({ type: "seek", seconds: pendingSeek.current });
    clearSeek();
  }

  return (
    <div className="island-player" data-has-track={track != null} data-video={video != null}>
      {video && track ? <IslandVideo stream={video} title={track.title} source={source} onOpen={videoFill ? onActivity : onOpenSource} /> : <div className="island-player-header">
        <IslandCover cover={cover} source={source} onOpen={onOpenSource} />
        <div className="island-player-info">
          <button className="island-player-heading" type="button" aria-label="Collapse from track details" aria-expanded={true} onClick={onCollapse}>
            <strong className="island-track-title" title={track?.title}>{track?.title ?? "Nothing playing"}</strong>
            {(track?.artist || !track) && <span className="island-track-artist">{track?.artist || "Start music to see playback controls."}</span>}
          </button>
          {track && source && (
            <button className="island-player-source" type="button" onClick={onOpenSource}>
              {track.playing ? "Playing in" : "Paused in"} {source}
            </button>
          )}
        </div>
      </div>}

      {track && (
        <div className="island-player-panel" role="group" aria-label="Playback controls">
          <div className="island-timeline">
            <input
              type="range"
              aria-label="Playback position"
              min={0}
              max={duration || 1}
              step="any"
              value={position}
              disabled={!track.canSeek || playbackPending}
              style={{ "--island-progress": `calc(${progress * 100}% + ${(0.5 - progress) * 10}px)` } as CSSProperties}
              onInput={(event) => {
                const value = event.currentTarget.valueAsNumber;
                pendingSeek.current = value;
                setSeekDraft(value);
              }}
              onPointerDown={(event) => {
                if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={finishSeek}
              onPointerCancel={clearSeek}
              onKeyUp={(event) => {
                if (/^(Arrow|Home|End|Page)/.test(event.key)) finishSeek();
              }}
              onBlur={finishSeek}
            />
            <div className="island-timestamps" aria-hidden="true">
              <span>{timeLabel(position)}</span>
              <span>{duration > 0 ? timeLabel(duration) : "–:––"}</span>
            </div>
          </div>

          <div className="island-player-controls">
            <div className="island-volume">
              <button className="island-playback island-volume-button" type="button" aria-label={volume > 0 ? "Mute" : "Unmute"} title={track.canSetVolume ? (volume > 0 ? "Mute" : "Unmute") : "Volume unavailable"} disabled={!track.canSetVolume || playbackPending} onClick={() => onControl({ type: "volume", level: volume > 0 ? 0 : lastVolume.current })}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6h3l4-3v10l-4-3H2z" />{volume > 0 ? <path d="M11 5c2 1.5 2 4.5 0 6m2-8c3 2.5 3 7.5 0 10" /> : <path d="m11 6 3 4m0-4-3 4" />}</svg>
              </button>
              <input type="range" aria-label="Volume level" aria-valuetext={Math.round(volume * 100) + "%"} title={track.canSetVolume ? Math.round(volume * 100) + "%" : "Volume unavailable"} min={0} max={1} step={0.01} value={volume} disabled={!track.canSetVolume || playbackPending}
                style={{ "--island-progress": `calc(${volume * 100}% + ${(0.5 - volume) * 8}px)` } as CSSProperties}
                onInput={event => { pendingVolume.current = event.currentTarget.valueAsNumber; setVolumeDraft(pendingVolume.current); }}
                onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerUp={finishVolume}
                onPointerCancel={clearVolume}
                onKeyUp={event => { if (/^(Arrow|Home|End|Page)/.test(event.key)) finishVolume(); }}
                onBlur={finishVolume} />
            </div>
            <div className="island-transport">
              <button className="island-playback" type="button" aria-label="Previous track" disabled={!track.canPrevious || playbackPending} onClick={() => onControl({ type: "previous" })}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor"><path d={icons.previous} /></svg>
              </button>
              <button className="island-playback island-playback-primary" type="button" aria-label={track.playing ? "Pause" : "Play"} disabled={!track.canToggle || playbackPending} onClick={() => onControl({ type: "toggle" })}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor"><path d={track.playing ? icons.pause : icons.play} /></svg>
              </button>
              <button className="island-playback" type="button" aria-label="Next track" disabled={!track.canNext || playbackPending} onClick={() => onControl({ type: "next" })}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor"><path d={icons.next} /></svg>
              </button>
            </div>
            {video && <button className="island-playback island-player-video-fill" type="button" aria-label={videoFill ? "Exit video view" : "Fill island with video"} title={videoFill ? "Exit video view (Esc)" : "Fill island with video"} onClick={onVideoFill}>
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={videoFill ? "M2 6h4V2m8 4h-4V2M2 10h4v4m8-4h-4v4" : "M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"} /></svg>
            </button>}
          </div>
        </div>
      )}
    </div>
  );
}
