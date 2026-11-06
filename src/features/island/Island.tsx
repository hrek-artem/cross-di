import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useAppIcons } from "./AppIcon";
import IslandCapsule from "./IslandCapsule";
import IslandPages, { type IslandPage } from "./IslandPages";
import IslandPlayer from "./IslandPlayer";
import { useSavedSettings } from "./preferences";
import { useArtwork } from "./useArtwork";
import { useBrowserVideo } from "./useBrowserVideo";
import { useIslandExpansion } from "./useIslandExpansion";
import { usePlayback } from "./usePlayback";
import { useSystemSample } from "./useSystemSample";

export default function Island() {
  const { settings, ready, error } = useSavedSettings();
  const appIcons = useAppIcons(settings.pinnedApps, settings.pinnedAppIcons);
  const showMusic = ready && settings.showMusic;
  const { track, playbackPending, controlPlayback } = usePlayback(showMusic);
  const activeTrack = showMusic ? track : null;
  const artwork = useArtwork(activeTrack);
  const source = activeTrack?.sourceName;
  const [videoFill, setVideoFill] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControls = useRef<number | undefined>(undefined);
  const pointerHeld = useRef(false);
  const pointerInside = useRef(false);
  const { expanded, capsule, expand, collapse, onPointerEnter, onPointerLeave } = useIslandExpansion(settings.openOnHover, pinned);
  const [selectedPage, setSelectedPage] = useState<IslandPage | null>(null);
  const page = selectedPage ?? (activeTrack ? "Music" : "System");
  const video = useBrowserVideo(activeTrack?.sourceApp, expanded && page === "Music");
  useEffect(() => { if (!video) setVideoFill(false); }, [video]);
  function revealControls() {
    window.clearTimeout(hideControls.current);
    setControlsVisible(true);
    if (videoFill && expanded && !pointerInside.current && !pointerHeld.current) {
      hideControls.current = window.setTimeout(() => {
        if (!pointerInside.current && !pointerHeld.current) setControlsVisible(false);
      }, 300);
    }
  }
  useEffect(() => {
    revealControls();
    return () => window.clearTimeout(hideControls.current);
  }, [videoFill, expanded]);
  const sample = useSystemSample(ready && (expanded ? page === "System" : !activeTrack && settings.idleDisplay === "system"));

  function collapseIsland() { setPinned(false); collapse(); }

  async function openSource() {
    if (!activeTrack) return;
    try {
      await invoke<boolean>("open_media_source", { sourceApp: activeTrack.sourceApp });
    } catch (error) {
      console.error(error);
    }
  }

  if (!ready && !error) return null;

  return (
    <main
      className="island"
      data-alignment={settings.alignment}
      data-video-fill={videoFill}
      data-controls-visible={controlsVisible}
      onPointerMove={revealControls}
      onPointerDown={() => { pointerHeld.current = true; revealControls(); }}
      onPointerUp={() => { pointerHeld.current = false; revealControls(); }}
      onPointerCancel={() => { pointerHeld.current = false; revealControls(); }}
      onFocus={revealControls}
      aria-label="Dynamic Island"
      onKeyDown={(event) => {
        revealControls();
        if (event.key === "Escape") { if (videoFill) setVideoFill(false); else if (expanded) collapseIsland(); }
      }}
    >
      <IslandCapsule
        settings={settings}
        track={activeTrack}
        sample={sample}
        cover={artwork?.cover}
        tint={artwork?.tint}
        source={source}
        expanded={expanded}
        containerRef={capsule}
        onExpand={expand}
        onPointerEnter={(event) => {
          pointerInside.current = event.pointerType !== "touch";
          revealControls();
          onPointerEnter(event);
        }}
        onPointerLeave={(event) => {
          pointerInside.current = false;
          revealControls();
          onPointerLeave(event);
        }}
        onOpenSource={activeTrack ? openSource : undefined}
      >
        <IslandPages
          visible={expanded}
          page={page}
          onSelect={setSelectedPage}
          sample={sample}
          pinnedApps={settings.pinnedApps}
          appIcons={appIcons}
          onCollapse={collapseIsland}
          pinned={pinned}
          onPin={() => setPinned(value => !value)}
          music={(
            <IslandPlayer
              key={activeTrack ? JSON.stringify([activeTrack.sourceApp, activeTrack.title, activeTrack.artist]) : "empty"}
              visible={expanded}
              video={video}
              videoFill={videoFill}
              onVideoFill={() => setVideoFill(value => !value)}
              onActivity={revealControls}
              track={activeTrack}
              cover={artwork?.cover}
              source={source}
              playbackPending={playbackPending}
              onControl={controlPlayback}
              onCollapse={collapseIsland}
              onOpenSource={activeTrack ? openSource : undefined}
            />
          )}
        />
      </IslandCapsule>
    </main>
  );
}
