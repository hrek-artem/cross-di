(() => {
  const channel = "cross-di-media-v2";
  if (window.dispatchEvent) window.dispatchEvent(new Event("cross-di-player-replace"));
  let disposed = false;
  let heartbeat;
  let restoreMediaSession = () => {};
  let positionState = null;
  const observed = new Set();
  const watched = new Map();
  const mediaEvents = ["play", "pause", "ended", "loadedmetadata", "seeked", "ratechange", "emptied"];
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalAudio = window.Audio;
  const observedAudio = typeof originalAudio === "function" ? new Proxy(originalAudio, {
    construct(target, args, newTarget) {
      const element = Reflect.construct(target, args, newTarget);
      if (!disposed) { try { remember(element); } catch { /* Preserve the Audio constructor even if observation fails. */ } }
      return element;
    },
  }) : null;
  if (observedAudio) window.Audio = observedAudio;
  function remember(element) {
    observed.add(element);
    if (watched.has(element)) return;
    const changed = event => { if (disposed) return; observed.add(element); if (event.type === "play") active = element; schedule(); };
    for (const event of mediaEvents) element.addEventListener?.(event, changed);
    watched.set(element, changed);
    if (watched.size > 32) {
      const oldest = watched.keys().next().value;
      for (const event of mediaEvents) oldest.removeEventListener?.(event, watched.get(oldest));
      watched.delete(oldest);
      observed.delete(oldest);
    }
  }
  function observePlay(...args) {
    if (!disposed) { try { remember(this); active = this; schedule(); } catch { /* Keep the page's play() behavior intact. */ } }
    return Reflect.apply(originalPlay, this, args);
  }
  HTMLMediaElement.prototype.play = observePlay;
  window.addEventListener("cross-di-player-replace", () => {
    disposed = true;
    clearInterval(heartbeat);
    videoSource?.stop();
    restoreMediaSession();
    if (HTMLMediaElement.prototype.play === observePlay) HTMLMediaElement.prototype.play = originalPlay;
    if (observedAudio && window.Audio === observedAudio) window.Audio = originalAudio;
    for (const [element, callback] of watched) for (const event of mediaEvents) element.removeEventListener?.(event, callback);
    watched.clear(); observed.clear();
  });
  const handlers = new Map();
  const mediaSession = navigator.mediaSession;
  if (mediaSession) {
    const original = mediaSession.setActionHandler;
    const originalPosition = mediaSession.setPositionState;
    function observeAction(action, handler) {
      const result = Reflect.apply(original, this, [action, handler]);
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
      return result;
    }
    function observePosition(state) {
      const result = Reflect.apply(originalPosition, this, [state]);
      positionState = state && Number.isFinite(state.duration) ? {
        duration: state.duration, position: state.position ?? 0,
        playbackRate: state.playbackRate ?? 1, observedAt: Date.now(),
      } : null;
      schedule();
      return result;
    }
    mediaSession.setActionHandler = observeAction;
    if (typeof originalPosition === "function") mediaSession.setPositionState = observePosition;
    restoreMediaSession = () => {
      if (mediaSession.setActionHandler === observeAction) mediaSession.setActionHandler = original;
      if (mediaSession.setPositionState === observePosition) mediaSession.setPositionState = originalPosition;
    };
  }
  let active = null;
  let coverUrl = "";
  let cover = null;
  let coverLoading = false;
  let coverAttempts = 0;
  let emptyPublished = false;
  let scheduled = false;
  let lastTrack = null;
  const sitePlayer = (typeof createIslandSoundCloudAdapter === "function" ? createIslandSoundCloudAdapter() : null) ?? (typeof createIslandSpotifyAdapter === "function" ? createIslandSpotifyAdapter({ actions: handlers, position: () => positionState }) : null);
  const videoSource = typeof createIslandVideoSource === "function" ? createIslandVideoSource(channel, player) : null;

  function player() {
    const available = el => el.readyState >= 1 && !el.ended && (el.isConnected || el.tagName === "AUDIO") && (!el.paused || el.currentTime > 0);
    if (active && available(active) && !active.paused) return active;
    const media = [...new Set([...document.querySelectorAll("video, audio"), ...observed])].filter(available);
    return media.find(el => !el.paused) ?? media.find(el => el === active) ?? media[0] ?? sitePlayer?.player() ?? null;
  }

  function siteMetadata() {
    return sitePlayer?.metadata() ?? null;
  }

  function navigationButton(direction) {
    return sitePlayer?.button(direction) ?? document.querySelector(direction === "next" ? ".ytp-next-button:not([aria-disabled='true'])" : ".ytp-prev-button:not([aria-disabled='true'])");
  }

  async function loadCover(url) {
    if (url !== coverUrl) { coverUrl = url; cover = null; coverAttempts = 0; }
    if (cover || coverLoading || coverAttempts >= 3) return;
    if (!/^https?:\/\//.test(url)) return;
    coverLoading = true;
    coverAttempts += 1;
    try {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 192;
      const ctx = canvas.getContext("2d");
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 192, 192);
      const data = canvas.toDataURL("image/jpeg", 0.75);
      if (coverUrl === url && data.length <= 65536) cover = data;
    } catch { /* Sites without CORS-enabled artwork still share playback. */ }
    finally { coverLoading = false; }
  }

  function snapshot() {
    const el = player();
    if (!el) return null;
    active = el;
    const metadata = mediaSession?.metadata;
    const site = siteMetadata();
    const title = (site?.title || metadata?.title || document.querySelector("h1")?.textContent || document.title).trim().slice(0, 512);
    if (!title) return null;
    const artist = (site?.artist || metadata?.artist || "").slice(0, 256);
    const artwork = site?.artwork || metadata?.artwork?.at(-1)?.src || el.poster || "";
    if (artwork) void loadCover(new URL(artwork, location.href).href);
    else { coverUrl = ""; cover = null; }
    const adapterPlayer = sitePlayer?.player();
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : (adapterPlayer?.duration ?? 0);
    return {
      title, artist, playing: !el.paused && !el.ended,
      position: Math.max(0, Number.isFinite(el.currentTime) ? el.currentTime : 0),
      duration, rate: el.paused ? 0 : Math.min(16, Math.max(0, el.playbackRate)),
      canToggle: el.canToggle !== false, canSeek: duration > 0 && (el.seekable.length > 0 || handlers.has("seekto") || adapterPlayer?.seekable.length > 0),
      volume: el.muted ? 0 : (Number.isFinite(el.volume) ? el.volume : 1),
      canSetVolume: el instanceof HTMLMediaElement || el.canSetVolume === true,
      canPrevious: handlers.has("previoustrack") || Boolean(navigationButton("previous")),
      canNext: handlers.has("nexttrack") || Boolean(navigationButton("next")),
      artwork: cover,
      hasVideo: el.tagName === "VIDEO" && el.videoWidth > 0,
    };
  }

  function publish() {
    if (disposed) return;
    try {
      lastTrack = snapshot();
      if (!lastTrack && emptyPublished) return;
      emptyPublished = !lastTrack;
      window.postMessage({ channel, kind: "snapshot", track: lastTrack }, location.origin);
      videoSource?.update();
    } catch { /* A page can replace its player while navigating. Retry on the next tick. */ }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; publish(); }, 80);
  }
  for (const event of mediaEvents) {
    document.addEventListener(event, event => {
      if (event.target instanceof HTMLMediaElement) { remember(event.target); if (event.type === "play") active = event.target; }
      schedule();
    }, true);
  }

  window.addEventListener("message", async event => {
    if (disposed || event.source !== window || event.data?.channel !== channel || event.data.kind !== "command") return;
    const command = event.data.command;
    let success = false;
    try {
      const el = player();
      const track = snapshot();
      if (!el || !track || track.title !== command.title || track.artist !== command.artist) throw new Error("Track changed");
      const action = command.action;
      if (action.type === "toggle") {
        if (!track.canToggle) throw new Error("Toggle unavailable");
        if (el.paused) await el.play(); else await el.pause();
      } else if (action.type === "volume" && track.canSetVolume && Number.isFinite(action.level)) {
        const level = Math.min(1, Math.max(0, action.level));
        if (typeof el.setVolume === "function") await el.setVolume(level);
        else el.volume = level;
        if (el instanceof HTMLMediaElement) el.muted = false;
      } else if (action.type === "seek" && track.canSeek && Number.isFinite(action.seconds)) {
        const position = Math.min(track.duration, Math.max(0, action.seconds));
        if (handlers.has("seekto")) await handlers.get("seekto")({ action: "seekto", seekTime: position, fastSeek: false });
        else if (typeof el.seek === "function") await el.seek(position);
        else if (el.seekable.length > 0) el.currentTime = position;
        else {
          const adapter = sitePlayer?.player();
          if (!adapter?.seekable.length || typeof adapter.seek !== "function") throw new Error("Seeking unavailable");
          await adapter.seek(position);
        }
      } else if (action.type === "next" || action.type === "previous") {
        const key = action.type === "next" ? "nexttrack" : "previoustrack";
        if (handlers.has(key)) await handlers.get(key)({ action: key });
        else {
          const button = navigationButton(action.type);
          if (!button || button.getAttribute("aria-disabled") === "true") throw new Error("Unavailable");
          button.click();
        }
      } else throw new Error("Unsupported action");
      success = true;
    } catch { /* Report a rejected action rather than leaving an optimistic state. */ }
    window.postMessage({ channel, kind: "ack", id: command.id, success }, location.origin);
    publish();
  });
  window.addEventListener("pagehide", () => window.postMessage({ channel, kind: "snapshot", track: null }, location.origin));
  heartbeat = setInterval(publish, 700);
  publish();
})();
