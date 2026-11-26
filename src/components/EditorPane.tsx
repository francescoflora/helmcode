import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { indentLess, indentMore } from "@codemirror/commands";
import { hasNextSnippetField, hasPrevSnippetField, nextSnippetField, prevSnippetField } from "@codemirror/autocomplete";
import { getIndentUnit, indentString, indentUnit } from "@codemirror/language";
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type StateCommand } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { useEffect, useRef, useState } from "react";

import { helmcodeTheme } from "../theme";
import { detectIndentUnit, getLanguageDescription, languageName } from "../lib/languages";
import { externalTextChange, externalTextTransaction } from "../lib/editorChanges";
import { wordHighlightExtension } from "../lib/editorHighlights";
import { intelligenceExtension, installLanguageServer, navigateSymbol, syncIntelligence, type IntelligenceStatus, type NavigationKind, type NavigationTarget } from "../lib/intelligence";
import { isTauri, onLspInstallProgress } from "../lib/tauri";
import type { LspDiagnostic, LspPosition, RevealRequest, Tab } from "../types";
import { BrandMark } from "./BrandMark";
import { BrandWordmark } from "./BrandWordmark";
import { FileTypeIcon } from "./FileTypeIcon";
import { XIcon } from "./Icons";

const symbolHover = StateEffect.define<{ from: number; to: number } | null>();
const symbolLinks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects) {
      if (effect.is(symbolHover)) value = effect.value
        ? Decoration.set([Decoration.mark({ class: "cm-symbol-link" }).range(effect.value.from, effect.value.to)])
        : Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const toEditorCommand = (command: StateCommand) => (view: EditorView) =>
  command({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) });
const indentSelection = toEditorCommand(indentMore);
const unindentSelection = toEditorCommand(indentLess);

const insertIndent = (view: EditorView) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentSelection(view);
  view.dispatch(view.state.replaceSelection(indentString(view.state, getIndentUnit(view.state))));
  return true;
};

const navigationActions: { kind: NavigationKind; label: string; shortcut: string }[] = [
  { kind: "definition", label: "Vai alla definizione", shortcut: "F12" },
  { kind: "declaration", label: "Vai alla dichiarazione", shortcut: "Ctrl Shift F12" },
  { kind: "implementation", label: "Vai all’implementazione", shortcut: "Ctrl F12" },
];

type Props = {
  workspace: string;
  locked?: boolean;
  tab: Tab | null;
  diagnostics: LspDiagnostic[];
  reveal: RevealRequest | null;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onNavigate: (target: NavigationTarget) => Promise<void>;
  onScroller?: (element: HTMLElement | null) => void;
};

export function EditorPane({ workspace, tab, diagnostics, reveal, onChange, onSave, onNavigate, onScroller, locked = false }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editabilityRef = useRef<Compartment | null>(null);
  const editorContentRef = useRef<string | null>(null);
  const lastRevealRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onNavigateRef = useRef(onNavigate);
  const onScrollerRef = useRef(onScroller);
  const navigateRef = useRef<(kind: NavigationKind, offset?: number) => void>(() => undefined);
  const navigationRequest = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<IntelligenceStatus | null>(null);
  const [retry, setRetry] = useState(0);
  const [statusDetails, setStatusDetails] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState("");
  const [installError, setInstallError] = useState("");
  const [navigationMessage, setNavigationMessage] = useState("");
  const [targets, setTargets] = useState<NavigationTarget[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; offset: number } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onNavigateRef.current = onNavigate;
  onScrollerRef.current = onScroller;

  navigateRef.current = (kind, offset) => {
    const view = viewRef.current;
    if (!view || !tab || tab.external || locked) return;
    const position = Math.min(Math.max(offset ?? view.state.selection.main.head, 0), view.state.doc.length);
    const line = view.state.doc.lineAt(position);
    const snapshot = view.state.doc;
    const request = ++navigationRequest.current;
    setMenu(null);
    setTargets([]);
    setNavigationMessage("Ricerca del simbolo…");
    void navigateSymbol(workspace, tab.path, snapshot.toString(), { line: line.number - 1, character: position - line.from }, kind).then((locations) => {
      if (navigationRequest.current !== request || viewRef.current !== view || view.state.doc !== snapshot) return;
      if (locations.length === 1) {
        setNavigationMessage("");
        void onNavigateRef.current(locations[0]);
      } else if (locations.length) {
        setNavigationMessage("");
        setTargets(locations);
      } else {
        setNavigationMessage("Nessuna destinazione trovata per questo simbolo.");
      }
    }).catch((error: unknown) => {
      if (navigationRequest.current === request && viewRef.current === view && view.state.doc === snapshot) setNavigationMessage(String(error));
    });
  };

  useEffect(() => {
    setStatus(null);
    setStatusDetails(false);
    setInstallError("");
    setNavigationMessage("");
    setTargets([]);
    setMenu(null);
    ++navigationRequest.current;
  }, [workspace, tab?.path]);

  useEffect(() => {
    if (!installing || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const expectedId = status?.installable?.id;
    void onLspInstallProgress((payload) => {
      if (disposed || (expectedId && payload.serverId !== expectedId)) return;
      setInstallProgress(payload.message);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [installing, status?.installable?.id]);

  const handleInstallServer = () => {
    const target = status?.installable;
    if (!target || installing) return;
    setInstalling(true);
    setInstallError("");
    setInstallProgress(`Installazione di ${target.label}…`);
    setNavigationMessage("");
    void installLanguageServer(target.id).then((message) => {
      if (!mountedRef.current) return;
      setInstalling(false);
      setInstallProgress("");
      setStatusDetails(false);
      setNavigationMessage(`${message}. Avvio del language server…`);
      setStatus(null);
      setRetry((value) => value + 1);
    }).catch((error: unknown) => {
      if (!mountedRef.current) return;
      setInstalling(false);
      setInstallProgress("");
      setInstallError(String(error));
      setStatusDetails(true);
    });
  };

  useEffect(() => {
    if (!tab || tab.external || locked) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void syncIntelligence(workspace, tab.path, tab.content).then((result) => {
        if (!disposed) setStatus(result);
      }).catch((error: unknown) => {
        if (!disposed) setStatus({ language: languageName(tab.path), state: "error", message: String(error) });
      });
    }, 250);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [workspace, tab?.path, tab?.content, tab?.revision, retry, locked]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = editabilityRef.current;
    if (locked) {
      ++navigationRequest.current;
      setTargets([]);
      setMenu(null);
      setNavigationMessage("");
    }
    if (view && compartment) view.dispatch({ effects: compartment.reconfigure([
      EditorState.readOnly.of(Boolean(tab?.external || locked)), EditorView.editable.of(!tab?.external && !locked),
    ]) });
  }, [locked, tab?.path, tab?.revision, tab?.external]);

  useEffect(() => {
    if (!menu && !targets.length && !statusDetails) return;
    const previous = document.activeElement;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        setTargets([]);
        setStatusDetails(false);
        viewRef.current?.focus();
      }
    };
    const outside = (event: globalThis.MouseEvent) => {
      if ((event.target as Element).closest?.(".intelligence-status")) return;
      if (!panelRef.current?.contains(event.target as Node)) {
        setMenu(null);
        setTargets([]);
        setStatusDetails(false);
      }
    };
    window.addEventListener("keydown", dismiss, true);
    // Capture avoids dismissing a fast response during the initiating click's bubbling phase.
    window.addEventListener("mousedown", outside, true);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("mousedown", outside, true);
      if (previous instanceof HTMLElement && previous.isConnected && panelRef.current?.contains(document.activeElement)) previous.focus();
    };
  }, [menu, targets, statusDetails]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tab) return;
    let disposed = false;
    const language = getLanguageDescription(tab.path);
    const languageCompartment = new Compartment();
    const editability = new Compartment();
    const colorScheme = new Compartment();
    editabilityRef.current = editability;

    const extensions: Extension[] = [
      basicSetup,
      indentUnit.of(detectIndentUnit(tab.content)),
      indentationMarkers({
        highlightActiveBlock: true,
        hideFirstIndent: false,
        markerType: "fullScope",
        thickness: 1,
        activeThickness: 1,
        colors: {
          light: "var(--editor-indent-guide)",
          dark: "var(--editor-indent-guide)",
          activeLight: "var(--editor-indent-guide-active)",
          activeDark: "var(--editor-indent-guide-active)",
        },
      }),
      wordHighlightExtension,
      helmcodeTheme,
      colorScheme.of(EditorView.darkTheme.of(document.documentElement.dataset.theme !== "light")),
      lintGutter(),
      symbolLinks,
      editability.of([EditorState.readOnly.of(Boolean(tab.external || locked)), EditorView.editable.of(!tab.external && !locked)]),
      tab.external ? [] : intelligenceExtension({ workspace, path: tab.path, onStatus: (value) => { if (!disposed) setStatus(value); } }),
      languageCompartment.of(language?.support ?? []),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto" },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          ++navigationRequest.current;
          setNavigationMessage("");
          setTargets([]);
          setMenu(null);
          if (!update.transactions.some((transaction) => transaction.annotation(externalTextChange))) {
            const content = update.state.doc.toString();
            editorContentRef.current = content;
            onChangeRef.current(tab.path, content);
          }
        }
      }),
      Prec.high(keymap.of([
        { key: "Tab", run: (view) => hasNextSnippetField(view.state) ? nextSnippetField(view) : false },
        { key: "Shift-Tab", run: (view) => hasPrevSnippetField(view.state) ? prevSnippetField(view) : false },
        { key: "Tab", run: insertIndent, shift: unindentSelection, preventDefault: true },
        { key: "F12", preventDefault: true, run: () => { navigateRef.current("definition"); return true; } },
        { key: "Mod-F12", preventDefault: true, run: () => { navigateRef.current("implementation"); return true; } },
        { key: "Mod-Shift-F12", preventDefault: true, run: () => { navigateRef.current("declaration"); return true; } },
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current(tab.path);
            return true;
          },
        },
      ])),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey || tab.external) return false;
          const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null || !view.state.wordAt(offset)) return false;
          event.preventDefault();
          view.dispatch({ selection: { anchor: offset }, effects: symbolHover.of(null) });
          view.focus();
          navigateRef.current(event.shiftKey ? "implementation" : "auto", offset);
          return true;
        },
        mousemove(event, view) {
          const offset = event.ctrlKey || event.metaKey ? view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
          const word = offset !== null && !tab.external ? view.state.wordAt(offset) : null;
          const existing = view.state.field(symbolLinks);
          if (word && existing.size === 1) {
            const current = existing.iter();
            if (current.from === word.from && current.to === word.to) return false;
          } else if (!word && !existing.size) return false;
          view.dispatch({ effects: symbolHover.of(word ? { from: word.from, to: word.to } : null) });
          return false;
        },
        mouseleave(_event, view) { view.dispatch({ effects: symbolHover.of(null) }); },
        keyup(event, view) { if (!event.ctrlKey && !event.metaKey) view.dispatch({ effects: symbolHover.of(null) }); },
        blur(_event, view) { view.dispatch({ effects: symbolHover.of(null) }); },
        contextmenu(event, view) {
          if (tab.external) return false;
          const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null || !view.state.wordAt(offset)) return false;
          event.preventDefault();
          setTargets([]);
          setStatusDetails(false);
          setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 310)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 140)), offset });
          return true;
        },
      }),
    ];

    const state = EditorState.create({
      doc: tab.content,
      extensions,
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    editorContentRef.current = tab.content;
    const updateTheme = () => {
      if (disposed) return;
      view.dispatch({ effects: colorScheme.reconfigure(EditorView.darkTheme.of(document.documentElement.dataset.theme !== "light")) });
      view.requestMeasure();
    };
    window.addEventListener("helmcode-theme-changed", updateTheme);
    onScrollerRef.current?.(view.scrollDOM);
    host.dataset.language = language?.support ? language.name : "Testo semplice";

    if (language && !language.support) {
      void language.load().then((support) => {
        if (disposed || viewRef.current !== view) return;
        // Reconfigure only the parser: edits, selection and undo history stay intact.
        view.dispatch({ effects: languageCompartment.reconfigure(support) });
        host.dataset.language = language.name;
      }).catch((error: unknown) => {
        if (!disposed) console.warn(`Sintassi non disponibile per ${language.name}`, error);
      });
    }

    return () => {
      disposed = true;
      ++navigationRequest.current;
      window.removeEventListener("helmcode-theme-changed", updateTheme);
      view.destroy();
      viewRef.current = null;
      editabilityRef.current = null;
      onScrollerRef.current?.(null);
    };
  }, [workspace, tab?.path, tab?.revision, tab?.external]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !tab || editorContentRef.current === tab.content) return;
    const transaction = externalTextTransaction(view.state.doc, tab.content);
    if (transaction) view.dispatch(transaction);
    editorContentRef.current = tab.content;
  }, [tab?.content, tab?.path, tab?.revision]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const mapped = diagnostics.map((diagnostic) => toCmDiagnostic(view.state, diagnostic));
    view.dispatch(setDiagnostics(view.state, mapped));
  }, [diagnostics, tab?.path, tab?.revision]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !tab || !reveal) return;
    if (reveal.path !== tab.path || reveal.nonce === lastRevealRef.current) return;
    lastRevealRef.current = reveal.nonce;

    const lineNumber = Math.min(Math.max(reveal.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const anchor = Math.min(line.from + Math.max(reveal.column - 1, 0), line.to);
    view.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
  }, [reveal, tab?.path, tab?.revision]);

  if (!tab) {
    return (
      <div className="editor-welcome">
        <BrandMark className="mb-5 h-16 w-16" />
        <BrandWordmark className="brand-welcome" />
        <h1 className="text-xl font-medium tracking-tight text-[var(--text)]">Spazio al tuo codice.</h1>
        <p className="mt-3 max-w-[360px] text-[13px] leading-6 text-[var(--muted)]">Apri un file dal progetto per iniziare. Ritrovi modifiche, branch e build nella barra laterale.</p>
      </div>
    );
  }

  const statusText = tab.external ? "Dipendenza · sola lettura" : !status ? "Avvio suggerimenti…"
    : status.state === "ready" ? `${status.language} · suggerimenti attivi` : `${status.language || languageName(tab.path)} · suggerimenti locali`;

  return (
    <div className="editor-intelligence">
      <div ref={hostRef} data-language-detected={languageName(tab.path)} className="editor-code-host" />
      <div className="intelligence-bar">
        <button type="button" className="intelligence-status" data-state={tab.external ? "external" : status?.state ?? "starting"} title={status?.message ?? "Autocompletamento: Ctrl+Spazio · Ctrl+clic: definizione o implementazione in base al simbolo"} aria-expanded={statusDetails} onClick={() => { setMenu(null); setTargets([]); setStatusDetails((value) => !value); }}>{statusText}</button>
        {!tab.external && status?.state === "missing" && status.installable && (
          <button type="button" className="intelligence-install-inline" disabled={installing} title={`Installa ${status.installable.label} (${status.installable.requirement})`} onClick={handleInstallServer}>
            {installing ? "Installazione…" : `Installa ${status.server ?? "server"}`}
          </button>
        )}
        <span className="intelligence-message" role="status">{installProgress || navigationMessage}</span>
        {!tab.external && <span className="intelligence-shortcuts" title="Ctrl+clic: definizione o implementazione in base al punto cliccato · Ctrl+Spazio: suggerimenti · F12: definizione · Ctrl+F12: implementazione · Ctrl+Shift+F12: dichiarazione">Ctrl+clic: vai al simbolo</span>}
      </div>
      {statusDetails && <div ref={panelRef} className="intelligence-details" role="region" aria-label="Stato autocompletamento">
        <button type="button" className="icon-button intelligence-dismiss" aria-label="Chiudi stato autocompletamento" onClick={() => { setStatusDetails(false); viewRef.current?.focus(); }}><XIcon className="h-3.5 w-3.5" /></button>
        <strong>{statusText}</strong>
        <p>{tab.external ? "Questo file appartiene a una dipendenza ed è aperto in sola lettura." : status?.message ?? "Il language server analizza il progetto per suggerire simboli, metodi e classi."}</p>
        {!tab.external && <><p>Ctrl+Spazio apre i suggerimenti. Ctrl+clic su un utilizzo apre la definizione; sulla dichiarazione o sulla firma cerca le implementazioni. Se non trova implementazioni, cerca una dichiarazione diversa da quella corrente. F12 apre la definizione, Ctrl+F12 le implementazioni e Ctrl+Shift+F12 la dichiarazione. Le tre operazioni sono disponibili anche dal menu con clic destro.</p>
          {status?.state === "missing" && status.installable ? (
            <p>{status.installable.requirement}. Il server viene installato nella cartella locale di helmcode senza modificare il PATH di sistema.</p>
          ) : status?.state !== "ready" && (
            <p>Installa il server indicato e rendilo disponibile nel PATH. Per altri linguaggi o percorsi personalizzati usa <code>.helmcode/languages.json</code> (vedi README).</p>
          )}
          {installError && <p className="intelligence-error" role="alert">{installError}</p>}
          <div className="intelligence-actions">
            {status?.state === "missing" && status.installable && (
              <button type="button" className="intelligence-install-primary" disabled={installing} onClick={handleInstallServer}>
                {installing ? (installProgress || "Installazione in corso…") : `Installa ${status.installable.label}`}
              </button>
            )}
            <button type="button" className="ghost-button intelligence-retry" disabled={installing} onClick={() => { setInstallError(""); setStatus(null); setRetry((value) => value + 1); }}>Riprova collegamento</button>
          </div></>}
      </div>}
      {menu && <div ref={panelRef} className="symbol-menu" role="menu" aria-label="Navigazione simbolo" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}>{navigationActions.map((action) => <button key={action.kind} type="button" role="menuitem" onClick={() => navigateRef.current(action.kind, menu.offset)}><span>{action.label}</span><kbd>{action.shortcut}</kbd></button>)}</div>}
      {targets.length > 0 && <div ref={panelRef} className="symbol-targets" role="region" aria-label="Destinazioni del simbolo">
        <div className="symbol-targets-heading"><strong>{targets.length} destinazioni</strong><button type="button" className="icon-button" aria-label="Chiudi destinazioni" onClick={() => { setTargets([]); viewRef.current?.focus(); }}><XIcon className="h-3.5 w-3.5" /></button></div>
        <div className="symbol-targets-list">{targets.map((target) => {
          const displayPath = target.path.startsWith("jdt://") ? target.path.split(/[?#]/, 1)[0] : target.path;
          return <button type="button" key={`${target.path}:${target.line}:${target.column}`} title={displayPath} onClick={() => { setTargets([]); void onNavigateRef.current(target); }}><FileTypeIcon path={target.path} className="h-4 w-4 shrink-0" /><span>{displayPath}</span><small>{target.line}:{target.column}{target.external ? " · sola lettura" : ""}</small></button>;
        })}</div>
      </div>}
    </div>
  );
}

function offsetFor(state: EditorState, position: LspPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), state.doc.lines);
  const line = state.doc.line(lineNumber);
  return Math.min(line.from + Math.max(position.character, 0), line.to);
}

function toCmDiagnostic(state: EditorState, diagnostic: LspDiagnostic): Diagnostic {
  const from = offsetFor(state, diagnostic.range.start);
  const to = Math.max(from, offsetFor(state, diagnostic.range.end));
  const severityMap: Record<number, Diagnostic["severity"]> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
  };
  return {
    from,
    to,
    severity: severityMap[diagnostic.severity ?? 1] ?? "error",
    message: diagnostic.message,
    source: diagnostic.source,
  };
}
