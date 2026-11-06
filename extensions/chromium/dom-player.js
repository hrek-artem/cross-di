function createIslandDOMPlayer() {
  const adapter = (typeof createIslandSoundCloudAdapter === "function" ? createIslandSoundCloudAdapter() : null)
    ?? (typeof createIslandSpotifyAdapter === "function" ? createIslandSpotifyAdapter() : null);
  if (!adapter) return null;
  let artworkUrl = "", artwork = null, loading = false, attempts = 0;
  async function loadArtwork(url) {
    if (url !== artworkUrl) { artworkUrl = url; artwork = null; attempts = 0; }
    if (!url || artwork || loading || attempts >= 3 || !/^https?:\/\//.test(url)) return;
    loading = true; attempts++;
    try {
      const image = new Image(); image.crossOrigin = "anonymous"; image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 192;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      canvas.getContext("2d").drawImage(image, (image.naturalWidth-side)/2, (image.naturalHeight-side)/2, side, side, 0, 0, 192, 192);
      const data = canvas.toDataURL("image/jpeg", .75);
      if (artworkUrl === url && data.length <= 65536) artwork = data;
    } catch { /* Artwork is optional; playback remains available. */ }
    finally { loading = false; }
  }
  function snapshot() {
    const el = adapter.player(); if (!el) return null;
    const meta = adapter.metadata();
    void loadArtwork(meta.artwork);
    return { title: meta.title.slice(0,512), artist: meta.artist.slice(0,256), playing: !el.paused,
      position: Math.max(0, el.currentTime || 0), duration: Math.max(0, el.duration || 0), rate: el.paused ? 0 : 1,
      canToggle: el.canToggle !== false, canSeek: el.duration > 0 && el.seekable.length > 0, canPrevious: Boolean(adapter.button("previous")), canNext: Boolean(adapter.button("next")),
      canSetVolume: el.canSetVolume === true, volume: Number.isFinite(el.volume) ? el.volume : 1, artwork, hasVideo: false };
  }
  async function control(command) {
    try {
      const el = adapter.player(), track = snapshot();
      if (!el || !track || track.title !== command.title || track.artist !== command.artist) return false;
      const action = command.action;
      if (action.type === "toggle" && track.canToggle) { if (el.paused) await el.play(); else await el.pause(); }
      else if (action.type === "seek" && track.canSeek && Number.isFinite(action.seconds)) {
        const position = Math.max(0, Math.min(el.duration, action.seconds));
        if (typeof el.seek === "function") await el.seek(position);
        else el.currentTime = position;
      }
      else if (action.type === "volume" && track.canSetVolume && Number.isFinite(action.level)) {
        const level = Math.max(0, Math.min(1, action.level));
        if (typeof el.setVolume === "function") await el.setVolume(level);
        else el.volume = level;
      }
      else if (action.type === "next" || action.type === "previous") { const button = adapter.button(action.type); if (!button) return false; button.click(); }
      else return false;
      return true;
    } catch { return false; }
  }
  return { snapshot, control };
}
