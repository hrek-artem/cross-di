import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IdleDisplay, SettingsEditorProps, WeatherCity } from "../../island/preferences";
import { searchWeatherCities } from "../../island/weather";

function CityPicker({ city, onSelect, disabled }: {
  city: WeatherCity | null;
  onSelect: (city: WeatherCity) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherCity[]>([]);
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = query.trim();
    if (name.length < 2) return;

    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResults([]);
    setStatus("Searching…");
    try {
      const cities = await searchWeatherCities(name, controller.signal);
      if (controller.signal.aborted) return;
      setResults(cities);
      setStatus(cities.length ? "" : "No matching cities.");
    } catch {
      if (!controller.signal.aborted) setStatus("Could not search cities. Try again.");
    }
  }

  return (
    <div className="settings-city-picker">
      <form className="settings-city-search" onSubmit={(event) => void search(event)}>
        <input type="search" aria-label="City name" placeholder="Search for a city" value={query} maxLength={80} disabled={disabled} onChange={(event) => {
          request.current?.abort();
          setQuery(event.currentTarget.value);
          setResults([]);
          setStatus("");
        }} />
        <button className="settings-pin-button" type="submit" disabled={disabled || query.trim().length < 2}>Search</button>
      </form>
      {status && <p role="status">{status}</p>}
      {results.length > 0 && (
        <ul className="settings-city-results">
          {results.map((result) => (
            <li key={result.id}>
              <button className="settings-pin-button" type="button" disabled={disabled} onClick={() => {
                onSelect(result);
                setResults([]);
              }}>{result.label}</button>
            </li>
          ))}
        </ul>
      )}
      {city && <p>Selected city: {city.label}</p>}
      <p className="settings-weather-credit">Weather data by Open-Meteo (CC BY 4.0).</p>
    </div>
  );
}

export default function Idle({ settings, onChange, disabled }: SettingsEditorProps) {
  return (
    <div className="settings-glass settings-card">
      <h2>Idle display</h2>
      <p>Choose what the compact island shows when there is no media session.</p>
      <fieldset className="settings-fields" disabled={disabled} aria-label="Idle display">
        <label className="settings-field">
          <span>Show when idle</span>
          <select value={settings.idleDisplay} onChange={(event) => onChange({ idleDisplay: event.currentTarget.value as IdleDisplay })}>
            <option value="system">CPU, GPU &amp; RAM</option>
            <option value="clock">Local time</option>
            <option value="weather">City temperature</option>
          </select>
        </label>
      </fieldset>
      {settings.idleDisplay === "weather" && <CityPicker city={settings.weatherCity} disabled={disabled} onSelect={(weatherCity) => onChange({ weatherCity })} />}
    </div>
  );
}
