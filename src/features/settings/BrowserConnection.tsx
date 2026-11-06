import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Status = { connected: boolean; error: string | null; extensionPath: string | null };

export default function BrowserConnection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const refresh = () => void invoke<Status>("get_browser_connection").then(value => {
      if (active) setStatus(value);
    }).catch(() => { if (active) setMessage("Could not read browser connection."); });
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return (
    <div className="settings-browser-connection">
      <div className="settings-field">
        <span className="settings-field-description">Browser extension<small>{status?.error ? "Connection unavailable" : status?.connected ? "Connected" : "Waiting for browser playback"}</small></span>
      </div>
      <p>The extension connects automatically and shows the video player directly. Screen and tab capture are not used.</p>
      <div className="settings-city-search">
        {(["edge", "chrome"] as const).map(browser => <button key={browser} className="settings-pin-button" type="button" onClick={() => {
          void invoke("prepare_browser_extension", { browser }).then(() => setMessage("Extension folder opened. Enable Developer mode, choose Load unpacked, then select this folder. No connection code is needed.")).catch(error => setMessage(String(error)));
        }}>Set up {browser === "edge" ? "Edge" : "Chrome"}</button>)}
      </div>
      {status?.extensionPath && <p className="settings-extension-path">{status.extensionPath}</p>}
      <p>The development version uses Load unpacked. Store installation will be available after the extension is published.</p>
      {(status?.error || message) && <p role="status">{status?.error || message}</p>}
    </div>
  );
}
