import type { PointerEventHandler, ReactNode, Ref } from "react";
import IslandCover from "./IslandCover";
import IslandIdle from "./IslandIdle";
import type { Track } from "./media";
import type { IslandSettings } from "./preferences";
import type { SystemSample } from "./useSystemSample";
import "./Island.css";

type Props = {
  settings: IslandSettings;
  track?: Track | null;
  sample?: SystemSample | null;
  cover?: string | null;
  tint?: string | null;
  source?: string;
  expanded?: boolean;
  idlePreview?: boolean;
  containerRef?: Ref<HTMLDivElement>;
  onExpand?: () => void;
  onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  onOpenSource?: () => void;
  children?: ReactNode;
};

export default function IslandCapsule({ settings, track, sample = null, cover, tint, source, expanded = false, idlePreview = false, containerRef, onExpand, onPointerEnter, onPointerLeave, onOpenSource, children }: Props) {
  const media = settings.showMusic ? track : null;
  const background = tint
    ? `color-mix(in srgb, ${tint} 26%, ${settings.backgroundColor})`
    : settings.backgroundColor;
  const idle = !media && (onExpand || idlePreview) ? (
    <IslandIdle settings={settings} sample={sample} live={Boolean(onExpand)} visible={!expanded} />
  ) : null;
  const trackLabel = media && (
    <>
      <span className="island-track" title={[media.title, media.artist].filter(Boolean).join(" · ")}>
        <span className="island-track-title">{media.title}</span>
        {media.artist && <span className="island-track-artist">{media.artist}</span>}
      </span>
      <span className="island-wave" data-playing={media.playing} aria-hidden="true">
        <span /><span /><span /><span /><span />
      </span>
    </>
  );

  return (
    <div
      ref={containerRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`island-capsule${settings.glass ? " island-capsule--glass" : ""}`}
      data-expanded={expanded}
      style={{
        backgroundColor: settings.glass ? `color-mix(in srgb, ${background} 72%, transparent)` : background,
        color: settings.textColor,
      }}
    >
      <div className="island-compact" inert={expanded}>
        {media && <IslandCover cover={cover} source={source} onOpen={onOpenSource} />}
        {onExpand ? (
          <button className="island-open" type="button" aria-label="Expand island" aria-describedby={media ? undefined : "island-idle-status"} aria-expanded={false} onClick={onExpand}>
            {trackLabel || <span className="island-idle-status" id="island-idle-status">{idle}</span>}
          </button>
        ) : trackLabel || <span className="island-idle-status">{idle}</span>}
      </div>
      {children && <div className="island-expanded-content" inert={!expanded}>{children}</div>}
    </div>
  );
}
