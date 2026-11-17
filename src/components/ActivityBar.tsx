import type { ActivityView } from "../types";
import { ChangeBadge } from "./ChangeBadge";
import { BuildIcon, FilesIcon, GitBranchIcon, SearchIcon, TerminalIcon } from "./Icons";

const items = [
  { id: "explorer" as const, label: "File", shortcut: "Ctrl+Shift+E", icon: FilesIcon },
  { id: "search" as const, label: "Cerca", shortcut: "Ctrl+Shift+F", icon: SearchIcon },
  { id: "git" as const, label: "Git e branch", shortcut: "Ctrl+Shift+G", icon: GitBranchIcon },
  { id: "build" as const, label: "Build e problemi", shortcut: "Ctrl+Shift+B", icon: BuildIcon },
];

export function ActivityBar({ active, collapsed, modifiedCount, problemCount, onSelect, terminalOpen, onToggleTerminals }: {
  active: ActivityView;
  collapsed: boolean;
  modifiedCount: number;
  problemCount: number;
  onSelect: (view: ActivityView) => void;
  terminalOpen: boolean;
  onToggleTerminals: () => void;
}) {
  return (
    <nav className="activity-bar" aria-label="Strumenti del progetto">
      {items.map(({ id, label, shortcut, icon: Icon }) => (
        <button key={id} type="button" title={`${label} (${shortcut})`} aria-label={`${label}${id === "git" ? `, ${modifiedCount} file modificati` : ""}`} aria-pressed={active === id && !collapsed} onClick={() => onSelect(id)} className={`activity-button ${active === id && !collapsed ? "is-active" : ""}`}>
          <Icon className="h-[22px] w-[22px]" />
          <ChangeBadge count={id === "git" ? modifiedCount : id === "build" ? problemCount : 0} className="activity-badge" />
        </button>
      ))}
      <button type="button" className={`activity-button ${terminalOpen ? "is-active" : ""}`} onClick={onToggleTerminals} aria-label="Terminali" aria-pressed={terminalOpen} title="Terminali (Ctrl+Shift+T)"><TerminalIcon className="h-[22px] w-[22px]" /></button>
    </nav>
  );
}
