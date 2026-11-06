import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function environment(site, mode, { ignored = false, custom = false, native = false, delayed = false } = {}) {
  let position = 40, level = .65, expanded = false, available = true, disabled = false;
  let opening = 0;
  const events = [], messages = [], listeners = new Map();
  const time = value => Math.floor(value / 60) + ":" + String(Math.floor(value % 60)).padStart(2, "0");
  class Input {
    min = "10"; max = "110"; disabled = false; _value = "30";
    get value() { return this._value; } set value(value) { this._value = value; }
    getAttribute() { return null; }
    dispatchEvent(event) {
      events.push(event);
      if (!ignored && event.type === "input") position = (Number(this.value) - 10) / 100 * 200;
    }
  }
  const input = new Input();
  const bar = {
    getAttribute: () => disabled ? "true" : null,
    getBoundingClientRect: () => ({ left: 100, top: 8, width: 300, height: 12 }),
    dispatchEvent(event) {
      events.push(event);
      if (!ignored && event.type === "click") position = (event.clientX - 100) / 300 * 200;
    },
  };
  const volume = {
    classList: { contains: name => name === "muted" ? level === 0 : name === "expanded" && expanded },
    getBoundingClientRect: () => ({ left: 40, top: 500, width: 20, height: 24 }),
    dispatchEvent(event) {
      events.push(event);
      if (event.type === "mouseover") { if (delayed) opening = 2; else expanded = true; }
      if (event.type === "mouseout") expanded = false;
    },
  };
  const background = {
    getBoundingClientRect: () => ({ left: 40, top: 300, bottom: 420, width: 20, height: (delayed || expanded) && available ? 120 : 0 }),
    dispatchEvent(event) {
      events.push(event);
      // SoundCloud's drag handler subtracts its 4px inset, then rounds to 2 decimals.
      if (!ignored && expanded && event.type === "mousedown") level = Math.round(Math.max(0, Math.min(1, 1 - (event.clientY - 300 - 4) / 120)) * 100) / 100;
    },
  };
  const label = value => ({ textContent: value, getAttribute: () => null });
  function query(selector) {
    if (selector.includes("titleLink") || selector.includes("nowplaying-track-link")) return label("Track");
    if (selector.includes("lightLink") || selector.includes("context-item-info-artist")) return label("Artist");
    if (selector.includes("Play current")) return { click() {} };
    if (selector.includes("control-button-playpause")) return { getAttribute: () => "Play", querySelector: () => null };
    if (selector.includes("playback-position") || selector.includes("timePassed")) return label(time(position));
    if (selector.includes("playback-duration") || selector.includes("__duration")) return label("3:20");
    if (selector === ".volume") return volume;
    if (selector.includes("volume__sliderProgress")) return { style: {}, getBoundingClientRect: () => ({ height: level * 120 }) };
    if (selector.includes("volume__sliderWrapper[aria-valuenow]")) return { getAttribute: key => ({ "aria-valuemin": "0", "aria-valuemax": "1", "aria-valuenow": String(level) })[key] ?? null };
    if (selector === ".volume__sliderBackground") return background;
    if (selector.includes(".playback-bar input")) return custom ? null : input;
    if (selector.includes(".playback-bar [data-testid")) return bar;
    return null;
  }
  const window = { postMessage: value => messages.push(value), addEventListener: (name, fn) => listeners.set(name, fn) };
  class Media {
    readyState = 4; isConnected = true; paused = true; ended = false; currentTime = 40;
    duration = 200; playbackRate = 1; seekable = { length: 0 }; play() {}
  }
  const media = new Media();
  const document = { body: {}, title: site,
    querySelector: selector => selector.includes("miniplayer") ? { querySelector: query } : query(selector),
    querySelectorAll: () => native ? [media] : [], addEventListener() {},
  };
  const context = vm.createContext({ window, document, navigator: { mediaSession: null },
    location: { hostname: site === "spotify" ? "open.spotify.com" : "soundcloud.com", origin: "https://example.com" },
    HTMLInputElement: Input, HTMLMediaElement: Media, Event,
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    PointerEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    setTimeout: fn => queueMicrotask(() => { if (opening > 0 && --opening === 0) expanded = true; fn(); }), setInterval() {}, URL });
  for (const file of [site + ".js", mode === "main" ? "player.js" : "dom-player.js"]) vm.runInContext(readFileSync(new URL("../chromium/" + file, import.meta.url), "utf8"), context);
  const fallback = mode === "fallback" ? vm.runInContext("createIslandDOMPlayer()", context) : null;
  return {
    events, get level() { return level; }, get position() { return position; }, get expanded() { return expanded; },
    unavailable() { available = false; }, disable() { input.disabled = true; disabled = true; },
    snapshot: () => fallback ? fallback.snapshot() : messages.filter(m => m.kind === "snapshot").at(-1)?.track,
    async command(action, title = "Track") {
      const command = { id: 1, title, artist: "Artist", action };
      if (fallback) return fallback.control(command);
      await listeners.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "command", command } });
      return messages.filter(m => m.kind === "ack").at(-1).success;
    },
  };
}

for (const mode of ["main", "fallback"]) {
  test(`SoundCloud ${mode} exposes collapsed volume and adjusts the site's vertical slider precisely`, async () => {
    const env = environment("soundcloud", mode);
    assert.equal(env.expanded, false);
    assert.equal(env.snapshot().canSetVolume, true);
    assert.equal(env.snapshot().volume, .65);
    assert.equal(await env.command({ type: "volume", level: .25 }), true);
    assert.equal(env.level, .25); assert.equal(env.expanded, false);
    assert.equal(env.events.find(e => e.type === "mousedown").clientY, 394);
    assert.equal(env.snapshot().playing, false);
    for (const level of [0, 1, .43]) {
      assert.equal(await env.command({ type: "volume", level }), true);
      assert.equal(env.level, level);
    }
    const delayed = environment("soundcloud", mode, { delayed: true });
    assert.equal(await delayed.command({ type: "volume", level: .35 }), true);
    assert.equal(delayed.level, .35); assert.equal(delayed.expanded, false);
  });

  test(`SoundCloud ${mode} rejects ignored volume and always closes its temporary slider`, async () => {
    const env = environment("soundcloud", mode, { ignored: true });
    assert.equal(await env.command({ type: "volume", level: .25 }), false);
    assert.equal(env.level, .65); assert.equal(env.expanded, false);
    assert.equal(await env.command({ type: "volume", level: NaN }), false);
    const missing = environment("soundcloud", mode); missing.unavailable();
    assert.equal(await missing.command({ type: "volume", level: .25 }), false);
    assert.equal(missing.expanded, false);
  });

  for (const custom of [false, true]) {
    test(`Spotify ${mode} seeks using ${custom ? "custom timeline" : "range input"} without seekto, preserving pause`, async () => {
      const env = environment("spotify", mode, { custom });
      assert.equal(env.snapshot().canSeek, true);
      assert.equal(await env.command({ type: "seek", seconds: 100 }), true);
      assert.equal(env.position, 100); assert.equal(env.snapshot().playing, false);
      for (const seconds of [0, 200]) {
        assert.equal(await env.command({ type: "seek", seconds }), true);
        assert.equal(env.position, seconds);
      }
      assert.equal(await env.command({ type: "seek", seconds: NaN }), false);
      assert.equal(await env.command({ type: "seek", seconds: 80 }, "Old track"), false);
      env.disable(); assert.equal(await env.command({ type: "seek", seconds: 80 }), false);
      const ignored = environment("spotify", mode, { ignored: true, custom });
      assert.equal(await ignored.command({ type: "seek", seconds: 100 }), false);
      assert.equal(ignored.position, 40);
    });
  }
}

test("Spotify's seekable website slider remains available when its audio element cannot seek", async () => {
  const env = environment("spotify", "main", { native: true });
  assert.equal(env.snapshot().canSeek, true);
  assert.equal(await env.command({ type: "seek", seconds: 70 }), true);
  assert.equal(env.position, 70);
});
