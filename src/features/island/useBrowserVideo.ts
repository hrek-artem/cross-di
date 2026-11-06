import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Offer = { id: string; sourceApp: string; sdp: string };

async function gather(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>(resolve => {
    const finish = () => { window.clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); resolve(); };
    const changed = () => { if (peer.iceGatheringState === "complete") finish(); };
    const timer = window.setTimeout(finish, 2500);
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export function useBrowserVideo(sourceApp: string | undefined, visible: boolean) {
  const [stream, setStream] = useState<{ source: string; media: MediaStream } | null>(null);
  const latest = useRef({ sourceApp, visible });
  latest.current = { sourceApp, visible };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let peer: RTCPeerConnection | null = null;
    let session: string | null = null;
    let peerSource: string | null = null;
    let watching: string | null = null;
    let timer: number;
    function close() { peer?.close(); peer = null; session = null; peerSource = null; setStream(null); }
    async function poll() {
      try {
        const current = latest.current;
        if (watching && watching !== current.sourceApp) await invoke("release_browser_video", { sourceApp: watching });
        watching = current.sourceApp?.startsWith("browser:") ? current.sourceApp : null;
        const offer = watching ? await invoke<Offer | null>("get_browser_video", { sourceApp: watching, visible: current.visible }) : null;
        if (disposed) return;
        if (!offer && peerSource === watching) close();
        else if (offer && session !== offer.id) {
          close();
          session = offer.id;
          peerSource = offer.sourceApp;
          const connection = new RTCPeerConnection({ iceServers: [] });
          peer = connection;
          connection.ontrack = event => {
            if (!disposed && peer === connection) setStream({ source: offer.sourceApp, media: event.streams[0] ?? new MediaStream([event.track]) });
          };
          connection.onconnectionstatechange = () => { if (!disposed && peer === connection && connection.connectionState === "failed") close(); };
          await connection.setRemoteDescription({ type: "offer", sdp: offer.sdp });
          await connection.setLocalDescription(await connection.createAnswer());
          await gather(connection);
          if (disposed || peer !== connection) return;
          await invoke("set_browser_video_answer", { id: offer.id, sdp: connection.localDescription!.sdp });
        }
      } catch (error) { if (!disposed) { close(); console.error("Video preview", error); } }
      if (!disposed) timer = window.setTimeout(poll, 500);
    }
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      peer?.close();
      if (watching) void invoke("release_browser_video", { sourceApp: watching }).catch(() => {});
    };
  }, []);
  return visible && stream && stream.source === sourceApp ? stream.media : null;
}
