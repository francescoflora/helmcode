import { createRoot } from "react-dom/client";

import App from "./App";
import { getResolvedTheme, startAppearance, subscribeTheme } from "./lib/appearance";
import { isTauri } from "./lib/tauri";
import { setNativeTheme } from "./lib/window";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

startAppearance();
if (isTauri()) {
  const syncNativeTheme = (theme: "dark" | "light") => {
    void setNativeTheme(theme);
  };
  syncNativeTheme(getResolvedTheme());
  subscribeTheme(syncNativeTheme);
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Elemento #root non trovato");
}

createRoot(container).render(<App />);
