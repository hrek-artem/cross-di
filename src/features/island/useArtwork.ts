import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "./media";

type Artwork = { cover: string; tint: string | null };

async function prepareArtwork(cover: string): Promise<Artwork> {
  const image = new Image();
  image.src = cover;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return { cover, tint: null };

  const side = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
  const { data } = context.getImageData(0, 0, 96, 96);
  let red = 0;
  let green = 0;
  let blue = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 20) {
    const [r, g, b, alpha] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const lightest = Math.max(r, g, b);
    const darkest = Math.min(r, g, b);
    if (alpha < 128 || lightest < 12 || darkest > 245) continue;

    const weight = 1 + (lightest - darkest) / 32;
    red += r * weight;
    green += g * weight;
    blue += b * weight;
    total += weight;
  }
  const tint = total === 0 ? null : `rgb(${Math.round(red / total)} ${Math.round(green / total)} ${Math.round(blue / total)})`;
  return { cover: canvas.toDataURL("image/webp", 0.88), tint };
}

export function useArtwork(track: NowPlaying | null) {
  const { sourceApp, title, artist, artworkRevision } = track ?? {};
  const key = JSON.stringify([sourceApp, title, artist, artworkRevision]);
  const cache = useRef(new Map<string, Artwork>());
  const [artwork, setArtwork] = useState<(Artwork & { key: string }) | null>(null);

  useEffect(() => {
    if (sourceApp === undefined || title === undefined || artist === undefined || cache.current.has(key)) return;

    let active = true;
    let timer: number;
    async function load(attempt = 0) {
      const cover = await invoke<string | null>("get_media_artwork", { media: { sourceApp, title, artist } }).catch(() => null);
      if (!active) return;
      if (!cover) {
        if (attempt < 3) timer = window.setTimeout(() => void load(attempt + 1), 120 * (attempt + 1));
        return;
      }
      const prepared = await prepareArtwork(cover).catch(() => ({ cover, tint: null }));
      if (!active) return;
      const entries = cache.current;
      if (entries.size >= 12) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, prepared);
      setArtwork({ key, ...prepared });
    }
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, sourceApp, title, artist]);

  return artwork?.key === key ? artwork : cache.current.get(key) ?? null;
}
