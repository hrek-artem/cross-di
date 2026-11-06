import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function environment() {
  const messages = [], listeners = new Map(), ticks = [];
  const session = {
    metadata: { title: "Session track", artist: "Session artist", artwork: [] },
    playbackState: "playing", setActionHandler() {}, setPositionState() {},
  };
  const originals = { action: session.setActionHandler, position: session.setPositionState };
  const window = { postMessage: value => messages.push(value), addEventListener: (name, fn) => listeners.set(name, fn) };
  const document = { title: "Spotify", querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ window, document, navigator: { mediaSession: session },
    location: { hostname: "open.spotify.com", origin: "https://open.spotify.com", href: "https://open.spotify.com/" },
    HTMLMediaElement: class { play() {} }, setInterval: fn => ticks.push(fn), clearInterval() {}, setTimeout, URL });
  for (const file of ["spotify.js", "player.js"]) vm.runInContext(readFileSync(new URL("../chromium/" + file, import.meta.url), "utf8"), context);
  return {
    session, originals,
    snapshot: () => messages.filter(m => m.kind === "snapshot").at(-1)?.track,
    tick: () => ticks.forEach(fn => fn()),
    dispose: () => listeners.get("cross-di-player-replace")(),
    async command(action) {
      await listeners.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "command",
        command: { id: 1, title: "Session track", artist: "Session artist", action } } });
      return messages.filter(m => m.kind === "ack").at(-1).success;
    },
  };
}

test("Spotify reports MediaSession metadata without any audio element or matching DOM selectors", async () => {
  const env = environment();
  assert.equal(env.snapshot().title, "Session track");
  assert.equal(env.snapshot().artist, "Session artist");
  assert.equal(env.snapshot().playing, true);
  assert.equal(env.snapshot().canToggle, false);
  env.session.setActionHandler("pause", () => { env.session.playbackState = "paused"; });
  env.session.setActionHandler("play", () => { env.session.playbackState = "playing"; });
  env.session.setPositionState({ duration: 240, position: 42, playbackRate: 1 });
  env.tick();
  assert.equal(env.snapshot().duration, 240);
  assert.ok(Math.abs(env.snapshot().position - 42) < .5);
  assert.equal(env.snapshot().canToggle, true);
  assert.equal(await env.command({ type: "toggle" }), true);
  assert.equal(env.snapshot().playing, false);
  assert.equal(await env.command({ type: "toggle" }), true);
  assert.equal(env.snapshot().playing, true);
});

test("Spotify seeking uses captured media actions and removes wrappers on replacement", async () => {
  const env = environment();
  env.session.setPositionState({ duration: 240, position: 0 });
  env.session.setActionHandler("seekto", ({ seekTime }) => {
    env.session.setPositionState({ duration: 240, position: seekTime });
  });
  env.tick(); assert.equal(env.snapshot().canSeek, true);
  assert.equal(await env.command({ type: "seek", seconds: 87.5 }), true);
  assert.ok(Math.abs(env.snapshot().position - 87.5) < .5);
  env.dispose();
  assert.equal(env.session.setActionHandler, env.originals.action);
  assert.equal(env.session.setPositionState, env.originals.position);
});
