import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("SoundCloud metadata and controls work without a discoverable audio element", async () => {
  let playing = true, next = 0;
  const messages = [], listeners = new Map();
  const title = { textContent: "Night song", getAttribute: () => "Night song" };
  const artist = { textContent: "Artist", getAttribute: () => "Artist" };
  const toggle = { click: () => { playing = !playing; } };
  const skip = { click: () => { next++; }, getAttribute: () => null, disabled: false };
  const footer = { querySelector(selector) {
    if (selector.includes("titleLink")) return title;
    if (selector.includes("lightLink")) return artist;
    if (selector.includes("avatar")) return null;
    if (selector.includes("skipControl__")) return skip;
    if (selector.includes("timePassed")) return { textContent: "Current time: 0:36" };
    if (selector.includes("duration")) return { textContent: "Duration: 3:05" };
    if (selector.includes("Pause current") && !selector.includes("Play current")) return playing ? toggle : null;
    if (selector.includes("playControl")) return toggle;
    return null;
  } };
  const document = { title: "Discover", querySelector: selector => selector.includes("miniplayer") ? footer : null, querySelectorAll: () => [], addEventListener() {} };
  const window = { postMessage: value => messages.push(value), addEventListener: (name, handler) => listeners.set(name, handler) };
  class Media { play() {} }
  const context = { window, document, location: { hostname: "soundcloud.com", origin: "https://soundcloud.com", href: "https://soundcloud.com/discover" }, navigator: { mediaSession: null }, HTMLMediaElement: Media, setInterval() {}, setTimeout, URL };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../chromium/soundcloud.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../chromium/player.js", import.meta.url), "utf8"), context);
  let track = messages.at(-1).track;
  assert.equal(track.title, "Night song");
  assert.equal(track.artist, "Artist");
  assert.equal(track.position, 36);
  assert.equal(track.duration, 185);
  assert.equal(track.playing, true);
  assert.equal(track.canNext, true);
  assert.equal(track.canSeek, false);
  const command = async type => listeners.get("message")({ source: window, data: { channel: "cross-di-media-v2", kind: "command", command: { id: 1, title: "Night song", artist: "Artist", action: { type } } } });
  await command("toggle");
  assert.equal(playing, false);
  assert.equal(messages.at(-1).track.playing, false);
  await command("next");
  assert.equal(next, 1);
});
