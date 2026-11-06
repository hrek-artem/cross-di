(() => {
  const channel = "cross-di-media-v2";
  if (window.dispatchEvent) window.dispatchEvent(new Event("cross-di-relay-replace"));
  let disposed = false;
  let lastMainTrack = null, lastMainAt = 0;
  const pending = new Map();
  const fallback = typeof createIslandDOMPlayer === "function" ? createIslandDOMPlayer() : null;
  const usesFallback = () => !lastMainTrack || Date.now() - lastMainAt > 2000;
  const heartbeat = setInterval(() => {
    if (!disposed && fallback && usesFallback()) send(fallbackSnapshot());
  }, 700);

  function alive() {
    try { return Boolean(chrome.runtime?.id); }
    catch { return false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    for (const reply of pending.values()) reply(false);
    pending.clear();
    window.removeEventListener?.("message", fromPage);
    window.removeEventListener?.("cross-di-relay-replace", dispose);
    try { chrome.runtime.onMessage.removeListener?.(fromExtension); }
    catch { /* An invalidated extension no longer owns a runtime listener. */ }
  }

  function failed(error) {
    if (!alive() || /extension context invalidated/i.test(String(error?.message ?? error))) dispose();
  }

  function sendRuntime(message) {
    if (disposed) return;
    if (!alive()) { dispose(); return; }
    // sendMessage can throw synchronously after Reload, before returning a Promise.
    try { void Promise.resolve(chrome.runtime.sendMessage(message)).catch(failed); }
    catch (error) { failed(error); }
  }

  const send = track => sendRuntime({ type: "snapshot", track });

  function fallbackSnapshot() {
    try { return fallback?.snapshot() ?? null; }
    catch (error) { failed(error); return null; }
  }

  function fromPage(event) {
    if (disposed || event.source !== window || event.data?.channel !== channel) return;
    if (event.data.kind === "snapshot") {
      lastMainTrack = event.data.track; lastMainAt = Date.now();
      send(lastMainTrack ?? fallbackSnapshot());
    } else if (event.data.kind === "ack" && pending.has(event.data.id)) {
      pending.get(event.data.id)(Boolean(event.data.success));
      pending.delete(event.data.id);
    } else if (event.data.kind === "video-offer") {
      sendRuntime({ type: "video-offer", offer: event.data.offer });
    } else if (event.data.kind === "video-status") {
      sendRuntime({ type: "video-status", status: event.data.status });
    }
  }

  function fromExtension(message, _sender, reply) {
    if (disposed) return;
    const respond = value => {
      try { reply(value); }
      catch (error) { failed(error); }
    };
    if (message.type === "video-state" || message.type === "video-retry") {
      window.postMessage({ channel, kind: message.type, ...message }, location.origin);
      respond(true);
      return;
    }
    if (message.type !== "control") return;
    const command = message.command;
    if (fallback && usesFallback()) {
      void Promise.resolve().then(() => fallback.control(command)).then(success => {
        respond(!disposed && Boolean(success));
        if (!disposed) send(fallbackSnapshot());
      }, error => { failed(error); respond(false); });
      return true;
    }
    const timeout = setTimeout(() => { pending.delete(command.id); respond(false); }, 2000);
    pending.set(command.id, success => { clearTimeout(timeout); respond(success); });
    window.postMessage({ channel, kind: "command", command }, location.origin);
    return true;
  }

  window.addEventListener("cross-di-relay-replace", dispose);
  window.addEventListener("message", fromPage);
  chrome.runtime.onMessage.addListener(fromExtension);
})();
