import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const code = readFileSync(new URL("../chromium/background.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

function environment() {
  const requests = [];
  const calls = [];
  const local = { token: "a".repeat(64), clientId: "test-edge" };
  let listener;
  let onRemoved;
  let commands = [];
  const offscreen = [];
  let updated;
  const chrome = {
    runtime: {
      id: "extension-id", onMessage: { addListener(callback) { listener = callback; } },
      getURL: path => `chrome-extension://extension-id/${path}`,
      async sendNativeMessage() { return { token: "a".repeat(64), protocol: 2 }; },
      async sendMessage(message) { offscreen.push(message); return { success: true }; },
      async getContexts() { return []; },
      onInstalled: { addListener() {} },
    },
    tabCapture: { async getMediaStreamId() { return "stream-id"; } },
    offscreen: { async createDocument() {} },
    storage: {
      local: { async setAccessLevel() {}, async get() { return local; }, async set(value) { Object.assign(local, value); }, async remove(key) { delete local[key]; } },
      session: { async set() {} },
    },
    tabs: {
      async sendMessage(tab, message, options) { calls.push({ tab, message, options }); return true; },
      async update(tab) { calls.push({ open: tab }); }, async get() { return { windowId: 7 }; },
      onRemoved: { addListener(callback) { onRemoved = callback; } },
      onUpdated: { addListener(callback) { updated = callback; } },
      async query() { return [{ id: 12, url: "https://www.youtube.com/watch?v=test" }]; },
    },
    windows: { async update(id, options) { calls.push({ window: id, options }); } },
  };
  vm.runInNewContext(code, {
    chrome, navigator: { userAgent: "Edg/156.0" }, URL, crypto: { randomUUID: () => "new-id" }, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      const next = commands;
      commands = [];
      return { ok: true, async json() { return { commands: next }; } };
    },
  });
  const sender = { id: "extension-id", tab: { id: 12 }, frameId: 3, url: "https://www.youtube.com/watch?v=private-url" };
  return {
    requests, calls, local, offscreen,
    send: message => listener(message, sender, () => {}),
    extensionMessage: message => new Promise(resolve => listener(message, { id: "extension-id" }, resolve)),
    setCommands: value => { commands = value; },
    close: () => onRemoved(12),
    navigate: () => updated(12, { status: "loading" }),
    sendTopFrame: message => listener(message, { ...sender, frameId: 0 }, () => {}),
    offer: () => listener({ type: "video-offer", offer: { id: "new-id", sdp: "v=0\r\n" } }, { ...sender, frameId: 0 }, () => {}),
  };
}

const snapshot = { type: "snapshot", track: { title: "Song", artist: "Artist", playing: true, position: 3, duration: 100, rate: 1, canToggle: true, artwork: null } };

test("worker connects automatically, authenticates local requests and targets the exact frame", async () => {
  const env = environment();
  env.setCommands([{ id: 9, session: "12:3", title: "Song", artist: "Artist", action: { type: "toggle" } }]);
  env.send(snapshot);
  await flush();
  assert.equal(env.requests[0].url, "http://127.0.0.1:43191/sync");
  assert.equal(env.requests[0].headers.Authorization, `Bearer ${"a".repeat(64)}`);
  assert.equal(env.local.token, undefined);
  assert.equal(env.requests[0].body.sessions[0].sourceName, "YouTube · Edge");
  assert.equal(JSON.stringify(env.requests[0].body).includes("private-url"), false);
  assert.equal(env.calls[0].tab, 12);
  assert.equal(env.calls[0].options.frameId, 3);
  assert.equal(env.requests.at(-1).body.acknowledgements[0].success, true);
  env.close();
  await flush();
  assert.equal(env.requests.at(-1).body.sessions.length, 0);
});

test("direct video offers connect automatically and stop on navigation or disabling", async () => {
  const env = environment();
  env.sendTopFrame({ ...snapshot, track: { ...snapshot.track, hasVideo: true } });
  await flush();
  assert.equal(env.offscreen.length, 0);
  env.offer();
  await flush();
  assert.equal(env.requests.at(-1).body.video.session, "12:0");
  assert.equal((await env.extensionMessage({ type: "video-enabled", enabled: false })).success, true);
  await flush();
  assert.equal(env.requests.at(-1).body.video, null);
  assert.equal(env.calls.at(-1).message.enabled, false);
  env.navigate();
  await flush();
  assert.equal(env.requests.at(-1).body.video, null);
  assert.equal(env.requests.at(-1).body.sessions.length, 0);
});

test("open focuses the existing tab and disconnect stops sending playback", async () => {
  const env = environment();
  env.setCommands([{ id: 10, session: "12:3", title: "Song", artist: "Artist", action: { type: "open" } }]);
  env.send(snapshot);
  await flush();
  assert.equal(env.calls[0].open, 12);
  assert.equal(env.calls[1].window, 7);
  await env.extensionMessage({ type: "disconnect" });
  const count = env.requests.length;
  env.send(snapshot);
  await flush();
  assert.equal(env.requests.length, count);
  assert.equal(env.local.token, undefined);
});
