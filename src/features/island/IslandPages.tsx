import { useRef, useState, type ReactNode, type WheelEvent } from "react";
import type { AppShortcut } from "./preferences";
import AppsPage from "./pages/AppsPage";
import CalendarPage from "./pages/CalendarPage";
import SystemPage from "./pages/SystemPage";
import type { SystemSample } from "./useSystemSample";
import "./IslandPages.css";

const pages = ["Music", "Calendar", "Apps", "System"] as const;
export type IslandPage = (typeof pages)[number];

type Props = {
  visible: boolean;
  music: ReactNode;
  page: IslandPage;
  onSelect: (page: IslandPage) => void;
  sample: SystemSample | null;
  pinnedApps: AppShortcut[];
  appIcons: Record<string, string>;
  onCollapse: () => void;
  pinned: boolean;
  onPin: () => void;
};

export default function IslandPages({ visible, music, page, onSelect, sample, pinnedApps, appIcons, onCollapse, pinned, onPin }: Props) {
  const [direction, setDirection] = useState(1);
  const wheel = useRef({ time: 0, delta: 0, consumed: false });
  const index = pages.indexOf(page);

  function select(next: number) {
    if (next < 0 || next >= pages.length || next === index) return;
    setDirection(next > index ? 1 : -1);
    onSelect(pages[next]);
  }

  function scroll(event: WheelEvent<HTMLDivElement>) {
    if (!visible || event.ctrlKey || (event.target instanceof HTMLInputElement && document.activeElement === event.target)) return;
    const now = performance.now();
    const gesture = wheel.current;
    if (now - gesture.time > 160) {
      gesture.delta = 0;
      gesture.consumed = false;
    }
    gesture.time = now;
    if (gesture.consumed) return;

    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 216 : 1;
    gesture.delta += delta * scale;
    if (Math.abs(gesture.delta) >= 26) {
      gesture.consumed = true;
      select(index + Math.sign(gesture.delta));
    }
  }

  return (
    <div className="island-pages" onWheel={scroll} onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        select(index + (event.key === "PageDown" ? 1 : -1));
      }
    }}>
      <section className="island-page" key={page} aria-label={page} data-direction={direction}>
        {page === "Music" ? music : (
          <div className="island-widget">
            <header className="island-widget-header">
              <strong>{page}</strong>
            </header>
            {page === "Calendar" && <CalendarPage />}
            {page === "Apps" && <AppsPage apps={pinnedApps} icons={appIcons} />}
            {page === "System" && <SystemPage sample={sample} />}
          </div>
        )}
      </section>
      <div className="island-page-rail">
        <button type="button" className="island-widget-button island-page-collapse" aria-label="Collapse island" onClick={onCollapse}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m4 10 4-4 4 4" /></svg>
        </button>
        <button type="button" className="island-widget-button island-page-pin" aria-label={pinned ? "Unpin island" : "Keep island open"} aria-pressed={pinned} title={pinned ? "Unpin island" : "Keep island open"} onClick={onPin}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="7" width="9" height="7" rx="2" /><path d={pinned ? "M5 7V4.5a3 3 0 0 1 6 0V7" : "M5 7V4.5a3 3 0 0 1 5.7-1.3"} /></svg>
        </button>
        <nav className="island-page-picker" aria-label="Island pages">
          {pages.map((label, next) => (
            <button key={label} type="button" aria-label={label} title={label} aria-current={next === index ? "page" : undefined} onClick={() => select(next)} />
          ))}
        </nav>
      </div>
    </div>
  );
}
