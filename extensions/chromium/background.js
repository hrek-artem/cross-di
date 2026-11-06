const endpoint = "http://127.0.0.1:43191/sync";
const sessions = new Map();
let token = "", clientId = "";
let enabled = true, videoEnabled = true;
let lastNativeAttempt = 0, syncPromise = null, dirty = false;
let videoIssue = "";
const acknowledgements = [];
const initialized = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = await chrome.storage.local.get(["clientId", "enabled", "videoEnabled"]);
  enabled = stored.enabled !== false;
  videoEnabled = stored.videoEnabled !== false;
  clientId = stored.clientId || crypto.randomUUID();
  if (!stored.clientId) await chrome.storage.local.set({ clientId });
  if (enabled) await nativeConnect().catch(() => {});
})();

async function nativeConnect() {
  lastNativeAttempt = Date.now();
  const result = await chrome.runtime.sendNativeMessage("com.cross_di.browser", { type: "connect" });
  if (result.error || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error(result.error || "Open the Dynamic Island app first.");
  token = result.token;
  await chrome.storage.local.remove("token");
}

function label(url) {
  const host = new URL(url).hostname;
  const sites = { "www.youtube.com": "YouTube", "music.youtube.com": "YouTube Music", "soundcloud.com": "SoundCloud", "open.spotify.com": "Spotify", "music.yandex.ru": "Yandex Music", "music.yandex.com": "Yandex Music" };
  return `${sites[host] || host} · ${navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome"}`;
}

async function videoState(entry, state = {}) {
  return chrome.tabs.sendMessage(entry.tabId, { type: "video-state", enabled: enabled && videoEnabled && Boolean(token), id: entry.offer?.id, visible: false, ...state }, { frameId: entry.frameId }).catch(() => {});
}

async function execute(command) {
  const entry = sessions.get(command.session);
  if (!entry) return false;
  if (command.action.type === "open") {
    await chrome.tabs.update(entry.tabId, { active: true });
    const tab = await chrome.tabs.get(entry.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  }
  return Boolean(await chrome.tabs.sendMessage(entry.tabId, { type: "control", command }, { frameId: entry.frameId }));
}

function sync() {
  if (syncPromise) { dirty = true; return syncPromise; }
  syncPromise = sendSync().finally(() => { syncPromise = null; if (dirty) { dirty = false; void sync(); } });
  return syncPromise;
}

async function sendSync() {
  await initialized;
  if (!enabled) return false;
  if (!token && Date.now() - lastNativeAttempt > 10000) await nativeConnect().catch(() => {});
  if (!token) return false;
  const acks = acknowledgements.splice(0);
  try {
    for (const [id, entry] of sessions) if (Date.now() - entry.seen > 5000) sessions.delete(id);
    const selected = videoEnabled ? [...sessions.values()].filter(e => e.offer).sort((a, b) => Number(b.track.playing) - Number(a.track.playing) || b.changed - a.changed)[0] : null;
    const offer = selected?.offer;
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId, sessions: [...sessions.values()].slice(0, 32).map(e => e.track), acknowledgements: acks,
        video: offer ? { id: offer.id, session: selected.track.id, sdp: offer.sdp } : null, videoStatus: videoIssue }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("Island rejected the connection.");
    const { commands, videoAnswer, videoVisible } = await response.json();
    await Promise.all([...sessions.values()].filter(e => e.hasVideo).map(entry => videoState(entry, entry === selected ? { answer: videoAnswer, visible: videoVisible } : {})));
    await chrome.storage.session.set({ connection: "Connected", video: selected ? "Video connects automatically" : videoIssue || "Waiting for video" });
    for (const command of commands) {
      acknowledgements.push({ id: command.id, success: await execute(command).catch(() => false) });
      dirty = true;
    }
    return true;
  } catch {
    acknowledgements.unshift(...acks);
    await chrome.storage.session.set({ connection: "Open the Dynamic Island app to connect." });
    if (Date.now() - lastNativeAttempt > 10000) await nativeConnect().catch(() => {});
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.tab && /^https:\/\//.test(sender.url || "")) {
    const id = `${sender.tab.id}:${sender.frameId}`;
    const old = sessions.get(id);
    if (message.type === "snapshot") {
      const track = message.track;
      if (track && typeof track.title === "string" && typeof track.artist === "string") {
        const changed = !old || old.track.title !== track.title || old.track.artist !== track.artist || old.track.playing !== Boolean(track.playing);
        const entry = { tabId: sender.tab.id, frameId: sender.frameId, seen: Date.now(), changed: changed ? Date.now() : old.changed,
          hasVideo: Boolean(track.hasVideo), offer: old?.offer ?? null, track: {
            id, title: track.title.slice(0, 512), artist: track.artist.slice(0, 256), sourceName: label(sender.url),
            playing: Boolean(track.playing), position: Math.max(0, Number(track.position) || 0), duration: Math.max(0, Number(track.duration) || 0),
            volume: Math.max(0, Math.min(1, Number.isFinite(track.volume) ? track.volume : 1)), canSetVolume: Boolean(track.canSetVolume),
            rate: Math.max(0, Math.min(16, Number(track.rate) || 0)), canToggle: Boolean(track.canToggle), canPrevious: Boolean(track.canPrevious), canNext: Boolean(track.canNext), canSeek: Boolean(track.canSeek),
            artwork: typeof track.artwork === "string" && track.artwork.length <= 65536 && track.artwork.startsWith("data:image/jpeg;base64,") ? track.artwork : null,
          } };
        sessions.set(id, entry);
        if (!enabled) void videoState(entry);
      } else { if (old) void videoState(old, { enabled: false }); sessions.delete(id); }
      void sync();
    } else if (message.type === "video-offer" && old) {
      const offer = message.offer;
      old.offer = offer && /^[a-zA-Z0-9_-]{1,128}$/.test(offer.id) && typeof offer.sdp === "string" && offer.sdp.startsWith("v=0\r\n") && offer.sdp.length <= 65536 ? { id: offer.id, sdp: offer.sdp } : null;
      if (old.offer) videoIssue = "";
      void sync();
    } else if (message.type === "video-status") {
      videoIssue = String(message.status).slice(0, 256);
      void chrome.storage.session.set({ video: videoIssue });
    }
    return;
  }
  if (message.type === "connect") {
    void (async () => {
      await initialized;
      enabled = true;
      await chrome.storage.local.set({ enabled: true });
      try { await nativeConnect(); }
      catch (error) { return reply({ connected: false, error: "Open the app once, then reconnect. " + error.message }); }
      if (syncPromise) await syncPromise;
      reply({ connected: Boolean(await sync()) });
    })();
    return true;
  }
  if (message.type === "video-enabled") {
    void (async () => {
      await initialized;
      videoEnabled = Boolean(message.enabled);
      await chrome.storage.local.set({ videoEnabled });
      await Promise.all([...sessions.values()].map(entry => videoState(entry)));
      void sync();
      reply({ success: true });
    })();
    return true;
  }
  if (message.type === "retry-video") {
    void Promise.all([...sessions.values()].filter(e => e.hasVideo).map(e => chrome.tabs.sendMessage(e.tabId, { type: "video-retry" }, { frameId: e.frameId }).catch(() => {}))).then(() => reply({ success: true }));
    return true;
  }
  if (message.type === "disconnect") {
    void (async () => {
      await initialized;
      token = ""; enabled = false;
      await chrome.storage.local.set({ enabled: false });
      await Promise.all([...sessions.values()].map(e => videoState(e)));
      await chrome.storage.session.set({ connection: "Not connected" });
      reply({ connected: false });
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => { for (const [id, entry] of sessions) if (entry.tabId === tabId) sessions.delete(id); void sync(); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "loading") { for (const [id, entry] of sessions) if (entry.tabId === tabId) sessions.delete(id); void sync(); } });
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    for (const tab of await chrome.tabs.query({ url: ["https://*/*"] })) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["soundcloud.js", "spotify.js", "dom-player.js", "relay.js"] }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["video-source.js", "soundcloud.js", "spotify.js", "player.js"] }).catch(() => {});
    }
  })();
});
