import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const code = readFileSync(new URL("../chromium/relay.js", import.meta.url), "utf8");

function environment() {
  const handlers = new Map(), intervals = new Set(), timeouts = new Map(), responses = [];
  let sendError = null, sends = 0, runtimeHandler;
  const runtime = {
    id: "test-extension",
    sendMessage() {
      sends++;
      if (sendError === "sync") throw new Error("Extension context invalidated.");
      if (sendError === "async") return Promise.reject(new Error("Extension context invalidated."));
      if (sendError === "transient") return Promise.reject(new Error("The message port closed before a response was received."));
      return Promise.resolve();
    },
    onMessage: { addListener(fn) { runtimeHandler = fn; }, removeListener() {} },
  };
  const window = {
    addEventListener(name, fn) { handlers.set(name, fn); },
    removeEventListener(name, fn) { if (handlers.get(name) === fn) handlers.delete(name); },
    postMessage() {},
  };
  vm.runInNewContext(code, {
    window, chrome: { runtime }, location: { origin: "https://soundcloud.com" },
    createIslandDOMPlayer: () => ({ snapshot: () => ({ title: "Track", artist: "Artist" }), control: async () => true }),
    setInterval(fn) { intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
    setTimeout(fn) { const timer = Symbol(); timeouts.set(timer, fn); return timer; },
    clearTimeout(timer) { timeouts.delete(timer); },
  });
  return {
    runtime, intervals, timeouts, responses,
    get sends() { return sends; },
    fail(type) { sendError = type; },
    tick() { for (const fn of [...intervals]) fn(); },
    snapshot() { handlers.get("message")?.({ source: window, data: { channel: "cross-di-media-v2", kind: "snapshot", track: { title: "Track", artist: "Artist" } } }); },
    replace() { handlers.get("cross-di-relay-replace")?.(); },
    command() { runtimeHandler({ type: "control", command: { id: 1, action: { type: "toggle" } } }, {}, value => responses.push(value)); },
  };
}

test("extension reload stops an invalidated relay without synchronous error spam", () => {
  const env = environment();
  env.fail("sync");
  assert.doesNotThrow(() => env.snapshot());
  env.tick(); env.snapshot();
  assert.equal(env.sends, 1);
  assert.equal(env.intervals.size, 0);
});

test("asynchronous context invalidation also releases the fallback heartbeat", async () => {
  const env = environment(); env.fail("async");
  env.tick(); await new Promise(setImmediate);
  env.tick(); env.snapshot();
  assert.equal(env.sends, 1);
  assert.equal(env.intervals.size, 0);
});

test("a transient service worker disconnect does not permanently stop the relay", async () => {
  const env = environment(); env.fail("transient");
  env.tick(); await new Promise(setImmediate);
  env.fail(null); env.tick(); await new Promise(setImmediate);
  assert.equal(env.sends, 2);
  assert.equal(env.intervals.size, 1);
});

test("replacing relay clears pending command timeout and replies once", async () => {
  const env = environment();
  env.snapshot(); env.command(); env.replace();
  assert.deepEqual(env.responses, [false]);
  assert.equal(env.intervals.size, 0);
  assert.equal(env.timeouts.size, 0);
});
