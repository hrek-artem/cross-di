import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function environment(mode, acceptsSeek = true) {
  let position = 36, width = 240;
  const events = [], messages = [], listeners = new Map();
  const time = value => Math.floor(value / 60) + ":" + String(Math.floor(value % 60)).padStart(2, "0");
  const progress = {
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 8, width, height: 12 }),
    dispatchEvent(event) {
      events.push(event);
      if (acceptsSeek && event.type === "mouseup") position = (event.clientX - 100) / width * 185;
      return true;
    },
  };
  const footer = { querySelector(selector) {
    if (selector.includes("titleLink")) return { textContent: "Track", getAttribute: () => null };
    if (selector.includes("lightLink")) return { textContent: "Artist", getAttribute: () => null };
    if (selector.includes("timePassed")) return { textContent: time(position) };
    if (selector.includes("duration")) return { textContent: "3:05" };
    if (selector.includes("progressWrapper")) return progress;
    if (selector.includes("Play current")) return { click() {} };
    return null;
  } };
  const window = { postMessage: value => messages.push(value), addEventListener: (name, fn) => listeners.set(name, fn) };
  const document = { querySelector: selector => selector.includes("miniplayer") ? footer : null,
    querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ window, document, navigator: { mediaSession: null },
    location: { hostname: "soundcloud.com", origin: "https://soundcloud.com" },
    HTMLMediaElement: class { play() {} }, MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    setInterval() {}, setTimeout: fn => queueMicrotask(fn), URL });
  for (const file of ["soundcloud.js", mode === "main" ? "player.js" : "dom-player.js"]) vm.runInContext(readFileSync(new URL("../chromium/" + file, import.meta.url), "utf8"), context);
  const fallback = mode === "main" ? null : vm.runInContext("createIslandDOMPlayer()", context);
  return {
    events, get position() { return position; }, hide() { width = 0; },
    snapshot: () => fallback ? fallback.snapshot() : messages.filter(m => m.kind === "snapshot").at(-1)?.track,
    async seek(seconds, title = "Track") {
      const command = { id: 1, title, artist: "Artist", action: { type: "seek", seconds } };
      if (fallback) return fallback.control(command);
      await listeners.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "command", command } });
      return messages.filter(m => m.kind === "ack").at(-1).success;
    },
  };
}

for (const mode of ["main", "fallback"]) {
  test(`SoundCloud ${mode} seeks via its timeline and keeps paused playback paused`, async () => {
    const env = environment(mode);
    assert.equal(env.snapshot().canSeek, true);
    assert.equal(env.snapshot().playing, false);
    assert.equal(await env.seek(92.5), true);
    assert.equal(env.position, 92.5);
    assert.deepEqual(env.events.map(e => e.type), ["mousedown", "mouseup"]);
    assert.equal(env.events[0].clientX, 220);
    assert.equal(env.events[0].clientY, 14);
    assert.equal(env.snapshot().playing, false);
    assert.equal(await env.seek(999), true); assert.equal(env.position, 185);
    assert.equal(await env.seek(0), true); assert.equal(env.position, 0);
  });

  test(`SoundCloud ${mode} rejects stale, invalid, unavailable and ignored seeks`, async () => {
    const env = environment(mode);
    assert.equal(await env.seek(90, "Old track"), false);
    assert.equal(await env.seek(NaN), false);
    assert.equal(env.events.length, 0);
    env.hide(); assert.equal(await env.seek(90), false);
    const ignored = environment(mode, false);
    assert.equal(await ignored.seek(90), false);
    assert.equal(ignored.position, 36);
  });
}
