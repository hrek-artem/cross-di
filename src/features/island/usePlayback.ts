import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { isSameTrack, positionAt, type NowPlaying, type PlaybackAction } from "./media";

type PendingUpdate = {
  track: NowPlaying;
  kind: "toggle" | "seek" | "volume";
  expiresAt: number;
};

export function usePlayback(enabled: boolean) {
  const [track, setTrack] = useState<NowPlaying | null>(null);
  const [playbackPending, setPlaybackPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const optimistic = useRef<PendingUpdate | null>(null);
  const switching = useRef<{ track: NowPlaying; expiresAt: number } | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (!isTauri() || !enabled) return;
    let disposed = false;
    const listener = listen("browser-media-changed", () => setRefresh(value => value + 1));
    void listener.then(unlisten => { if (disposed) unlisten(); }).catch(console.error);
    return () => { disposed = true; void listener.then(unlisten => unlisten()).catch(console.error); };
  }, [enabled]);

  useEffect(() => {
    if (!isTauri() || !enabled) return;

    let disposed = false;
    let timer: number;
    let confirmingEmpty = false;

    async function poll() {
      const snapshot = await invoke<Omit<NowPlaying, "observedAt"> | null>("get_now_playing").catch(() => undefined);
      if (disposed) return;
      if (snapshot === undefined) {
        timer = window.setTimeout(poll, 1000);
        return;
      }

      const now = performance.now();
      const current = snapshot ? { ...snapshot, observedAt: now } : null;
      const previous = switching.current;
      if (previous && now < previous.expiresAt && (!current || isSameTrack(previous.track, current))) {
        if (current) setTrack(current);
        timer = window.setTimeout(poll, 100);
        return;
      }
      switching.current = null;
      const pending = optimistic.current;
      if (pending && (!current || isSameTrack(pending.track, current))) {
        const confirmed = current && (pending.kind === "toggle"
          ? current.playing === pending.track.playing
          : pending.kind === "volume" ? Math.abs(current.volume - pending.track.volume) < 0.02
          : Math.abs(current.position - positionAt(pending.track, now)) < 1.25);
        if (sending.current || (!confirmed && now < pending.expiresAt)) {
          timer = window.setTimeout(poll, 180);
          return;
        }
      }

      optimistic.current = null;
      if (!current && !confirmingEmpty) {
        confirmingEmpty = true;
        timer = window.setTimeout(poll, 250);
        return;
      }
      confirmingEmpty = !current;
      setTrack(current);
      timer = window.setTimeout(poll, 1500);
    }

    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [enabled, refresh]);

  async function controlPlayback(action: PlaybackAction) {
    if (!track || sending.current) return;

    const previous = track;
    const now = performance.now();
    let update: PendingUpdate | null = null;
    if (action.type === "toggle") {
      const playing = !track.playing;
      update = {
        kind: "toggle",
        track: { ...track, playing, rate: playing ? 1 : 0, position: positionAt(track, now), observedAt: now },
        expiresAt: 0,
      };
    } else if (action.type === "volume") {
      update = { kind: "volume", track: { ...track, volume: action.level, position: positionAt(track, now), observedAt: now }, expiresAt: 0 };
    } else if (action.type === "seek") {
      update = {
        kind: "seek",
        track: { ...track, position: Math.min(track.duration, Math.max(0, action.seconds)), observedAt: now },
        expiresAt: 0,
      };
    }

    sending.current = true;
    switching.current = null;
    setPlaybackPending(true);
    if (update) {
      optimistic.current = update;
      setTrack(update.track);
    }

    let accepted = false;
    try {
      const { sourceApp, title, artist } = track;
      accepted = await invoke<boolean>("control_playback", { media: { sourceApp, title, artist }, action });
    } catch (error) {
      console.error(error);
    } finally {
      if (accepted && (action.type === "previous" || action.type === "next")) {
        switching.current = { track: previous, expiresAt: performance.now() + 2000 };
      }
      if (update && optimistic.current === update) {
        if (accepted) {
          update.expiresAt = performance.now() + 2500;
        } else {
          optimistic.current = null;
          setTrack(previous);
        }
      }
      sending.current = false;
      setPlaybackPending(false);
      setRefresh((value) => value + 1);
    }
  }

  return { track, playbackPending, controlPlayback };
}
