import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const code = readFileSync(new URL("../chromium/player.js", import.meta.url), "utf8");

function playerEnvironment() {
  const listeners = new Map();
  const published = [];
  const interval = [];
  class Media {
    isConnected = true;
    ended = false;
    paused = false;
    readyState = 4;
    currentTime = 42;
    duration = 240;
    playbackRate = 1;
    seekable = { length: 1 };
    pause() { this.paused = true; }
    async play() { this.paused = false; }
  }
  const media = new Media();
  let present = true;
  const session = { metadata: { title: "Browser track", artist: "Artist", artwork: [] }, setActionHandler() {} };
  const window = {
    Audio: class Audio extends Media { constructor() { super(); this.tagName = "AUDIO"; this.isConnected = false; this.paused = true; this.currentTime = 0; } },
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(data) { published.push(data); },
  };
  const document = {
    title: "Page title", addEventListener() {},
    querySelectorAll() { return present ? [media] : []; },
    querySelector() { return null; },
  };
  vm.runInNewContext(code, { window, document, navigator: { mediaSession: session }, location: { origin: "https://music.example", href: "https://music.example/" }, HTMLMediaElement: Media, setTimeout, setInterval: callback => interval.push(callback), URL });
  return {
    media, session, published,
    detachedAudio: () => Object.assign(new Media(), { tagName: "AUDIO", isConnected: false, paused: true, currentTime: 0 }),
    newAudio: () => new window.Audio(),
    tick: () => interval[0](),
    close: () => { present = false; media.isConnected = false; },
    command: async action => listeners.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "command", command: { id: 1, title: "Browser track", artist: "Artist", action } } }),
  };
}

test("reports the active media element and updates pause and seek immediately", async () => {
  const env = playerEnvironment();
  assert.equal(env.published.at(-1).track.title, "Browser track");
  assert.equal(env.published.at(-1).track.position, 42);
  await env.command({ type: "toggle" });
  assert.equal(env.media.paused, true);
  assert.equal(env.published.at(-1).track.playing, false);
  await env.command({ type: "seek", seconds: 100 });
  assert.equal(env.media.currentTime, 100);
  assert.equal(env.published.at(-2).success, true);
  env.close();
  env.tick();
  assert.equal(env.published.at(-1).track, null);
});

test("finds detached JavaScript audio players and keeps paused tracks visible", async () => {
  const env = playerEnvironment();
  env.close();
  env.tick();
  assert.equal(env.published.at(-1).track, null);
  const audio = env.detachedAudio();
  const operation = audio.play();
  assert.ok(operation instanceof Promise);
  await operation;
  audio.currentTime = 12;
  env.tick();
  assert.equal(env.published.at(-1).track.playing, true);
  assert.equal(env.published.at(-1).track.position, 12);
  await env.command({ type: "toggle" });
  assert.equal(audio.paused, true);
  assert.equal(env.published.at(-1).track.playing, false);
  audio.ended = true;
  env.tick();
  assert.equal(env.published.at(-1).track, null);
});

test("observes new Audio players that start without a JavaScript play call", () => {
  const env = playerEnvironment();
  env.close();
  const audio = env.newAudio();
  audio.paused = false;
  audio.currentTime = 5;
  env.tick();
  assert.equal(env.published.at(-1).track.position, 5);
  assert.equal(env.published.at(-1).track.playing, true);
});

test("uses website next-track handlers and rejects unavailable controls", async () => {
  const env = playerEnvironment();
  await env.command({ type: "previous" });
  assert.equal(env.published.at(-2).success, false);
  let nextCalled = false;
  env.session.setActionHandler("nexttrack", () => { nextCalled = true; });
  env.tick();
  assert.equal(env.published.at(-1).track.canNext, true);
  await env.command({ type: "next" });
  assert.equal(nextCalled, true);
  assert.equal(env.published.at(-2).success, true);
});

test("live streams never expose an invalid duration or seeking", () => {
  const env = playerEnvironment();
  env.media.duration = Infinity;
  env.tick();
  assert.equal(env.published.at(-1).track.duration, 0);
  assert.equal(env.published.at(-1).track.canSeek, false);
});

test("volume controls adjust source audio and unmute instead of changing the muted preview", async () => {
  const env = playerEnvironment(); env.media.volume = .8; env.media.muted = true; env.tick();
  assert.equal(env.published.at(-1).track.volume, 0);
  assert.equal(env.published.at(-1).track.canSetVolume, true);
  await env.command({ type: "volume", level: .35 });
  assert.equal(env.media.volume, .35); assert.equal(env.media.muted, false);
  assert.equal(env.published.at(-2).success, true);
  await env.command({ type: "volume", level: NaN });
  assert.equal(env.published.at(-2).success, false);
});
