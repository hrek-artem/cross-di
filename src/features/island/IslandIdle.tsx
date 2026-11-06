import { useEffect, useState } from "react";
import type { IslandSettings, WeatherCity } from "./preferences";
import { percent, type SystemSample } from "./useSystemSample";
import { currentTemperature } from "./weather";

const clockLabel = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const weatherInterval = 10 * 60 * 1000;

type Reading = { cityId: number; degrees: number; updatedAt: number };
let latestReading: Reading | null = null;

function Clock({ visible }: { visible: boolean }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!visible) return;
    let timer: number;
    function tick() {
      setNow(new Date());
      timer = window.setTimeout(tick, 60_000 - Date.now() % 60_000);
    }
    tick();
    return () => window.clearTimeout(timer);
  }, [visible]);

  return <span className="island-idle-readout"><strong>{clockLabel.format(now)}</strong><span>{dateLabel.format(now)}</span></span>;
}

function Weather({ city, live }: { city: WeatherCity | null; live: boolean }) {
  const [reading, setReading] = useState(live ? latestReading : null);

  useEffect(() => {
    if (!live || !city) return;
    const location = city;
    const controller = new AbortController();
    let timer: number;

    async function refresh() {
      let delay = weatherInterval;
      try {
        const degrees = await currentTemperature(location, controller.signal);
        if (controller.signal.aborted) return;
        latestReading = { cityId: location.id, degrees, updatedAt: Date.now() };
        setReading(latestReading);
      } catch {
        if (controller.signal.aborted) return;
        delay = 60_000;
        setReading((previous) => previous && Date.now() - previous.updatedAt < 3 * weatherInterval ? previous : null);
      }
      timer = window.setTimeout(refresh, delay);
    }

    if (latestReading?.cityId === location.id && Date.now() - latestReading.updatedAt < weatherInterval) {
      setReading(latestReading);
      timer = window.setTimeout(refresh, weatherInterval - (Date.now() - latestReading.updatedAt));
    } else {
      void refresh();
    }
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [city, live]);

  const degrees = live && reading?.cityId === city?.id ? reading?.degrees : undefined;
  return <span className="island-idle-readout"><strong>{degrees === undefined ? "—" : `${degrees}°C`}</strong><span title={city?.label}>{city?.name ?? "Choose a city"}</span></span>;
}

export default function IslandIdle({ settings, sample, live, visible }: {
  settings: IslandSettings;
  sample: SystemSample | null;
  live: boolean;
  visible: boolean;
}) {
  if (settings.idleDisplay === "clock") return <Clock visible={visible} />;
  if (settings.idleDisplay === "weather") return <Weather city={settings.weatherCity} live={live && visible} />;

  return (
    <span className="island-idle-metrics">
      <span><span>CPU</span><strong>{percent(sample?.cpu)}</strong></span>
      <span><span>GPU</span><strong>{percent(sample?.gpu)}</strong></span>
      <span><span>RAM</span><strong>{percent(sample?.ram)}</strong></span>
    </span>
  );
}
