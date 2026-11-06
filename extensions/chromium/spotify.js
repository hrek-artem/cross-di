function createIslandSpotifyAdapter(options = {}) {
  if (location.hostname !== "open.spotify.com") return null;
  const session = typeof navigator !== "undefined" ? navigator.mediaSession : null;
  const actions = options.actions ?? new Map();
  const query = selector => document.querySelector(selector);
  const text = el => (el?.textContent || el?.getAttribute("title") || "").trim();
  const title = () => query('[data-testid="nowplaying-track-link"], [data-testid="context-item-link"], [data-testid="context-item-info-title"] a, .now-playing a[href*="/track/"]');
  const toggle = () => query('[data-testid="control-button-playpause"], [data-testid="play-pause-button"], footer button[aria-label="Pause"], footer button[aria-label="Play"]');
  const playing = () => {
    if (session?.playbackState === "playing") return true;
    if (session?.playbackState === "paused") return false;
    const button = toggle();
    const label = button?.getAttribute("aria-label") || "";
    return Boolean(button?.querySelector('[data-testid="pause-icon"]')) || /pause|приостановить|пауза|anhalten/i.test(label);
  };
  const seconds = selector => {
    const value = query(selector)?.textContent?.match(/\d+:\d+(?::\d+)?/)?.[0];
    return value ? value.split(":").reduce((total, part) => total * 60 + Number(part), 0) : 0;
  };
  const volume = () => query('[data-testid="volume-bar"] input[type="range"], input[aria-label="Volume"], input[aria-label="Громкость"]');
  const progressInput = () => query('.playback-bar input[type="range"], [data-testid="playback-progressbar"] input[type="range"], input[aria-label="Change progress"]');
  function progressBar() {
    const element = query('.playback-bar [data-testid="progress-bar"], [data-testid="playback-progressbar"], .playback-bar [role="slider"]');
    return element && element.getAttribute("aria-disabled") !== "true" && element.getBoundingClientRect().width > 0 ? element : null;
  }
  function inputBounds(input) {
    return { min: Number(input.min) || 0, max: Number(input.max) };
  }
  function canSeekInput(input) {
    if (!input || input.disabled || input.getAttribute("aria-disabled") === "true") return false;
    const { min, max } = inputBounds(input);
    return Number.isFinite(max) && max > min;
  }
  function setInput(input, value) {
    if (!input) throw new Error("Control unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const player = {
    tagName: "AUDIO", isConnected: true, readyState: 4, ended: false, playbackRate: 1,
    get seekable() {
      const input = progressInput();
      return { length: this.duration > 0 && (actions.has("seekto") || (input ? canSeekInput(input) : progressBar())) ? 1 : 0 };
    },
    get paused() { return !playing(); },
    get currentTime() {
      const input = progressInput();
      if (canSeekInput(input) && this.duration > 0) {
        const { min, max } = inputBounds(input);
        return Math.max(0, Math.min(this.duration, (Number(input.value) - min) / (max - min) * this.duration));
      }
      const state = options.position?.();
      if (!state) return seconds('[data-testid="playback-position"]');
      const elapsed = playing() ? Math.max(0, Date.now() - state.observedAt) / 1000 * state.playbackRate : 0;
      return Math.min(state.duration, state.position + elapsed);
    },
    get duration() { return options.position?.()?.duration || seconds('[data-testid="playback-duration"]'); },
    async seek(value) {
      if (!Number.isFinite(value) || this.duration <= 0) throw new Error("Seeking unavailable");
      const target = Math.max(0, Math.min(this.duration, value));
      if (actions.has("seekto")) {
        await actions.get("seekto")({ action: "seekto", seekTime: target, fastSeek: false });
        return;
      }
      const input = progressInput();
      if (input) {
        if (!canSeekInput(input)) throw new Error("Seeking unavailable");
        const { min, max } = inputBounds(input);
        setInput(input, min + target / this.duration * (max - min));
      } else {
        const bar = progressBar();
        if (!bar) throw new Error("Seeking unavailable");
        const bounds = bar.getBoundingClientRect();
        const event = { bubbles: true, cancelable: true, view: window, button: 0,
          clientX: bounds.left + bounds.width * target / this.duration, clientY: bounds.top + bounds.height / 2 };
        if (typeof PointerEvent === "function") bar.dispatchEvent(new PointerEvent("pointerdown", { ...event, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
        bar.dispatchEvent(new MouseEvent("mousedown", { ...event, buttons: 1 }));
        if (typeof PointerEvent === "function") bar.dispatchEvent(new PointerEvent("pointerup", { ...event, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
        bar.dispatchEvent(new MouseEvent("mouseup", { ...event, buttons: 0 }));
        bar.dispatchEvent(new MouseEvent("click", { ...event, buttons: 0 }));
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        // A range's value alone can change even if the site's handler ignored it.
        const displayed = query('[data-testid="playback-position"]');
        const actual = displayed ? seconds('[data-testid="playback-position"]') : this.currentTime;
        if (Math.abs(actual - target) <= 1.5) return;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      throw new Error("Spotify did not accept the seek");
    },
    get canToggle() { return Boolean(toggle() || actions.has(playing() ? "pause" : "play")); },
    get volume() { const el = volume(); return el ? Number(el.value) / (Number(el.max) || 1) : 1; },
    set volume(value) { const el = volume(); setInput(el, value * (Number(el?.max) || 1)); },
    get canSetVolume() { return Boolean(volume()); },
    async play() {
      if (playing()) return;
      if (actions.has("play")) await actions.get("play")({ action: "play" });
      else { const button = toggle(); if (!button) throw new Error("Play unavailable"); button.click(); }
    },
    async pause() {
      if (!playing()) return;
      if (actions.has("pause")) await actions.get("pause")({ action: "pause" });
      else { const button = toggle(); if (!button) throw new Error("Pause unavailable"); button.click(); }
    },
  };
  return {
    player() { return (session?.metadata?.title || text(title())) && (toggle() || session?.metadata?.title) ? player : null; },
    button(direction) { const el = query(direction === "previous" ? '[data-testid="control-button-skip-back"]' : '[data-testid="control-button-skip-forward"]'); return el && !el.disabled && el.getAttribute("aria-disabled") !== "true" ? el : null; },
    metadata() {
      const artists = query('[data-testid="context-item-info-artist"], [data-testid="context-item-info-subtitles"]');
      const image = query('[data-testid="now-playing-widget"] img, .now-playing img, footer [data-testid="cover-art-image"]');
      const metadata = session?.metadata;
      return { title: metadata?.title || text(title()), artist: metadata?.artist || text(artists), artwork: metadata?.artwork?.at(-1)?.src || image?.currentSrc || image?.src || "" };
    },
  };
}
