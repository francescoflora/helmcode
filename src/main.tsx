import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { getResolvedTheme, startAppearance, subscribeTheme } from "./lib/appearance";
import { isTauri } from "./lib/tauri";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

startAppearance();
if (isTauri()) {
  const setNativeTheme = (theme: "dark" | "light") => {
    void getCurrentWindow().setTheme(theme).catch(() => undefined);
  };
  setNativeTheme(getResolvedTheme());
  subscribeTheme(setNativeTheme);
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Elemento #root non trovato");
}

createRoot(container).render(<App />);
