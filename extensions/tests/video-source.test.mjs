import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const code = readFileSync(new URL("../chromium/video-source.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function environment(restricted = false, delayed = false) {
  const messages = [], peers = [], streams = [];
  let listener, attempts = 0;
  const track = kind => ({ kind, enabled: true, readyState: "live", stop() { this.readyState = "ended"; } });
  const element = { tagName: "VIDEO", videoWidth: 1920, currentSrc: "blob:video-one", mediaKeys: null, ended: false,
    captureStream() {
      attempts++;
      if (restricted) throw new Error("Cross-origin video");
      const video = track("video"), audio = track("audio");
      let ready = !delayed;
      const callbacks = new Set();
      const stream = { getAudioTracks: () => [audio], getVideoTracks: () => ready ? [video] : [], getTracks: () => [video, audio], addEventListener: (_event, callback) => callbacks.add(callback), removeEventListener: (_event, callback) => callbacks.delete(callback) };
      if (delayed) setImmediate(() => { ready = true; for (const callback of callbacks) callback({ track: video }); });
      streams.push(stream);
      return stream;
    },
  };
  class Peer {
    iceGatheringState = "complete";
    tracks = [];
    closed = false;
    constructor() { peers.push(this); }
    addTrack(track) { this.tracks.push(track); return { getParameters: () => ({}), async setParameters() {} }; }
    addEventListener() {}
    async createOffer() { return { type: "offer", sdp: "v=0\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    close() { this.closed = true; }
  }
  const window = { postMessage: message => messages.push(message), addEventListener: (_name, callback) => { listener = callback; } };
  const context = { window, location: { origin: "https://video.example" }, RTCPeerConnection: Peer, crypto: { randomUUID: () => `video-${peers.length}` }, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(code, context);
  const source = context.createIslandVideoSource("test", () => element);
  return { source, element, messages, peers, streams, attempts: () => attempts,
    state: value => listener({ source: window, data: { channel: "test", kind: "video-state", enabled: true, id: messages.find(m => m.offer)?.offer.id, ...value } }),
  };
}

test("automatically captures only the video track and preserves the peer across hiding", async () => {
  const env = environment();
  env.source.update();
  await flush();
  assert.equal(env.attempts(), 1);
  assert.equal(env.peers[0].tracks.length, 1);
  assert.equal(env.peers[0].tracks[0].kind, "video");
  assert.equal(env.streams[0].getAudioTracks()[0].readyState, "ended");
  assert.equal(env.peers[0].tracks[0].enabled, false);
  await env.state({ answer: "v=0\r\nanswer", visible: true });
  assert.equal(env.peers[0].tracks[0].enabled, true);
  await env.state({ visible: false });
  assert.equal(env.peers[0].closed, false);
  await env.state({ visible: true });
  env.source.update();
  assert.equal(env.peers.length, 1);
  env.source.stop();
  assert.equal(env.peers[0].closed, true);
});

test("changing the video rebuilds the stream and restricted sources never trigger screen capture", async () => {
  const env = environment();
  env.source.update(); await flush();
  env.element.currentSrc = "blob:video-two";
  env.source.update(); await flush();
  assert.equal(env.peers[0].closed, true);
  assert.equal(env.attempts(), 2);
  assert.equal(env.peers.length, 2);
  const restricted = environment(true);
  restricted.source.update(); await flush();
  restricted.source.update();
  assert.equal(restricted.attempts(), 1);
  assert.equal(restricted.peers.length, 0);
  assert.equal(restricted.messages.at(-1).kind, "video-status");
});

test("waits for asynchronous media tracks instead of discarding an initially empty stream", async () => {
  const env = environment(false, true);
  env.source.update();
  await flush();
  assert.equal(env.attempts(), 1);
  assert.equal(env.peers.length, 1);
  assert.ok(env.messages.some(message => message.kind === "video-offer" && message.offer));
  env.source.stop();
});
