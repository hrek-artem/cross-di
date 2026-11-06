import type { WeatherCity } from "./preferences";

async function weatherJson<T>(url: URL, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = window.setTimeout(abort, 8000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Weather service unavailable.");
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

type GeocodingResult = {
  id: number;
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
};

export async function searchWeatherCities(query: string, signal: AbortSignal): Promise<WeatherCity[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: query, count: "6", language: "en", format: "json" }).toString();
  const data = await weatherJson<{ results?: GeocodingResult[] }>(url, signal);

  return (Array.isArray(data.results) ? data.results : [])
    .filter((city) => Number.isSafeInteger(city.id) && city.id > 0 && typeof city.name === "string"
      && Number.isFinite(city.latitude) && Number.isFinite(city.longitude))
    .map(({ id, name, admin1, country, latitude, longitude }) => ({
      id, name, latitude, longitude,
      label: [...new Set([name, admin1, country].filter(Boolean))].join(", "),
    }));
}

export async function currentTemperature(city: WeatherCity, signal: AbortSignal): Promise<number> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(city.latitude), longitude: String(city.longitude),
    current: "temperature_2m", temperature_unit: "celsius", forecast_days: "1",
  }).toString();
  const data = await weatherJson<{ current?: { temperature_2m?: number } }>(url, signal);
  const value = data.current?.temperature_2m;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Temperature unavailable.");
  return Math.round(value);
}
