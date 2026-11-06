import { useEffect, useRef } from "react";

type Props = { stream: MediaStream; title: string; source?: string; onOpen?: () => void };

export default function IslandVideo({ stream, title, source, onOpen }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(console.error);
    return () => { element.srcObject = null; };
  }, [stream]);
  return (
    <button className="island-video" type="button" onClick={onOpen} aria-label={`Open ${source ?? "video source"}`}>
      <video ref={video} autoPlay muted playsInline aria-hidden="true" />
      <span className="island-video-caption"><span className="island-video-live">Live</span><span title={title}>{title}</span></span>
    </button>
  );
}
