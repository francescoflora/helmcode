import { useEffect, useState } from "react";
import { APP_AUTHOR, APP_LICENSE, GITHUB_URL, LINKEDIN_URL, getAppVersion } from "../lib/appinfo";
import { openExternalUrl } from "../lib/opener";
import { BrandMark } from "./BrandMark";
import { ExternalLinkIcon, XIcon } from "./Icons";

export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("…");

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card max-w-sm" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark className="h-12 w-12" />
            <div>
              <div className="text-lg font-bold tracking-tight">
                <span className="brand-helm">helm</span><span className="brand-code">code</span>
              </div>
              <div className="text-[13px] text-[var(--secondary)]">Versione {version}</div>
            </div>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-[var(--secondary)]">Autore</dt>
            <dd className="text-[var(--text)]">{APP_AUTHOR}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-[var(--secondary)]">Licenza</dt>
            <dd className="text-[var(--text)]">{APP_LICENSE}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            className="ghost-button flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px]"
            onClick={() => void openExternalUrl(GITHUB_URL)}
          >
            <ExternalLinkIcon className="h-4.5 w-4.5" /> Repository GitHub
          </button>
          <button
            type="button"
            className="ghost-button flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px]"
            onClick={() => void openExternalUrl(LINKEDIN_URL)}
          >
            <ExternalLinkIcon className="h-4.5 w-4.5" /> LinkedIn
          </button>
        </div>
      </div>
    </div>
  );
}
