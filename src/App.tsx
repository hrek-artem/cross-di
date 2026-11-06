import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Island from "./features/island/Island";
import Settings from "./features/settings/Settings";

export default function App() {
  if (isTauri() && getCurrentWindow().label === "settings") {
    return <Settings />;
  }

  return <Island />;
}
