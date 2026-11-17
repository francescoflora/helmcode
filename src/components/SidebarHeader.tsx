import type { ActivityView } from "../types";
import { FilePlusIcon, FolderPickerIcon, RefreshIcon } from "./Icons";

type Props = {
  view: ActivityView;
  onCreate: (kind: "file" | "folder") => void;
  onRefresh: () => void;
};

const labels: Record<ActivityView, string> = {
  explorer: "Progetto",
  search: "Cerca",
  git: "Git e branch",
  build: "Build e problemi",
};

export function SidebarHeader({ view, onCreate, onRefresh }: Props) {
  return (
    <div className="sidebar-header">
      <span>
        {labels[view]}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {view === "explorer" && (
          <>
            <button type="button" className="icon-button" title="Nuovo file" aria-label="Nuovo file" onClick={() => onCreate("file")}><FilePlusIcon className="h-[18px] w-[18px]" /></button>
            <button
              type="button"
              onClick={() => onCreate("folder")}
              title="Nuova cartella"
              aria-label="Nuova cartella"
              className="icon-button"
            >
              <FolderPickerIcon className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={onRefresh}
              title="Aggiorna esploratore"
              aria-label="Aggiorna esploratore"
              className="icon-button"
            >
              <RefreshIcon className="h-4 w-4" />
            </button>
          </>
        )}
        {view === "build" && (
          <button
            type="button"
            onClick={onRefresh}
            title="Rileggi task del workspace"
            aria-label="Rileggi task del workspace"
            className="icon-button"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
