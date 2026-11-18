import type { Prefs } from "../lib/prefs";
import { AGENTS } from "../lib/agents";
import { MonitorIcon, MoonIcon, SunIcon, XIcon } from "./Icons";

type Props = {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
  onReset: () => void;
  onClose: () => void;
};

export function SettingsModal({ prefs, onChange, onReset, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card max-w-md" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">Impostazioni</h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">Aspetto, avvio, chiusura e aggiornamenti.</p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <section className="settings-section appearance-section">
          <h3 className="settings-heading">Aspetto</h3>
          <div className="appearance-options" role="group" aria-label="Tema dell'interfaccia">
            {([
              { value: "dark", label: "Scuro", Icon: MoonIcon },
              { value: "light", label: "Chiaro", Icon: SunIcon },
              { value: "system", label: "Sistema", Icon: MonitorIcon },
            ] as const).map(({ value, label, Icon }) => (
              <button key={value} type="button" className={`appearance-option ${prefs.theme === value ? "is-active" : ""}`}
                data-theme-option={value} aria-pressed={prefs.theme === value} onClick={() => onChange({ theme: value })}>
                <span className="appearance-preview" data-theme-preview={value} aria-hidden="true">
                  <span className="appearance-preview-toolbar" />
                  <span className="appearance-preview-sidebar" />
                  <span className="appearance-preview-lines"><span /><span /><span /></span>
                </span>
                <span className="appearance-option-label"><Icon className="h-4 w-4" />{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Avvio</h3>
          <label className="check-row">
            <input type="checkbox" checked={prefs.showSplash} onChange={(event) => onChange({ showSplash: event.target.checked })} />
            <span>Mostra la splash screen</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={prefs.autoOpenLast} onChange={(event) => onChange({ autoOpenLast: event.target.checked })} />
            <span>Apri l'ultimo progetto all'avvio</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={prefs.confirmClose} onChange={(event) => onChange({ confirmClose: event.target.checked })} />
            <span>Chiedi conferma prima di chiudere la finestra</span>
          </label>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Modalità iniziale</h3>
          <div className="flex gap-2">
            {(["ai", "ide"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`settings-choice ${prefs.startMode === mode ? "is-active" : ""}`}
                onClick={() => onChange({ startMode: mode })}
              >
                {mode === "ai" ? "AGENT" : "HELM"}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Agente CLI</h3>
          <div className="flex flex-wrap gap-2">
            {AGENTS.map((agent) => (
              <button
                key={agent.id}
                type="button"
                aria-pressed={prefs.agent === agent.id}
                className={`settings-choice ${prefs.agent === agent.id ? "is-active" : ""}`}
                onClick={() => onChange({ agent: agent.id })}
              >
                {agent.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--secondary)]">
            L'agente si apre nella modalità AGENT; la modifica vale dal prossimo avvio.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Aggiornamenti</h3>
          <label className="check-row">
            <input type="checkbox" checked={prefs.autoCheckUpdates} onChange={(event) => onChange({ autoCheckUpdates: event.target.checked })} />
            <span>Controlla automaticamente all'avvio</span>
          </label>
        </section>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <button type="button" className="text-[13px] text-[var(--warning)] hover:text-[var(--text)]" onClick={onReset}>
            Ripristina preferenze
          </button>
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}
