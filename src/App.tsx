import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ActivityBar } from "./components/ActivityBar";
import { AgentLoading } from "./components/AgentLoading";
import { AboutModal } from "./components/AboutModal";
import { BranchPicker } from "./components/BranchPicker";
import { BuildPanel as BuildPanelComponent } from "./components/BuildPanel";
import { FileExplorer as FileExplorerComponent } from "./components/FileExplorer";
import { FileTypeIcon } from "./components/FileTypeIcon";
import { GitPanel as GitPanelComponent } from "./components/GitPanel";
import { GitDiff } from "./components/GitDiff";
import { GitHistory as GitHistoryComponent } from "./components/GitHistory";
import { CloudDownIcon, CloudUpIcon, GitBranchIcon, RefreshIcon, StatusBranchIcon, StatusErrorIcon, StatusSyncIcon, StatusWarningIcon, SyncIcon, XIcon } from "./components/Icons";
import { NewProjectModal } from "./components/NewProjectModal";
import { OpenInWindowModal } from "./components/OpenInWindowModal";
import { SearchPanel as SearchPanelComponent } from "./components/SearchPanel";
import { SettingsModal } from "./components/SettingsModal";
import { SidebarHeader } from "./components/SidebarHeader";
import { SplashScreen } from "./components/SplashScreen";
import { StartScreen } from "./components/StartScreen";
import { TitleBar } from "./components/TitleBar";
import { TerminalPanel as TerminalPanelComponent } from "./components/TerminalPanel";
import { WindowResizeHandles } from "./components/WindowResizeHandles";
import { readStored, writeStored } from "./lib/storage";
import { agentLabel } from "./lib/agents";
import type { BuildDiagnostic } from "./lib/build";
import { addRecent, listRecents } from "./lib/recents";
import { loadPrefs, resetPrefs, savePref, type Prefs } from "./lib/prefs";
import { applyTheme, subscribeTheme } from "./lib/appearance";
import { api, isTauri, onDiagnostics, onFsChanged, onWorkspaceChanged } from "./lib/tauri";
import { closeIntelligence, readNavigationTarget, saveIntelligence, suspendIntelligence, syncIntelligence, type NavigationTarget } from "./lib/intelligence";
import { applyMutationToTabs, movedPath, pathContains } from "./lib/fileOperations";
import { useSyncedScroll } from "./lib/syncScroll";
import { createCoalescedRequest } from "./lib/coalescedRequest";
import { applyDiskRefresh, sameGitStatus } from "./lib/workspaceRefresh";
import { applyAppWindowSize, applyStartWindowSize, setWindowTitle, showWindow, useWindowMaximized, useWorkspaceWindowSize } from "./lib/window";
import { APP_NAME } from "./lib/appinfo";
import type { ActivityView, FileOperation, GitStatus, LspDiagnostic, ReplaceRequest, ReplaceResult, RevealRequest, Tab, TerminalTab, WorkspaceMode, WorkspaceMutation } from "./types";
import { basename, makeTab } from "./types";

const EMPTY_GIT: GitStatus = { isRepo: false, branch: "", changes: [], upstream: null, ahead: 0, behind: 0, merging: false, cherryPicking: false };
type PendingOpen =
  | { kind: "recent"; path: string; name: string }
  | { kind: "create"; parent: string; name: string };
const EditorPane = lazy(() => import("./components/EditorPane").then((module) => ({ default: module.EditorPane })));
const TerminalSession = lazy(() => import("./components/TerminalSession").then((module) => ({ default: module.TerminalSession })));
const normalPath = (path: string) => path.replace(/\\/g, "/");
const AUTOSAVE_DELAY = 500;
const BuildPanel = memo(BuildPanelComponent);
const SearchPanel = memo(SearchPanelComponent);
const GitPanel = memo(GitPanelComponent);
const GitHistory = memo(GitHistoryComponent);
const TerminalPanel = memo(TerminalPanelComponent);
// Typing changes the tab text, but usually leaves Explorer's modified paths unchanged.
const FileExplorer = memo(FileExplorerComponent, (previous, next) =>
  previous.workspace === next.workspace && previous.version === next.version
  && previous.activePath === next.activePath && previous.createRequest === next.createRequest
  && previous.onOpen === next.onOpen && previous.onCreated === next.onCreated && previous.onMutate === next.onMutate
  && previous.revealRequest === next.revealRequest
  && previous.modified.size === next.modified.size && [...previous.modified].every((path) => next.modified.has(path)));
const EMPTY_DIAGNOSTICS: LspDiagnostic[] = [];

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  // Wait for launch intent so menu windows never mount the splash.
  const [showSplash, setShowSplash] = useState<boolean | null>(() => prefs.showSplash ? null : false);
  const [appReady, setAppReady] = useState(false);
  const [showProjects, setShowProjects] = useState(true);
  // Tauri creates the window at the Projects size and position before showing it.
  const windowScreen = useRef<"projects" | "workspace">("projects");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const initialPrefs = useRef(prefs);
  const [workspace, setWorkspace] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, LspDiagnostic[]>>({});
  const [buildDiagnostics, setBuildDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [mutatingFiles, setMutatingFiles] = useState(false);
  const fileMutationRef = useRef<string | null>(null);
  const deferredFsChanges = useRef(new Set<string>());
  const [explorerVersion, setExplorerVersion] = useState(0);
  const [gitVersion, setGitVersion] = useState(0);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [git, setGit] = useState<GitStatus>(EMPTY_GIT);
  const [fetchingGit, setFetchingGit] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [problemsRequest, setProblemsRequest] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>(() => prefs.startMode);
  const [ideOpened, setIdeOpened] = useState(mode === "ide");
  const [activeView, setActiveView] = useState<ActivityView>(() => {
    const stored = readStored<string>("helmcode.view", "explorer");
    return stored === "search" || stored === "git" || stored === "build" ? stored : "explorer";
  });
  const [showHistory, setShowHistory] = useState(activeView === "git");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStored<boolean>("helmcode.sidebar.collapsed", false));
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = readStored<number>("helmcode.sidebar.width", 224);
    return Math.min(360, Math.max(180, stored === 292 ? 224 : stored || 224));
  });
  const [session, setSession] = useState<TerminalTab | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [newTerminalRequest, setNewTerminalRequest] = useState(0);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [explorerCreateRequest, setExplorerCreateRequest] = useState<{ id: number; kind: "file" | "folder" }>({ id: 0, kind: "file" });
  const [explorerReveal, setExplorerReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [searchFocus, setSearchFocus] = useState({ nonce: 0, replace: false });
  const [editorScroller, setEditorScroller] = useState<HTMLElement | null>(null);
  const [diffScroller, setDiffScroller] = useState<HTMLElement | null>(null);
  const maximized = useWindowMaximized();
  useWorkspaceWindowSize(appReady && showSplash === false && !showProjects && Boolean(workspace));
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const diffPathRef = useRef(diffPath);
  const workspaceRef = useRef(workspace);
  const activeViewRef = useRef(activeView);
  tabsRef.current = tabs;
  activePathRef.current = activePath;
  diffPathRef.current = diffPath;
  workspaceRef.current = workspace;
  activeViewRef.current = activeView;
  const revealNonce = useRef(0);
  const explorerRevealNonce = useRef(0);
  const gitRequest = useRef(0);
  const gitRefresh = useRef<ReturnType<typeof createCoalescedRequest> | null>(null);
  const fileRefreshes = useRef(new Map<string, ReturnType<typeof createCoalescedRequest>>());
  const autosaveTimers = useRef(new Map<string, number>());
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const comparedPath = activeTab?.external ? null : activePath ?? diffPath;
  const historyVisible = showHistory && git.isRepo;
  useSyncedScroll(editorScroller, diffScroller, Boolean(showDiff && comparedPath));
  const combinedDiagnostics = useMemo(() => {
    const combined = { ...diagnostics };
    for (const item of buildDiagnostics) {
      if (!item.path) continue;
      const path = normalPath(item.path);
      const diagnostic: LspDiagnostic = {
        range: { start: { line: item.line - 1, character: item.column - 1 }, end: { line: item.line - 1, character: item.column } },
        severity: item.severity === "error" ? 1 : 2, message: item.message, source: "Build",
      };
      const existing = combined[path] ?? [];
      if (!existing.some((value) => value.range.start.line === diagnostic.range.start.line && value.message === diagnostic.message)) combined[path] = [...existing, diagnostic];
    }
    return combined;
  }, [diagnostics, buildDiagnostics]);
  const activeDiagnostics = activeTab ? combinedDiagnostics[activeTab.path] ?? EMPTY_DIAGNOSTICS : EMPTY_DIAGNOSTICS;
  const dirtyPaths = useMemo(() => new Set(tabs.filter((tab) => tab.content !== tab.savedContent).map((tab) => normalPath(tab.path))), [tabs]);
  const modifiedPaths = useMemo(() => new Set([...git.changes.map((change) => normalPath(change.path)), ...dirtyPaths]), [git.changes, dirtyPaths]);
  const { errorCount, warningCount } = useMemo(() => {
    let errorCount = 0, warningCount = 0;
    for (const items of Object.values(combinedDiagnostics)) {
      for (const item of items) {
        if ((item.severity ?? 1) === 1) errorCount++;
        else if (item.severity === 2) warningCount++;
      }
    }
    for (const item of buildDiagnostics) {
      if (!item.path) {
        if (item.severity === "error") errorCount++;
        else warningCount++;
      }
    }
    return { errorCount, warningCount };
  }, [combinedDiagnostics, buildDiagnostics]);
  const notify = useCallback((message: string) => setToast(message), []);
  const hideTerminals = useCallback(() => setTerminalOpen(false), []);
  const handleAgentExit = useCallback((id: string) => {
    setSession((current) => current?.id === id ? { ...current, exited: true } : current);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { if (mode === "ide") setIdeOpened(true); }, [mode]);
  useEffect(() => writeStored("helmcode.view", activeView), [activeView]);
  useEffect(() => writeStored("helmcode.sidebar.collapsed", sidebarCollapsed), [sidebarCollapsed]);
  useEffect(() => writeStored("helmcode.sidebar.width", sidebarWidth), [sidebarWidth]);
  useEffect(() => {
    setWindowTitle(workspace ? `${basename(workspace)} - ${APP_NAME}` : APP_NAME);
  }, [workspace]);
  useEffect(() => subscribeTheme((_resolved, theme) => {
    setPrefs((current) => current.theme === theme ? current : { ...current, theme });
  }), []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const fonts = document.fonts?.ready.catch(() => undefined) ?? Promise.resolve();
        const startupEmpty = await api.startupEmptyRequested().catch(() => false);
        if (cancelled) return;
        setShowSplash(initialPrefs.current.showSplash && !startupEmpty);
        if (isTauri()) void showWindow();
        const current = await api.getWorkspace();
        if (cancelled) return;
        if (current) {
          setWorkspace(current);
          addRecent(current, basename(current));
          setShowProjects(false);
        } else if (!startupEmpty && initialPrefs.current.autoOpenLast) {
          const last = listRecents()[0];
          if (last) {
            try {
              const opened = await api.openWorkspace(last.path);
              if (!cancelled) {
                setWorkspace(opened);
                addRecent(opened, basename(opened));
                setShowProjects(false);
              }
            } catch {
              /* il progetto non esiste più: resta la schermata progetti */
            }
          }
        }
        await fonts;
      } catch (error) {
        if (!cancelled) notify(String(error));
      } finally {
        if (!cancelled) setAppReady(true);
      }
    };
    void init();
    return () => { cancelled = true; };
  }, [notify]);

  useEffect(() => {
    if (!appReady || showSplash) return;
    const nextScreen = showProjects || !workspace ? "projects" : "workspace";
    if (windowScreen.current === nextScreen) return;
    windowScreen.current = nextScreen;
    if (nextScreen === "projects") void applyStartWindowSize();
    else void applyAppWindowSize();
  }, [appReady, showSplash, showProjects, workspace]);

  useEffect(() => {
    if (!workspace) return;
    setSession(null);
    setGit(EMPTY_GIT);
    setSyncMenuOpen(false);
  }, [workspace]);

  useEffect(() => {
    if (workspace && mode === "ai" && !session) {
      setSession({ id: crypto.randomUUID(), title: agentLabel(prefs.agent), kind: "agent", agent: prefs.agent, exited: false });
    }
  }, [workspace, mode, session, prefs.agent]);

  useEffect(() => {
    if (!workspace) return;
    let requested = 0;
    const queue = createCoalescedRequest(async () => {
      requested = ++gitRequest.current;
      return { request: requested, status: await api.gitStatus() };
    }, ({ request, status }) => {
      if (request === gitRequest.current) setGit((current) => sameGitStatus(current, status) ? current : status);
    }, () => {
      if (requested === gitRequest.current) setGit(EMPTY_GIT);
    });
    gitRefresh.current = queue;
    const refresh = () => {
      if (document.hidden) return;
      queue.request();
    };
    const interval = window.setInterval(refresh, 8000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      queue.dispose();
      if (gitRefresh.current === queue) gitRefresh.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setTimeout(() => { if (!document.hidden) gitRefresh.current?.request(); }, 180);
    return () => window.clearTimeout(timer);
  }, [workspace, gitVersion]);

  useEffect(() => () => {
    fileRefreshes.current.forEach((queue) => queue.dispose());
    fileRefreshes.current.clear();
  }, [workspace]);

  const openFile = useCallback(async (path: string, external = false, canActivate: () => boolean = () => true) => {
    if (fileMutationRef.current) return false;
    path = normalPath(path);
    if (!canActivate()) return false;
    setShowHistory(false);
    if (tabsRef.current.some((tab) => tab.path === path)) {
      setActivePath(path);
      return true;
    }
    const openedWorkspace = workspaceRef.current;
    try {
      const content = external ? await readNavigationTarget(openedWorkspace, path) : await api.readFile(path);
      if (workspaceRef.current !== openedWorkspace || fileMutationRef.current || !canActivate()) return false;
      setTabs((current) => current.some((tab) => tab.path === path) ? current : [...current, { ...makeTab(path, content), external }]);
      setActivePath(path);
      return true;
    } catch (error) {
      notify(String(error));
      return false;
    }
  }, [notify]);

  const openAt = useCallback(async (path: string, line: number, column: number) => {
    const requestedWorkspace = workspaceRef.current;
    setShowDiff(false);
    const opened = await openFile(path);
    if (!opened || workspaceRef.current !== requestedWorkspace) return;
    setReveal({ path: normalPath(path), line, column, nonce: ++revealNonce.current });
  }, [openFile]);

  const openSymbol = useCallback(async (target: NavigationTarget) => {
    const requestedWorkspace = workspaceRef.current;
    const sourcePath = activePathRef.current;
    const sourceContent = tabsRef.current.find((tab) => tab.path === sourcePath)?.content;
    setShowDiff(false);
    const opened = await openFile(target.path, target.external, () => activePathRef.current === sourcePath
      && tabsRef.current.find((tab) => tab.path === sourcePath)?.content === sourceContent);
    if (!opened || workspaceRef.current !== requestedWorkspace) return;
    setReveal({ path: normalPath(target.path), line: target.line, column: target.column, nonce: ++revealNonce.current });
  }, [openFile]);

  const syncSavedFile = useCallback((savedWorkspace: string, path: string, text: string) => {
    if (workspaceRef.current !== savedWorkspace || !tabsRef.current.some((tab) => tab.path === path && !tab.external)) return;
    void saveIntelligence(savedWorkspace, path, text).then(() => {
      if (workspaceRef.current !== savedWorkspace) return;
      const current = tabsRef.current.find((tab) => tab.path === path);
      // Saving a snapshot must preserve any newer edits made while disk I/O ran.
      if (current && current.content !== text) return syncIntelligence(savedWorkspace, path, current.content);
    }).catch(() => undefined);
  }, []);

  const saveContent = useCallback(async (path: string, content: string) => {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab || tab.external) return;
    const savedWorkspace = workspaceRef.current;
    try {
      await api.saveFile(savedWorkspace, path, content);
      if (workspaceRef.current !== savedWorkspace) return;
      // Even a save of unchanged text supersedes any disk read already in flight.
      fileRefreshes.current.get(path)?.dispose();
      fileRefreshes.current.delete(path);
      // Publish the completed disk snapshot before flushSaves can resume a replacement.
      const updated = tabsRef.current.map((item) => item.path === path && !item.external
        ? { ...item, savedContent: content }
        : item);
      tabsRef.current = updated;
      setTabs(updated);
      syncSavedFile(savedWorkspace, path, content);
      setExplorerVersion((version) => version + 1);
      setGitVersion((version) => version + 1);
    } catch (error) {
      notify(String(error));
    }
  }, [notify, syncSavedFile]);

  const cancelAutosaves = useCallback((only?: string) => {
    if (only !== undefined) {
      const timer = autosaveTimers.current.get(only);
      if (timer !== undefined) window.clearTimeout(timer);
      autosaveTimers.current.delete(only);
      return;
    }
    autosaveTimers.current.forEach((timer) => window.clearTimeout(timer));
    autosaveTimers.current.clear();
  }, []);

  const scheduleAutosave = useCallback((path: string, content: string) => {
    const savedWorkspace = workspaceRef.current;
    cancelAutosaves(path);
    autosaveTimers.current.set(path, window.setTimeout(() => {
      autosaveTimers.current.delete(path);
      if (workspaceRef.current !== savedWorkspace || fileMutationRef.current) return;
      const tab = tabsRef.current.find((item) => item.path === path && !item.external);
      if (!tab || tab.content !== content || tab.savedContent === content) return;
      void saveContent(path, content);
    }, AUTOSAVE_DELAY));
  }, [cancelAutosaves, saveContent]);

  const handleChange = useCallback((path: string, content: string) => {
    if (fileMutationRef.current) return;
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab || tab.external) return;
    const updated = tabsRef.current.map((item) => item.path === path ? { ...item, content } : item);
    tabsRef.current = updated;
    setTabs(updated);
    scheduleAutosave(path, content);
  }, [scheduleAutosave]);

  const saveTab = useCallback(async (path: string) => {
    if (fileMutationRef.current) return;
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab || tab.external) return;
    cancelAutosaves(path);
    await saveContent(path, tab.content);
  }, [cancelAutosaves, saveContent]);

  const closeTab = useCallback((path: string) => {
    if (fileMutationRef.current) return;
    const tab = tabsRef.current.find((item) => item.path === path);
    cancelAutosaves(path);
    if (tab && !tab.external && tab.content !== tab.savedContent) {
      void api.saveFile(workspaceRef.current, path, tab.content).catch(() => undefined);
    }
    const remaining = tabsRef.current.filter((item) => item.path !== path);
    fileRefreshes.current.get(path)?.dispose();
    fileRefreshes.current.delete(path);
    if (!tab?.external) void closeIntelligence(workspaceRef.current, path).catch(() => undefined);
    if ((activePathRef.current ?? diffPathRef.current) === path) {
      setShowDiff(false);
      setDiffPath(null);
    }
    setTabs(remaining);
    setDiagnostics((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setActivePath((current) => current === path ? remaining[remaining.length - 1]?.path ?? null : current);
  }, []);

  const revertFile = useCallback(async (path: string, untracked: boolean) => {
    if (fileMutationRef.current) return;
    if (!window.confirm(untracked ? `Eliminare il file non tracciato ${path}?` : `Scartare le modifiche a ${path}?`)) return;
    const requestedWorkspace = workspaceRef.current;
    try {
      await api.gitRevertFile(requestedWorkspace, path);
      if (workspaceRef.current !== requestedWorkspace) return;
      if (tabsRef.current.some((tab) => tab.path === path)) {
        if (untracked) closeTab(path);
        else {
          const text = await api.readFile(path);
          if (workspaceRef.current !== requestedWorkspace) return;
          setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, content: text, savedContent: text, revision: tab.revision + 1 } : tab));
        }
      }
      setExplorerVersion((version) => version + 1);
      setGitVersion((version) => version + 1);
    } catch (error) {
      notify(String(error));
    }
  }, [closeTab, notify]);

  const saveBeforeBuild = useCallback(async () => {
    if (fileMutationRef.current) { notify("Attendi il completamento dell’operazione sui file."); return false; }
    cancelAutosaves();
    const savedWorkspace = workspaceRef.current;
    const dirty = tabsRef.current.filter((tab) => !tab.external && tab.content !== tab.savedContent);
    if (!dirty.length) return true;
    const results = await Promise.allSettled(dirty.map((tab) => api.saveFile(savedWorkspace, tab.path, tab.content)));
    if (workspaceRef.current !== savedWorkspace) return false;
    dirty.forEach((tab, index) => {
      if (results[index].status === "fulfilled") {
        fileRefreshes.current.get(tab.path)?.dispose();
        fileRefreshes.current.delete(tab.path);
        syncSavedFile(savedWorkspace, tab.path, tab.content);
      }
    });
    const updated = tabsRef.current.map((tab) => {
      const index = dirty.findIndex((item) => item.path === tab.path);
      return index >= 0 && results[index].status === "fulfilled"
        ? { ...tab, savedContent: dirty[index].content } : tab;
    });
    tabsRef.current = updated;
    setTabs(updated);
    setGitVersion((version) => version + 1);
    setExplorerVersion((version) => version + 1);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") { notify(`Salvataggio non riuscito: ${String(failure.reason)}`); return false; }
    return true;
  }, [cancelAutosaves, notify, syncSavedFile]);

  const canCheckout = useCallback(async () => saveBeforeBuild(), [saveBeforeBuild]);
  const canMerge = useCallback(async () => saveBeforeBuild(), [saveBeforeBuild]);

  useEffect(() => {
    const flush = () => { void saveBeforeBuild(); };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      cancelAutosaves();
    };
  }, [cancelAutosaves, saveBeforeBuild]);

  const canSwitchWorkspace = useCallback(async () => {
    if (fileMutationRef.current) { notify("Attendi il completamento dell’operazione sui file."); return false; }
    return saveBeforeBuild();
  }, [notify, saveBeforeBuild]);

  const openRecent = useCallback(async (path: string) => {
    if (!(await canSwitchWorkspace())) return;
    const opened = await api.openWorkspace(path);
    addRecent(opened, basename(opened));
    setShowProjects(false);
  }, [canSwitchWorkspace]);

  const pickWorkspace = useCallback(async () => {
    const path = await api.pickFolder();
    if (!path) return;
    if (!showProjects && workspace) {
      if (normalPath(path) === normalPath(workspace)) return;
      setPendingOpen({ kind: "recent", path, name: basename(path) });
      return;
    }
    try {
      await openRecent(path);
    } catch (error) {
      notify(String(error));
    }
  }, [notify, openRecent, showProjects, workspace]);

  const createProjectHere = useCallback(async (parent: string, name: string) => {
    if (!(await canSwitchWorkspace())) return;
    const path = await api.createWorkspace(parent, name, true);
    addRecent(path, basename(path));
    setShowProjects(false);
  }, [canSwitchWorkspace]);

  // The Projects screen always opens here; inside the workspace ask where to open it.
  const requestOpenRecent = useCallback(async (path: string) => {
    if (!showProjects && workspace) {
      if (normalPath(path) === normalPath(workspace)) return;
      setPendingOpen({ kind: "recent", path, name: basename(path) });
      return;
    }
    try {
      await openRecent(path);
    } catch (error) {
      notify(String(error));
    }
  }, [openRecent, notify, showProjects, workspace]);

  const requestCreateProject = useCallback(async (parent: string, name: string) => {
    if (showProjects || !workspace) {
      await createProjectHere(parent, name);
      setNewProjectOpen(false);
      return;
    }
    setNewProjectOpen(false);
    setPendingOpen({ kind: "create", parent, name });
  }, [createProjectHere, showProjects, workspace]);

  const openEmptyWindow = useCallback(async () => {
    try {
      await api.openNewWindow(null);
    } catch (error) {
      notify(String(error));
    }
  }, [notify]);

  const confirmPendingOpen = useCallback(async (target: "current" | "new") => {
    if (!pendingOpen) return;
    if (pendingOpen.kind === "recent") {
      if (target === "current") await openRecent(pendingOpen.path);
      else await api.openNewWindow(pendingOpen.path);
    } else if (target === "current") {
      await createProjectHere(pendingOpen.parent, pendingOpen.name);
    } else {
      const path = await api.createWorkspace(pendingOpen.parent, pendingOpen.name, false);
      addRecent(path, basename(path));
      await api.openNewWindow(path);
    }
    setPendingOpen(null);
  }, [pendingOpen, openRecent, createProjectHere]);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    if (patch.theme !== undefined) { savePref("theme", patch.theme); applyTheme(patch.theme); }
    if (patch.showSplash !== undefined) savePref("showSplash", patch.showSplash);
    if (patch.autoOpenLast !== undefined) savePref("autoOpenLast", patch.autoOpenLast);
    if (patch.autoCheckUpdates !== undefined) savePref("autoCheckUpdates", patch.autoCheckUpdates);
    if (patch.startMode !== undefined) {
      savePref("startMode", patch.startMode);
      setMode(patch.startMode);
    }
  }, []);

  const restorePrefs = useCallback(() => {
    const next = resetPrefs();
    setPrefs(next);
    applyTheme(next.theme);
    setMode(next.startMode);
  }, []);


  const finishSplash = useCallback(() => setShowSplash(false), []);

  const showView = useCallback((view: ActivityView) => {
    setShowProjects(false);
    setMode("ide");
    setActiveView(view);
    setSidebarCollapsed(false);
    if (view === "git") { setShowDiff(false); setShowHistory(true); }
    else setShowHistory(false);
  }, []);

  const toggleView = useCallback((view: ActivityView): "opened" | "closed" => {
    if (activeView === view && !sidebarCollapsed && mode === "ide" && !showProjects) {
      setSidebarCollapsed(true);
      return "closed";
    }
    showView(view);
    return "opened";
  }, [activeView, mode, showProjects, showView, sidebarCollapsed]);

  const toggleTerminal = useCallback(() => {
    if (!workspace) { notify("Apri un progetto per usare i terminali."); return; }
    if (terminalOpen && mode === "ide" && !showProjects) {
      setTerminalOpen(false);
      return;
    }
    setShowProjects(false);
    setMode("ide");
    setTerminalOpen(true);
    setTerminalFocusRequest((value) => value + 1);
  }, [mode, notify, showProjects, terminalOpen, workspace]);

  const syncRepository = async (action?: "fetch" | "pull" | "push" | "both") => {
    if (fetchingGit || !git.isRepo) return;
    if (!action) {
      if (git.behind > 0 && git.ahead > 0) { setSyncMenuOpen(true); return; }
      action = git.behind > 0 ? "pull" : git.ahead > 0 ? "push" : "fetch";
    }
    setSyncMenuOpen(false);
    const requestedWorkspace = workspace;
    setFetchingGit(true);
    ++gitRequest.current;
    try {
      if ((action === "pull" || action === "both") && !(await saveBeforeBuild())) return;
      if (action === "fetch") {
        const status = await api.gitFetch(requestedWorkspace);
        if (workspaceRef.current !== requestedWorkspace) return;
        ++gitRequest.current;
        setGit(status);
        setGitVersion((version) => version + 1);
        return;
      }
      if (action === "pull" || action === "both") {
        const outcome = await api.gitPull(requestedWorkspace);
        if (workspaceRef.current !== requestedWorkspace) return;
        ++gitRequest.current;
        setGit(outcome.status);
        setGitVersion((version) => version + 1);
        if (outcome.conflicts.length > 0) {
          notify("Pull completato con conflitti: risolvili dal pannello Git.");
          return;
        }
      }
      if (action === "push" || action === "both") {
        const status = await api.gitPush(requestedWorkspace);
        if (workspaceRef.current !== requestedWorkspace) return;
        ++gitRequest.current;
        setGit(status);
        setGitVersion((version) => version + 1);
      }
    } catch (error) {
      if (workspaceRef.current === requestedWorkspace) notify(String(error));
    } finally { setFetchingGit(false); }
  };
  useEffect(() => {
    if (!syncMenuOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSyncMenuOpen(false); };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [syncMenuOpen]);
  const refreshSidebar = useCallback(() => {
    setExplorerVersion((version) => version + 1);
    setGitVersion((version) => version + 1);
    setTasksVersion((version) => version + 1);
  }, []);

  const cherryPickCommit = useCallback(async (hash: string) => {
    if (!(await saveBeforeBuild())) return;
    const requestedWorkspace = workspace;
    ++gitRequest.current;
    try {
      const outcome = await api.gitCherryPick(requestedWorkspace, hash);
      if (workspaceRef.current !== requestedWorkspace) return;
      ++gitRequest.current;
      setGit(outcome.status);
      setGitVersion((version) => version + 1);
      notify(outcome.conflicts.length > 0
        ? "Cherry-pick con conflitti: risolvili dal pannello Git."
        : "Cherry-pick completato.");
    } catch (error) {
      if (workspaceRef.current === requestedWorkspace) notify(String(error));
    }
  }, [notify, saveBeforeBuild, workspace]);

  const beginSidebarResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (next: MouseEvent) => setSidebarWidth(Math.min(360, Math.max(180, startWidth + next.clientX - startX)));
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }, [sidebarWidth]);

  const handleFsChanged = useCallback((paths: string[]) => {
    if (fileMutationRef.current) { paths.forEach((path) => deferredFsChanges.current.add(path)); return; }
    const changedWorkspace = workspaceRef.current;
    setExplorerVersion((version) => version + 1);
    setGitVersion((version) => version + 1);
    if (paths.some((path) => /(^|\/)(package\.json|Cargo\.toml|pnpm-lock\.yaml|yarn\.lock)$/.test(path))) setTasksVersion((version) => version + 1);
    for (const path of new Set(paths)) {
      if (!tabsRef.current.some((tab) => tab.path === path && !tab.external)) continue;
      let queue = fileRefreshes.current.get(path);
      if (!queue) {
        queue = createCoalescedRequest(async () => {
          const snapshot = tabsRef.current.find((tab) => tab.path === path && !tab.external);
          if (!snapshot || workspaceRef.current !== changedWorkspace) return null;
          return { snapshot, disk: await api.readFile(path) };
        }, (result) => {
          if (!result || workspaceRef.current !== changedWorkspace) return;
          if (fileMutationRef.current) { deferredFsChanges.current.add(path); return; }
          setTabs((current) => applyDiskRefresh(current, result.snapshot, result.disk));
        });
        fileRefreshes.current.set(path, queue);
      }
      // Only one disk read per file can run, even during a sustained event burst.
      queue.request();
    }
  }, []);

  const replaceInProject = useCallback(async (request: ReplaceRequest): Promise<ReplaceResult> => {
    if (fileMutationRef.current) throw new Error("Attendi il completamento dell'operazione in corso.");
    const requestedWorkspace = workspaceRef.current;
    fileMutationRef.current = requestedWorkspace;
    cancelAutosaves();
    fileRefreshes.current.forEach((queue) => queue.dispose());
    fileRefreshes.current.clear();
    setMutatingFiles(true);
    suspendIntelligence(requestedWorkspace, true);
    let completed = false;
    try {
      await api.flushSaves();
      if (workspaceRef.current !== requestedWorkspace) throw new Error("Il progetto è cambiato: riprova.");
      const snapshot = tabsRef.current.filter((tab) => !tab.external);
      const result = await api.replaceText(requestedWorkspace, request, snapshot.map((tab) => ({ path: tab.path, text: tab.content, savedText: tab.savedContent })));
      if (workspaceRef.current !== requestedWorkspace) return result;
      const changedDocuments = new Map(result.documents.map((document) => [document.path, document]));
      const updated = tabsRef.current.map((tab) => {
        const changed = !tab.external && changedDocuments.get(tab.path);
        // Keep the current editor instance so replacement is an undoable transaction.
        return changed ? { ...tab, content: changed.content, savedContent: changed.savedContent } : tab;
      });
      tabsRef.current = updated;
      setTabs(updated);
      suspendIntelligence(requestedWorkspace, false);
      for (const tab of updated) {
        if (!tab.external && changedDocuments.has(tab.path)) {
          void syncIntelligence(requestedWorkspace, tab.path, tab.content).catch(() => undefined);
        }
      }
      completed = true;
      refreshSidebar();
      return result;
    } finally {
      suspendIntelligence(requestedWorkspace, false);
      fileMutationRef.current = null;
      setMutatingFiles(false);
      if (workspaceRef.current === requestedWorkspace) {
        const pending = [...deferredFsChanges.current];
        deferredFsChanges.current.clear();
        if (pending.length) handleFsChanged(pending);
        // A rejected replacement can signal an external disk conflict. Never save
        // its stale buffers in finally; resume normal autosave only after success.
        if (completed) for (const tab of tabsRef.current) {
          if (!tab.external && tab.content !== tab.savedContent) scheduleAutosave(tab.path, tab.content);
        }
      }
    }
  }, [cancelAutosaves, handleFsChanged, refreshSidebar, scheduleAutosave]);

  const mutateFiles = useCallback(async (operations: FileOperation[]): Promise<WorkspaceMutation | null> => {
    if (!operations.length || fileMutationRef.current) return null;
    const requestedWorkspace = workspaceRef.current;
    const deleting = operations.filter((operation) => operation.kind === "delete");
    if (deleting.length) {
      const dirty = tabsRef.current.filter((tab) => !tab.external && tab.content !== tab.savedContent
        && deleting.some((operation) => pathContains(operation.path, tab.path)));
      const details = dirty.length ? `\n\nLe modifiche non salvate in ${dirty.map((tab) => tab.name).join(", ")} andranno perse.` : "";
      if (!window.confirm(`Eliminare definitivamente ${deleting.map((operation) => operation.path).join(", ")}? Le cartelle saranno eliminate con tutto il loro contenuto.${details}`)) return null;
    }
    fileMutationRef.current = requestedWorkspace;
    cancelAutosaves();
    fileRefreshes.current.forEach((queue) => queue.dispose());
    fileRefreshes.current.clear();
    setMutatingFiles(true);
    suspendIntelligence(requestedWorkspace, true);
    let completed = false;
    try {
      // Finish writes to the original paths before planning the move and its edits.
      await api.flushSaves();
      if (workspaceRef.current !== requestedWorkspace) return null;
      const snapshot = tabsRef.current.filter((tab) => !tab.external);
      await Promise.all(snapshot.map((tab) => closeIntelligence(requestedWorkspace, tab.path).catch(() => undefined)));
      if (workspaceRef.current !== requestedWorkspace) return null;
      const result = await api.mutateEntries(requestedWorkspace, operations, snapshot.map((tab) => ({ path: tab.path, text: tab.content, savedText: tab.savedContent })));
      if (workspaceRef.current !== requestedWorkspace) return null;
      const updated = applyMutationToTabs(tabsRef.current, result);
      tabsRef.current = updated;
      setTabs(updated);
      setActivePath((current) => {
        if (!current) return null;
        const path = movedPath(current, result.moves);
        return updated.some((tab) => tab.path === path) ? path : updated.at(-1)?.path ?? null;
      });
      setReveal((current) => current && !result.deleted.some((path) => pathContains(path, current.path))
        ? { ...current, path: movedPath(current.path, result.moves) } : null);
      setDiffPath((current) => current && !result.deleted.some((path) => pathContains(path, current)) ? movedPath(current, result.moves) : null);
      setShowDiff(false);
      setDiagnostics({});
      setBuildDiagnostics([]);
      refreshSidebar();
      if (result.warnings.length) notify(result.warnings.join(" · "));
      else if (result.referencesUpdated) notify("File e riferimenti aggiornati.");
      completed = true;
      return result;
    } catch (error) {
      notify(String(error));
      throw error;
    } finally {
      suspendIntelligence(requestedWorkspace, false);
      fileMutationRef.current = null;
      setMutatingFiles(false);
      if (workspaceRef.current === requestedWorkspace) {
        // Failed refactorings may indicate a disk conflict. Keep those buffers
        // unsaved; after success, autosave only their current, remapped paths.
        if (completed) for (const tab of tabsRef.current) {
          if (!tab.external && tab.content !== tab.savedContent) scheduleAutosave(tab.path, tab.content);
        }
        tabsRef.current.filter((tab) => !tab.external).forEach((tab) => { void syncIntelligence(requestedWorkspace, tab.path, tab.content).catch(() => undefined); });
        const paths = Array.from(deferredFsChanges.current);
        deferredFsChanges.current.clear();
        if (paths.length) void handleFsChanged(paths);
      } else deferredFsChanges.current.clear();
    }
  }, [cancelAutosaves, handleFsChanged, notify, refreshSidebar, scheduleAutosave]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = async (subscription: Promise<() => void>) => {
      const unlisten = await subscription;
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    };
    void Promise.all([
      register(onDiagnostics((payload) => {
        if (payload.workspace && normalPath(payload.workspace) !== normalPath(workspaceRef.current)) return;
        setDiagnostics((current) => ({ ...current, [normalPath(payload.path)]: payload.diagnostics }));
      })),
      register(onWorkspaceChanged((nextWorkspace) => {
        cancelAutosaves();
        workspaceRef.current = nextWorkspace;
        setWorkspace(nextWorkspace);
        setTabs([]);
        setActivePath(null);
        setReveal(null);
        setDiagnostics({});
        setBuildDiagnostics([]);
        setShowDiff(false);
        setShowHistory(activeViewRef.current === "git");
        setDiffPath(null);
        if (nextWorkspace) {
          addRecent(nextWorkspace, basename(nextWorkspace));
          setShowProjects(false);
        } else {
          setShowProjects(true);
        }
        refreshSidebar();
      })),
      register(onFsChanged((payload) => {
        if (payload.workspace && normalPath(payload.workspace) !== normalPath(workspaceRef.current)) return;
        handleFsChanged(payload.paths);
      })),
    ]).catch((error: unknown) => notify(String(error)));
    return () => { disposed = true; unlisteners.forEach((unlisten) => unlisten()); };
  }, [cancelAutosaves, handleFsChanged, notify, refreshSidebar]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminal();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Backquote" && workspace && !showProjects) {
        event.preventDefault();
        event.stopPropagation();
        setMode("ide");
        if (event.shiftKey) { setTerminalOpen(true); setNewTerminalRequest((value) => value + 1); }
        else setTerminalOpen((current) => !current);
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === "a" || shortcut === "h") {
        event.preventDefault();
        event.stopPropagation();
        if (!workspace || showProjects) { notify("Apri un progetto per cambiare modalità."); return; }
        setMode(shortcut === "a" ? "ai" : "ide");
        return;
      }
      if (shortcut === "r") {
        event.preventDefault();
        if (!workspace) { notify("Apri un progetto per usare le sezioni."); return; }
        showView("search");
        setSearchFocus((current) => ({ nonce: current.nonce + 1, replace: true }));
        return;
      }
      const views: Record<string, ActivityView> = { e: "explorer", f: "search", g: "git", b: "build" };
      const view = views[shortcut];
      if (view) {
        event.preventDefault();
        if (!workspace) { notify("Apri un progetto per usare le sezioni."); return; }
        const opened = toggleView(view);
        if (view === "search" && opened === "opened") {
          setSearchFocus((current) => ({ nonce: current.nonce + 1, replace: false }));
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [notify, showProjects, showView, toggleTerminal, toggleView, workspace]);

  const openDiff = useCallback((path: string) => {
    setDiffPath(path);
    setActivePath(null);
    setShowHistory(false);
    setShowDiff(true);
    if (!git.changes.some((change) => change.path === path && change.label === "D")) void openFile(path);
  }, [openFile, git.changes]);

  const openExplorerFile = useCallback((path: string) => {
    setShowDiff(false);
    setDiffPath(null);
    void openFile(path);
  }, [openFile]);

  const revealInExplorer = useCallback((path: string) => {
    setActiveView("explorer");
    setSidebarCollapsed(false);
    setShowHistory(false);
    setExplorerReveal({ path: normalPath(path), nonce: ++explorerRevealNonce.current });
  }, []);

  return (
    <div className="app-shell">
      {workspace && (
        <div className="app-frame" style={{ display: showProjects ? "none" : "flex" }}>
          <TitleBar
            mode={mode}
            onModeChange={setMode}
            workspace={workspace}
            maximized={maximized}
            modifiedCount={modifiedPaths.size}
            hasUnsavedChanges={dirtyPaths.size > 0}
            autoCheckUpdates={prefs.autoCheckUpdates && !showProjects}
            onShowProjects={() => setShowProjects(true)}
            onOpenFolder={() => void pickWorkspace()}
            onNewProject={() => setNewProjectOpen(true)}
            onNewWindow={() => void openEmptyWindow()}
            onOpenRecent={(path) => void requestOpenRecent(path)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenAbout={() => setAboutOpen(true)}
            onSaveAll={saveBeforeBuild}
          />
          <div className="workspace-body">
            <div className="ide-workspace" style={{ display: mode === "ide" ? "flex" : "none" }}>
              <ActivityBar active={activeView} collapsed={sidebarCollapsed} modifiedCount={modifiedPaths.size} problemCount={errorCount + warningCount} onSelect={toggleView} terminalOpen={terminalOpen} onToggleTerminals={() => setTerminalOpen((current) => !current)} />
              <aside className="project-sidebar" style={{ width: sidebarWidth, display: sidebarCollapsed ? "none" : "flex" }} aria-label="Pannello del progetto">
                <SidebarHeader view={activeView} onCreate={(kind) => setExplorerCreateRequest((current) => ({ id: current.id + 1, kind }))} onRefresh={refreshSidebar} />
                <div className="sidebar-content" hidden={activeView !== "explorer"}><FileExplorer createRequest={explorerCreateRequest} onCreated={refreshSidebar} workspace={workspace} version={explorerVersion} modified={modifiedPaths} activePath={activePath} onOpen={openExplorerFile} onMutate={mutateFiles} revealRequest={explorerReveal} /></div>
                <div className="sidebar-content" hidden={activeView !== "search"}><SearchPanel workspace={workspace} active={activeView === "search" && !sidebarCollapsed && mode === "ide" && !showProjects} tabs={tabs} version={explorerVersion} focusRequest={searchFocus} disabled={mutatingFiles} onOpenAt={openAt} onReplace={replaceInProject} /></div>
                <div className="sidebar-content" hidden={activeView !== "git"}><GitPanel workspace={workspace} status={git} activePath={activePath} onReveal={revealInExplorer} onDiff={openDiff} onRevert={revertFile} onRefresh={refreshSidebar} onBeforeMerge={canMerge} onNotify={notify} /></div>
                <div className="sidebar-content" hidden={activeView !== "build"}><BuildPanel problemsRequest={problemsRequest} workspace={workspace} version={tasksVersion} diagnostics={diagnostics} onDiagnosticsChange={setBuildDiagnostics} onBeforeRun={saveBeforeBuild} onOpenAt={openAt} /></div>
              </aside>
              {!sidebarCollapsed && <div className="sidebar-resizer" role="separator" aria-label="Ridimensiona pannello del progetto" aria-orientation="vertical" onMouseDown={beginSidebarResize} />}
              <main className="editor-workspace" aria-label="HELM · Editor di codice">
                {!historyVisible && <div className="editor-tabs">
                  <div className="scroll-area file-tabs" role="tablist" aria-label="File aperti">
                    {tabs.length === 0 && <span className="editor-placeholder">Editor</span>}
                    {tabs.map((tab) => (
                      <div key={tab.path} className={`file-tab ${tab.path === activePath ? "is-active" : ""}`}
                        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.path); } }}
                        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}>
                        <button type="button" role="tab" aria-selected={tab.path === activePath} title={tab.path} onClick={() => { setActivePath(tab.path); setDiffPath(null); setShowDiff(false); setShowHistory(false); }} className="file-tab-select">
                          <FileTypeIcon path={tab.path} className="h-[18px] w-[18px] shrink-0" />
                          <span className="max-w-[160px] truncate">{tab.name}</span>
                          {tab.content !== tab.savedContent && <span className="unsaved-dot" aria-label="Modifiche non salvate" />}
                        </button>
                        <button type="button" className="file-tab-close" title={`Chiudi ${tab.name}`} aria-label={`Chiudi ${tab.name}`} onClick={() => closeTab(tab.path)}><XIcon className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  {comparedPath && <button type="button" disabled={!git.isRepo} aria-pressed={showDiff} onClick={() => setShowDiff((current) => !current)} className={`diff-toggle ${showDiff ? "is-active" : ""}`} title={git.isRepo ? "Confronta il file corrente con Git HEAD" : "Il progetto non è un repository Git"}><GitBranchIcon className="h-4 w-4" /><span>Diff</span></button>}
                </div>}
                {!historyVisible && activeTab && !(showDiff && comparedPath) && <div className="file-breadcrumb"><span>{activeTab.path.split("/").slice(0, -1).join(" / ")}</span><span className="text-[var(--secondary)]">{activeTab.name}</span>{dirtyPaths.has(activeTab.path) && <button type="button" className="ml-auto text-[var(--accent)]" onClick={() => void saveTab(activeTab.path)}>Salva <kbd>Ctrl S</kbd></button>}</div>}
                <div className={`editor-content ${showDiff && comparedPath ? "with-diff" : ""}`}>
                  <div className="editor-document" hidden={historyVisible}>
                    {showDiff && comparedPath && <div className="diff-header"><GitBranchIcon className="h-4 w-4" /><span>Differenze · HEAD</span><button type="button" className="ml-auto icon-button" title="Chiudi differenze" aria-label="Chiudi differenze" onClick={() => setShowDiff(false)}><XIcon className="h-3.5 w-3.5" /></button></div>}
                    <div className="editor-fill">{ideOpened && <Suspense fallback={<div className="panel-empty">Apertura editor…</div>}><EditorPane workspace={workspace} locked={mutatingFiles} tab={activeTab} diagnostics={activeDiagnostics} reveal={reveal} onChange={handleChange} onSave={(path) => void saveTab(path)} onNavigate={openSymbol} onScroller={setEditorScroller} /></Suspense>}</div>
                  </div>
                  {showDiff && comparedPath && <section className="diff-document" aria-label="Differenze del file rispetto a Git"><GitDiff workspace={workspace} path={comparedPath} content={activeTab?.content} version={gitVersion} onScroller={setDiffScroller} /></section>}
                  {historyVisible && <GitHistory key={workspace} workspace={workspace} version={gitVersion} onCherryPick={cherryPickCommit} />}
                </div>
                <TerminalPanel key={workspace} open={terminalOpen} active={mode === "ide" && !showProjects} createRequest={newTerminalRequest} focusRequest={terminalFocusRequest} onHide={hideTerminals} />
              </main>
            </div>
            <main className="ai-workspace" style={{ display: mode === "ai" ? "flex" : "none" }} aria-label="AGENT · Assistente di programmazione">
              {session ? <Suspense fallback={<AgentLoading agent={agentLabel(prefs.agent)} />}><TerminalSession key={session.id} tab={session} active={mode === "ai" && !showProjects} onExit={handleAgentExit} /></Suspense> : <AgentLoading agent={agentLabel(prefs.agent)} />}
              {session?.exited && <div className="ai-restart"><span>La sessione AGENT è terminata.</span><button type="button" className="ghost-button flex items-center gap-2 rounded-md px-3 py-1.5" onClick={() => setSession({ id: crypto.randomUUID(), title: agentLabel(prefs.agent), kind: "agent", agent: prefs.agent })}><RefreshIcon className="h-4 w-4" />Riavvia AGENT</button></div>}
            </main>
          </div>
          <footer className="statusbar">
            {mutatingFiles && <span className="file-operation-status" role="status">Aggiornamento file e riferimenti…</span>}
            {git.isRepo
              ? <BranchPicker workspace={workspace} version={gitVersion} current={git.branch} variant="status"
                  badge={git.changes.length > 0 ? "*" : undefined} hasChanges={git.changes.length > 0}
                  onBeforeCheckout={canCheckout} onSaveAll={saveBeforeBuild} onNotify={notify} onChanged={refreshSidebar} />
              : <button type="button" onClick={() => showView("git")} title="Visualizza branch e modifiche Git" className="status-item"><span className="status-branch-icon"><StatusBranchIcon /></span><span>Nessun repository</span></button>}
            {git.isRepo && <div className="status-sync-wrap">
              <button type="button" onClick={() => syncMenuOpen ? setSyncMenuOpen(false) : void syncRepository()} disabled={fetchingGit} aria-label="Sincronizza repository" aria-busy={fetchingGit} aria-haspopup="menu" aria-expanded={syncMenuOpen} title={`Sincronizza repository · ${git.ahead || 0} da inviare, ${git.behind || 0} da scaricare${git.upstream ? ` · ${git.upstream}` : " · Nessun branch remoto associato"}`} className="status-item status-sync"><StatusSyncIcon className={fetchingGit ? "animate-spin" : ""} />{(git.behind > 0 || git.ahead > 0) && <><span className="status-sync-count" title={`${git.behind} commit da scaricare`}>↓{git.behind}</span><span className="status-sync-count" title={`${git.ahead} commit da inviare`}>↑{git.ahead}</span></>}</button>
              {syncMenuOpen && <>
                <div className="fixed inset-0 z-40" onClick={() => setSyncMenuOpen(false)} />
                <div className="status-sync-menu" role="menu" aria-label="Sincronizza repository">
                  <button type="button" role="menuitem" onClick={() => void syncRepository("pull")}><CloudDownIcon className="h-4 w-4" /><span>Pull (↓{git.behind})</span></button>
                  <button type="button" role="menuitem" onClick={() => void syncRepository("push")}><CloudUpIcon className="h-4 w-4" /><span>Push (↑{git.ahead})</span></button>
                  <button type="button" role="menuitem" onClick={() => void syncRepository("both")}><SyncIcon className="h-4 w-4" /><span>Pull e push</span></button>
                </div>
              </>}
            </div>}
            <button type="button" onClick={() => { showView("build"); setProblemsRequest((value) => value + 1); }} title="Apri build e problemi" aria-label={`${errorCount} errori, ${warningCount} avvisi. Apri Problemi in HELM`} className="status-item status-problems"><StatusErrorIcon /><span>{errorCount}</span><StatusWarningIcon /><span>{warningCount}</span></button>
            <span className="ml-auto truncate">{mode === "ai" ? `AGENT · ${agentLabel(session?.agent ?? prefs.agent)}` : `HELM · ${activeTab ? activeTab.path.split(".").pop()?.toUpperCase() : "helmcode"}`}</span>
            <span>UTF-8</span>
          </footer>
        </div>
      )}

      {showSplash !== null && (showProjects || !workspace) && (
        <StartScreen
          currentWorkspace={workspace}
          hasUnsavedChanges={dirtyPaths.size > 0}
          maximized={maximized}
          autoCheckUpdates={prefs.autoCheckUpdates}
          onOpenFolder={pickWorkspace}
          onOpenRecent={requestOpenRecent}
          onCreate={requestCreateProject}
          onSaveAll={saveBeforeBuild}
          onClose={() => setShowProjects(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAbout={() => setAboutOpen(true)}
        />
      )}

      <WindowResizeHandles hidden={maximized} />
      {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} onCreate={requestCreateProject} />}
      {pendingOpen && <OpenInWindowModal name={pendingOpen.name} path={pendingOpen.kind === "recent" ? pendingOpen.path : undefined} creating={pendingOpen.kind === "create"} onChoose={confirmPendingOpen} onClose={() => setPendingOpen(null)} />}
      {settingsOpen && <SettingsModal prefs={prefs} onChange={updatePrefs} onReset={restorePrefs} onClose={() => setSettingsOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {showSplash && <SplashScreen isReady={appReady} onFinish={finishSplash} />}
      {toast && <div role="status" className="app-toast">{toast}<button type="button" className="icon-button ml-3" onClick={() => setToast(null)} title="Chiudi notifica" aria-label="Chiudi notifica"><XIcon className="h-3.5 w-3.5" /></button></div>}
    </div>
  );
}
