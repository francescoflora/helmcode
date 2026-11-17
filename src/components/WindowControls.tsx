import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../lib/window";
import { MaximizeIcon, MinimizeIcon, RestoreIcon, XIcon } from "./Icons";

type Props = {
  maximized: boolean;
};

export function WindowControls({ maximized }: Props) {
  return (
    <div className="window-controls" data-tauri-drag-region="false">
      <button type="button" title="Riduci a icona" aria-label="Riduci a icona" onClick={() => void minimizeWindow()} className="window-button">
        <MinimizeIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        title={maximized ? "Ripristina" : "Massimizza"}
        aria-label={maximized ? "Ripristina" : "Massimizza"}
        onClick={() => void toggleMaximizeWindow()}
        className="window-button"
      >
        {maximized ? <RestoreIcon className="h-4 w-4" /> : <MaximizeIcon className="h-4 w-4" />}
      </button>
      <button type="button" title="Chiudi" aria-label="Chiudi" onClick={() => void closeWindow()} className="window-button window-close">
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
