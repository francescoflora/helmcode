import type { ITheme } from "@xterm/xterm";

const dark: ITheme = {
  background: "#1E1E1E",
  foreground: "#F0F0F0",
  cursor: "#F0F0F0",
  cursorAccent: "#1E1E1E",
  selectionBackground: "rgba(255, 255, 255, 0.10)",
  black: "#202020",
  red: "#E9929C",
  green: "#6CBE94",
  yellow: "#D9BD80",
  blue: "#82B6E8",
  magenta: "#B9A0DC",
  cyan: "#78C8C8",
  white: "#D4D4D4",
  brightBlack: "#969696",
  brightRed: "#F3B4BB",
  brightGreen: "#91D2AF",
  brightYellow: "#E7D39F",
  brightBlue: "#ADD0F2",
  brightMagenta: "#D2BCEB",
  brightCyan: "#A6DED7",
  brightWhite: "#FFFFFF",
};

const light: ITheme = {
  background: "#FFFFFF",
  foreground: "#242424",
  cursor: "#242424",
  cursorAccent: "#FFFFFF",
  selectionBackground: "rgba(0,0,0,.08)",
  black: "#262626",
  red: "#B13442",
  green: "#28704B",
  yellow: "#8A5A18",
  blue: "#2B64A4",
  magenta: "#80539B",
  cyan: "#1C7380",
  white: "#595959",
  brightBlack: "#666666",
  brightRed: "#B13B49",
  brightGreen: "#2F7950",
  brightYellow: "#8F641D",
  brightBlue: "#356EAF",
  brightMagenta: "#8A5AA2",
  brightCyan: "#247987",
  brightWhite: "#242424",
};

/** Return a fresh palette so xterm cannot share mutable theme state across sessions. */
export function getTerminalTheme(scheme: "light" | "dark"): ITheme {
  return { ...(scheme === "light" ? light : dark) };
}

/** Match the terminal surface to the active app tokens as well as its ANSI palette. */
export function currentTerminalTheme(): ITheme {
  const palette = getTerminalTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const styles = getComputedStyle(document.documentElement);
  palette.background = styles.getPropertyValue("--color-canvas").trim() || palette.background;
  palette.foreground = styles.getPropertyValue("--text").trim() || palette.foreground;
  palette.cursor = styles.getPropertyValue("--text").trim() || palette.cursor;
  palette.cursorAccent = palette.background;
  return palette;
}

export const terminalFont = '"Cascadia Code", "Consolas", ui-monospace, monospace';
