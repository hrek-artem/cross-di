export type Track = {
  title: string;
  artist: string;
  playing: boolean;
};

export type NowPlaying = Track & {
  sourceApp: string;
  sourceName: string;
  artworkRevision: number;
  canToggle: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canSeek: boolean;
  canSetVolume: boolean;
  volume: number;
  position: number;
  duration: number;
  rate: number;
  observedAt: number;
};

export type PlaybackAction = { type: "toggle" | "previous" | "next" } | { type: "seek"; seconds: number } | { type: "volume"; level: number };

export function positionAt(track: NowPlaying, now: number) {
  const elapsed = Math.max(0, now - track.observedAt) / 1000;
  return Math.min(track.duration, track.position + elapsed * track.rate);
}

export function isSameTrack(left: NowPlaying, right: NowPlaying) {
  return left.sourceApp === right.sourceApp && left.title === right.title && left.artist === right.artist;
}
