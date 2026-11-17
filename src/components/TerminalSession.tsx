import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { memo, useEffect, useRef, useState } from "react";

import { api } from "../lib/tauri";
import { onSessionData, onSessionExit } from "../lib/ptyEvents";
import { createTerminalTransport } from "../lib/terminalTransport";
import { currentTerminalTheme, terminalFont } from "../terminalTheme";
import type { TerminalTab } from "../types";
import { AgentLoading } from "./AgentLoading";

type Props = {
  tab: TerminalTab;
  active: boolean;
  onExit: (id: string) => void;
};

export const TerminalSession = memo(function TerminalSession({ tab, active, onExit }: Props) {
  const [loading, setLoading] = useState(tab.kind === "agent");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const applySizeRef = useRef<((focus: boolean) => boolean) | null>(null);
  const onExitRef = useRef(onExit);
  const activeRef = useRef(active);
  activeRef.current = active;
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: currentTerminalTheme(),
      fontFamily: terminalFont,
      fontSize: 14,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
    } catch {
      /* fallback Unicode di default di xterm */
    }

    term.open(host);
    // xterm turns Ctrl+V into ^V and cancels the browser event; let the native
    // paste reach its hidden textarea instead, exactly like the right-click paste.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && !event.altKey && !event.metaKey && event.code === "KeyV") return false;
      return true;
    });
    // Update only the renderer palette. Keep the PTY, scrollback and input focus intact.
    const updateTheme = () => { term.options.theme = currentTerminalTheme(); };
    window.addEventListener("helmcode-theme-changed", updateTheme);
    const transport = createTerminalTransport(
      (data) => api.ptyWrite(tab.id, data),
      (rows, cols) => api.ptyResize(tab.id, rows, cols),
    );

    let webgl: WebglAddon | null = null;
    const releaseWebgl = () => {
      if (!webgl) return;
      const addon = webgl;
      webgl = null;
      try {
        addon.dispose();
      } catch {
        /* noop */
      }
    };

    const loadWebgl = () => {
      if (webgl || !host) return;
      if (typeof WebGL2RenderingContext === "undefined") return;
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      let addon: WebglAddon;
      try {
        addon = new WebglAddon();
      } catch {
        return;
      }
      webgl = addon;
      addon.onContextLoss(() => {
        if (webgl !== addon) return;
        webgl = null;
        try {
          addon.dispose();
        } catch {
          /* noop */
        }
      });
      try {
        term.loadAddon(addon);
      } catch {
        releaseWebgl();
      }
    };

    let disposed = false;
    let exited = false;
    let waitingForOutput = tab.kind === "agent";
    setLoading(waitingForOutput);

    // ConPTY sends setup/ANSI sequences before the agent draws any interface.
    // Wait for parsed, visible content rather than the creation of the process.
    const readySubscription = term.onWriteParsed(() => {
      if (disposed || !waitingForOutput) return;
      const buffer = term.buffer.active;
      for (let row = 0; row < term.rows; row++) {
        if (buffer.getLine(buffer.baseY + row)?.translateToString(true).trim()) {
          waitingForOutput = false;
          setLoading(false);
          if (activeRef.current) term.focus();
          break;
        }
      }
    });

    const applySize = (focus: boolean) => {
      if (disposed) return false;
      if (host.clientWidth < 20 || host.clientHeight < 20) return false;
      try {
        fit.fit();
        transport.resize(term.rows, term.cols);
        if (focus && activeRef.current && !waitingForOutput) term.focus();
        return true;
      } catch {
        return false;
      }
    };
    applySizeRef.current = applySize;

    if (!applySize(false)) {
      try {
        term.resize(120, 30);
      } catch {
        /* xterm verrà ridimensionato quando il pannello sarà visibile */
      }
    }
    loadWebgl();

    const dataSubscription = term.onData((data) => {
      if (disposed) return;
      transport.write(data);
    });
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        applySize(false);
        loadWebgl();
      });
    });
    observer.observe(host);

    let dprMedia: MediaQueryList | null = null;
    const handleDprChange = () => {
      applySize(false);
      loadWebgl();
      try {
        term.clearTextureAtlas();
      } catch {
        /* noop */
      }
      term.refresh(0, term.rows - 1);
      watchDpr();
    };
    const watchDpr = () => {
      if (dprMedia) {
        dprMedia.removeEventListener("change", handleDprChange);
      }
      dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMedia.addEventListener("change", handleDprChange);
    };
    watchDpr();

    const unlisteners: Array<() => void> = [];
    const timers: number[] = [];
    const releaseEvents = () => unlisteners.splice(0).forEach((unlisten) => unlisten());

    void (async () => {
      try {
        const dataListener = await onSessionData(tab.id, (payload) => {
          if (disposed || exited) return;
          term.write(new Uint8Array(payload.data));
        });
        if (disposed) { dataListener(); return; }
        unlisteners.push(dataListener);
        const exitListener = await onSessionExit(tab.id, () => {
          if (disposed || exited) return;
          exited = true;
          transport.dispose();
          waitingForOutput = false;
          setLoading(false);
          term.write("\r\n\x1b[38;5;244m[processo terminato]\x1b[0m\r\n");
          releaseEvents();
          onExitRef.current(tab.id);
        });
        if (disposed || exited) {
          exitListener();
          return;
        }
        unlisteners.push(exitListener);

        const rows = term.rows;
        const cols = term.cols;
        await api.ptyCreate(tab.id, rows, cols, tab.agent ?? null);
        if (disposed) {
          void api.ptyClose(tab.id).catch(() => undefined);
          return;
        }
        if (exited) return;
        transport.start(rows, cols);

        const delay = 100;
        timers.push(
          window.setTimeout(() => {
            if (disposed) return;
            if (tab.kind === "task" && tab.command) {
              transport.write(`\r${tab.command}\r`);
            } else if (tab.kind === "shell") {
              transport.write(" \b");
            }
          }, delay),
        );

        if (activeRef.current) {
          timers.push(window.setTimeout(() => applySize(true), 80));
        }
      } catch (error) {
        transport.dispose();
        releaseEvents();
        if (!disposed) {
          exited = true;
          waitingForOutput = false;
          setLoading(false);
          term.write(`\r\n\x1b[31m[errore terminale: ${String(error)}]\x1b[0m\r\n`);
          onExitRef.current(tab.id);
        }
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("helmcode-theme-changed", updateTheme);
      transport.dispose();
      timers.forEach((timer) => window.clearTimeout(timer));
      releaseEvents();
      dataSubscription.dispose();
      readySubscription.dispose();
      observer.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      dprMedia?.removeEventListener("change", handleDprChange);
      releaseWebgl();
      void api.ptyClose(tab.id).catch(() => undefined);
      term.dispose();
      applySizeRef.current = null;
    };
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      applySizeRef.current?.(true);
    }, 70);
    return () => window.clearTimeout(timer);
  }, [active, tab.id, loading]);

  return (
    <div className="terminal-session" aria-busy={loading}>
      <div ref={hostRef} className="h-full w-full overflow-hidden px-4 py-3" aria-hidden={loading || undefined} inert={loading} />
      {loading && <AgentLoading />}
    </div>
  );
});
