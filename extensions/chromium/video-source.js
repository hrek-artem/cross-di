function createIslandVideoSource(channel, getPlayer) {
  let current = null;
  let allowed = true;
  let retryAt = 0;
  const blocked = new WeakMap();
  const post = data => window.postMessage({ channel, ...data }, location.origin);

  function stop() {
    if (!current) return;
    const old = current;
    current = null;
    old.peer.close();
    old.stream.getTracks().forEach(track => track.stop());
    post({ kind: "video-offer", offer: null });
  }

  async function begin(element) {
    const source = element.currentSrc;
    if (typeof element.captureStream !== "function") {
      blocked.set(element, source);
      post({ kind: "video-status", status: "This player does not expose a video stream." });
      return;
    }
    let stream;
    try {
      stream = element.captureStream();
      const stopAudio = () => stream.getAudioTracks().forEach(track => track.stop());
      stopAudio();
      stream.addEventListener?.("addtrack", stopAudio);
      if (!stream.getVideoTracks().length) await new Promise(resolve => {
        const finish = () => { clearTimeout(timeout); stream.removeEventListener?.("addtrack", changed); resolve(); };
        const changed = () => { if (stream.getVideoTracks().length) finish(); };
        const timeout = setTimeout(finish, 1800);
        stream.addEventListener?.("addtrack", changed);
      });
      if (!allowed || getPlayer() !== element || element.currentSrc !== source) { stream.getTracks().forEach(track => track.stop()); retryAt = 0; return; }
      const tracks = stream.getVideoTracks();
      if (!tracks.length) {
        stream.getTracks().forEach(track => track.stop());
        post({ kind: "video-status", status: "The player has not exposed its video track yet." });
        retryAt = Date.now() + 1500;
        return;
      }
      const peer = new RTCPeerConnection({ iceServers: [] });
      const state = { id: crypto.randomUUID(), element, source, stream, peer, sdp: null, answer: null };
      current = state;
      for (const track of tracks) {
        track.enabled = false;
        const sender = peer.addTrack(track, stream);
        const parameters = sender.getParameters();
        parameters.encodings = [{ ...(parameters.encodings?.[0] || {}), maxBitrate: 2500000, maxFramerate: 30, scaleResolutionDownBy: Math.max(1, (element.videoWidth || 640) / 1280) }];
        await sender.setParameters(parameters).catch(() => {});
      }
      peer.addEventListener("connectionstatechange", () => {
        if (current === state && peer.connectionState === "failed") { stop(); retryAt = Date.now() + 3000; }
      });
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete") await new Promise(resolve => {
        const done = () => { clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", changed); resolve(); };
        const changed = () => { if (peer.iceGatheringState === "complete") done(); };
        const timeout = setTimeout(done, 1500);
        peer.addEventListener("icegatheringstatechange", changed);
      });
      if (current !== state) return;
      state.sdp = peer.localDescription.sdp;
      post({ kind: "video-offer", offer: { id: state.id, sdp: state.sdp } });
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      stop();
      blocked.set(element, source);
      post({ kind: "video-status", status: `Direct video unavailable (${error.name || "Error"}). Showing artwork instead.` });
    }
  }

  function update() {
    const element = getPlayer();
    const video = element?.tagName === "VIDEO" && element.videoWidth > 0 && !element.ended ? element : null;
    if (current && (current.element !== video || current.source !== video?.currentSrc || current.stream.getVideoTracks().every(track => track.readyState === "ended"))) { stop(); retryAt = 0; }
    if (!allowed || !video || current || Date.now() < retryAt || blocked.has(video) && blocked.get(video) === video.currentSrc) return;
    // Mark the attempt before creating a peer so rapid player events cannot start duplicates.
    retryAt = Date.now() + 2000;
    void begin(video);
  }

  window.addEventListener("message", async event => {
    if (event.source !== window || event.data?.channel !== channel) return;
    if (event.data.kind === "video-retry") { const element = getPlayer(); if (element) blocked.delete(element); retryAt = 0; stop(); update(); return; }
    if (event.data.kind !== "video-state") return;
    allowed = Boolean(event.data.enabled);
    if (!allowed) { stop(); return; }
    const state = current;
    if (!state || state.id !== event.data.id) return;
    state.stream.getVideoTracks().forEach(track => { track.enabled = Boolean(event.data.visible); });
    const answer = event.data.answer;
    if (answer && answer !== state.answer) {
      if (state.answer) { stop(); retryAt = 0; update(); return; }
      try { state.answer = answer; await state.peer.setRemoteDescription({ type: "answer", sdp: answer }); }
      catch { stop(); retryAt = Date.now() + 2000; }
    }
  });
  return {
    update() { update(); if (current?.sdp) post({ kind: "video-offer", offer: { id: current.id, sdp: current.sdp } }); },
    stop() { allowed = false; stop(); },
  };
}
