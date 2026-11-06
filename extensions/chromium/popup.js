const status = document.querySelector("#status");
const videoStatus = document.querySelector("#video-status");

async function connection() {
  status.textContent = "Connecting…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "connect" });
    status.textContent = result.error || (result.connected ? "Connected automatically" : "Open the Dynamic Island app to connect.");
  } catch { status.textContent = "Open the app once, then select Reconnect."; }
}

document.querySelector("#connect").addEventListener("click", connection);
document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  status.textContent = "Disconnected";
  videoStatus.textContent = "Not sharing";
});
document.querySelector("#retry-video").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  videoStatus.textContent = "Reconnecting video…";
  try {
    await chrome.runtime.sendMessage({ type: "retry-video" });
    videoStatus.textContent = "Video will appear automatically when the site permits access.";
  } catch (error) { videoStatus.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector("#auto-video").addEventListener("change", async event => {
  const enabled = event.currentTarget.checked;
  await chrome.runtime.sendMessage({ type: "video-enabled", enabled });
  videoStatus.textContent = enabled ? "Automatic video enabled" : "Video disabled";
});
chrome.storage.session.get(["connection", "video"]).then(data => {
  status.textContent = data.connection || "Waiting for app";
  videoStatus.textContent = data.video || "Not sharing";
});
chrome.storage.local.get(["enabled", "videoEnabled"]).then(data => {
  document.querySelector("#auto-video").checked = data.videoEnabled !== false;
  if (data.enabled !== false) void connection();
});
