function createIslandSoundCloudAdapter() {
  if (!/(^|\.)soundcloud\.com$/.test(location.hostname ?? "")) return null;
  const footer = () => document.querySelector('[aria-label="miniplayer"], .playControls');
  const query = selector => footer()?.querySelector(selector) ?? document.querySelector(selector);
  const titleLink = () => query('.playbackSoundBadge__titleLink, a[aria-label^="Current track:"], a[data-testid="current-track-title"]');
  const text = element => (element?.getAttribute("title") || element?.textContent || "").trim();
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  function seconds(selector) {
    const value = query(selector)?.textContent?.match(/\d+:\d+(?::\d+)?/g)?.at(-1);
    return value ? value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) : 0;
  }
  function progress() { return query('[role="progressbar"], progress'); }
  function seekTarget() {
    const element = query('.playbackTimeline__progressWrapper');
    return element && element.getAttribute("aria-disabled") !== "true" && element.getBoundingClientRect().width > 0 ? element : null;
  }
  const volumeControl = () => query('.volume');
  function volumeLevel() {
    const control = volumeControl();
    if (!control) return null;
    if (control.classList?.contains("muted") || control.classList?.contains("m-muted")) return 0;
    const level = query('.volume__sliderProgress');
    const height = level?.style?.height;
    if (height?.endsWith("%") && Number.isFinite(parseFloat(height))) return Math.max(0, Math.min(1, parseFloat(height) / 100));
    const slider = query('.volume__sliderWrapper[aria-valuenow], .volume [role="slider"][aria-valuenow]');
    const current = slider?.getAttribute("aria-valuenow");
    if (current != null) {
      const min = number(slider.getAttribute("aria-valuemin"));
      const max = Number(slider.getAttribute("aria-valuemax") ?? 1);
      if (max > min && Number.isFinite(Number(current))) return Math.max(0, Math.min(1, (Number(current) - min) / (max - min)));
    }
    const background = query('.volume__sliderBackground');
    const full = background?.getBoundingClientRect().height;
    if (full > 0 && level) return Math.max(0, Math.min(1, level.getBoundingClientRect().height / full));
    return null;
  }
  function playing() {
    return Boolean(query('button[aria-label="Pause current"], button[title="Pause current"], .playControl.playing'));
  }
  function toggle() {
    return query('button[aria-label="Pause current"], button[title="Pause current"], button[aria-label="Play current"], button[title="Play current"], .playControl');
  }
  function button(direction) {
    const previous = direction === "previous";
    const label = previous ? "Skip to previous" : "Skip to next";
    const button = query(`button[aria-label="${label}"], button[title="${label}"], .skipControl__${previous ? "previous" : "next"}`);
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
  }
  const player = {
    tagName: "AUDIO", isConnected: true, readyState: 4, ended: false, playbackRate: 1,
    get seekable() { return { length: this.duration > 0 && seekTarget() ? 1 : 0 }; },
    get paused() { return !playing(); },
    get currentTime() { const el = progress(); return seconds('.playbackTimeline__timePassed') || number(el?.getAttribute("aria-valuenow") ?? el?.value); },
    get duration() { const el = progress(); return seconds('.playbackTimeline__duration') || number(el?.getAttribute("aria-valuemax") ?? el?.max); },
    get volume() { return volumeLevel() ?? 1; },
    get canSetVolume() { return Boolean(volumeControl()); },
    async setVolume(value) {
      const control = volumeControl();
      if (!control || !Number.isFinite(value)) throw new Error("Volume unavailable");
      const target = Math.max(0, Math.min(1, value));
      // SoundCloud lays out its vertical slider only while this control is hovered.
      const bounds = control.getBoundingClientRect();
      const hover = { bubbles: true, cancelable: true, view: window, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
      control.dispatchEvent(new MouseEvent("mouseover", hover));
      control.dispatchEvent(new MouseEvent("mousemove", hover));
      try {
        let slider = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const element = query('.volume__sliderBackground');
          if (control.classList.contains("expanded") && element && element.getBoundingClientRect().height > 0) { slider = element; break; }
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        if (!slider) throw new Error("Volume slider unavailable");
        const rect = slider.getBoundingClientRect();
        const event = { bubbles: true, cancelable: true, view: window, button: 0,
          // The site's volume handler subtracts a 4px inset before normalizing.
          clientX: rect.left + rect.width / 2, clientY: rect.bottom + 4 - target * rect.height };
        slider.dispatchEvent(new MouseEvent("mousedown", { ...event, buttons: 1 }));
        slider.dispatchEvent(new MouseEvent("mouseup", { ...event, buttons: 0 }));
        for (let attempt = 0; attempt < 8; attempt++) {
          const actual = volumeLevel();
          if (actual !== null && Math.abs(actual - target) <= .03) return;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error("SoundCloud did not accept the volume");
      } finally {
        control.dispatchEvent(new MouseEvent("mouseout", { ...hover, relatedTarget: document.body }));
      }
    },
    async seek(value) {
      const element = seekTarget(), duration = this.duration;
      if (!element || !Number.isFinite(value) || duration <= 0) throw new Error("Seeking unavailable");
      const target = Math.max(0, Math.min(duration, value));
      const bounds = element.getBoundingClientRect();
      const event = { bubbles: true, cancelable: true, view: window, button: 0,
        clientX: bounds.left + bounds.width * target / duration, clientY: bounds.top + bounds.height / 2 };
      element.dispatchEvent(new MouseEvent("mousedown", { ...event, buttons: 1 }));
      element.dispatchEvent(new MouseEvent("mouseup", { ...event, buttons: 0 }));
      // Confirm the site's timeline changed before acknowledging the command.
      for (let attempt = 0; attempt < 8; attempt++) {
        if (Math.abs(this.currentTime - target) <= 1.5) return;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      throw new Error("SoundCloud did not accept the seek");
    },
    async play() { if (!playing()) toggle()?.click(); },
    pause() { if (playing()) toggle()?.click(); },
  };
  return {
    player() { return text(titleLink()) && toggle() ? player : null; },
    button,
    metadata() {
      const avatar = query('.playbackSoundBadge__avatar .image__full, .playbackSoundBadge__avatar img');
      const background = avatar ? getComputedStyle(avatar).backgroundImage : "";
      const artwork = avatar?.currentSrc || avatar?.src || (background.startsWith("url(") ? background.slice(4, -1).trim().replace(/^["']|["']$/g, "") : "");
      return { title: text(titleLink()), artist: text(query('.playbackSoundBadge__lightLink')), artwork };
    },
  };
}
