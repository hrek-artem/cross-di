import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function environment() {
  let playing = true, hasTrack = true, now = 10000, next = 0, listener;
  const messages = [], handlers = new Map(), intervals = [];
  class Input {
    _value = "0.6"; max = "1"; events = [];
    get value() { return this._value; } set value(value) { this._value = value; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const volume = new Input();
  const toggle = { getAttribute: key => key === "aria-label" ? (playing ? "Pause" : "Play") : null,
    querySelector: () => null, click() { playing = !playing; } };
  const button = { disabled: false, getAttribute: () => null, click() { next++; } };
  const document = { querySelector(selector) {
    if (selector.includes("nowplaying-track-link")) return hasTrack ? { textContent: "Web song" } : null;
    if (selector.includes("control-button-playpause")) return toggle;
    if (selector.includes("context-item-info-artist")) return { textContent: "Web artist" };
    if (selector.includes("playback-position")) return { textContent: "1:23" };
    if (selector.includes("playback-duration")) return { textContent: "3:20" };
    if (selector.includes("volume-bar")) return volume;
    if (selector.includes("control-button-skip-")) return button;
    return null;
  } };
  const window = { addEventListener(name, handler) { handlers.set(name, handler); }, postMessage(value) { messages.push({ page: value }); } };
  const chrome = { runtime: { id: "test-extension", sendMessage(value) { messages.push(value); return Promise.resolve(); }, onMessage: { addListener(fn) { listener = fn; } } } };
  const context = vm.createContext({ window, chrome, document, HTMLInputElement: Input, Event,
    location: { hostname: "open.spotify.com", origin: "https://open.spotify.com" },
    Date: { now: () => now }, setInterval: fn => intervals.push(fn), clearInterval() {}, setTimeout, clearTimeout });
  for (const name of ["spotify.js", "dom-player.js", "relay.js"]) vm.runInContext(readFileSync(new URL("../chromium/" + name, import.meta.url), "utf8"), context);
  return { context, volume, messages,
    get playing() { return playing; }, get next() { return next; },
    tick() { intervals.forEach(fn => fn()); },
    advance(ms) { now += ms; }, close() { hasTrack = false; },
    fromPage(track) { handlers.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "snapshot", track } }); },
    control(action, title = "Web song") { return new Promise(resolve => listener({ type: "control", command: { id: 1, title, artist: "Web artist", action } }, {}, resolve)); },
    snapshot() { return messages.filter(m => m.type === "snapshot").at(-1)?.track; },
  };
}

test("Spotify DOM fallback publishes music when no page-world player is available", async () => {
  const env = environment(); env.tick();
  const track = env.snapshot();
  assert.equal(track.title, "Web song"); assert.equal(track.artist, "Web artist");
  assert.equal(track.position, 83); assert.equal(track.duration, 200);
  assert.equal(track.playing, true); assert.equal(track.volume, .6); assert.equal(track.canSetVolume, true);
  assert.equal(await env.control({ type: "toggle" }), true);
  assert.equal(env.playing, false); assert.equal(env.snapshot().playing, false);
  assert.equal(await env.control({ type: "next" }), true); assert.equal(env.next, 1);
  assert.equal(await env.control({ type: "toggle" }, "Stale song"), false);
  env.close(); env.tick(); assert.equal(env.snapshot(), null);
});

test("fallback volume changes the real website input and dispatches its control events", async () => {
  const env = environment(); env.tick();
  assert.equal(await env.control({ type: "volume", level: .25 }), true);
  assert.equal(env.volume.value, "0.25"); assert.deepEqual(env.volume.events, ["input", "change"]);
  assert.equal(env.snapshot().volume, .25);
  assert.equal(await env.control({ type: "volume", level: NaN }), false);
});

test("fresh main-world media wins, and its missing heartbeat reactivates DOM fallback", () => {
  const env = environment();
  env.fromPage({ title: "Main song", artist: "Artist", playing: true });
  env.tick(); assert.equal(env.snapshot().title, "Main song");
  env.advance(2100); env.tick(); assert.equal(env.snapshot().title, "Web song");
  env.fromPage(null); assert.equal(env.snapshot().title, "Web song");
});
