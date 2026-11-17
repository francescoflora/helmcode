import { RobotIcon } from "./Icons";

export function AgentLoading({ agent = "opencode" }: { agent?: string }) {
  return (
    <div className="agent-loading" role="status" aria-live="polite">
      <div className="agent-loading-symbol" aria-hidden="true">
        <RobotIcon className="h-7 w-7" />
        <span className="agent-loading-spinner" />
      </div>
      <p className="agent-loading-title">Avvio di {agent}…</p>
      <p className="agent-loading-description">Preparazione dell’assistente per il tuo progetto.</p>
    </div>
  );
}
