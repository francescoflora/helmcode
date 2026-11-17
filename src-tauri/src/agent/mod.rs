pub mod delta;
pub mod llm;
pub mod tools;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::fs_util::{list_entries, read_text};
use crate::state::AppState;
use delta::DiffDecision;

const EVENT_OUTPUT_LIMIT: usize = 12_000;
const REVIEW_TIMEOUT: Duration = Duration::from_secs(300);

pub async fn run(app: AppHandle, prompt: String) -> Result<()> {
    let config = llm::AgentConfig::from_env();
    if config.mode == "live" {
        emit(
            &app,
            json!({ "kind": "notice", "text": format!("Agente live · {} · {}", config.model, config.base_url) }),
        );
        llm::run_live(&app, config, &prompt).await
    } else {
        emit(
            &app,
            json!({ "kind": "notice", "text": "Modalità mock: nessuna chiamata LLM. Imposta AGENT_MODE=live per usare OpenAI/Ollama." }),
        );
        run_mock(&app, &prompt).await
    }
}

async fn run_mock(app: &AppHandle, prompt: &str) -> Result<()> {
    emit(
        app,
        json!({ "kind": "message", "text": "Analizzo il workspace e preparo una proposta di modifica non distruttiva." }),
    );
    tokio::time::sleep(Duration::from_millis(250)).await;

    let listing = run_tool(app, "list_directory", json!({ "path": "." })).await?;
    emit(
        app,
        json!({ "kind": "message", "text": format!("Nel workspace ho trovato {} caratteri di elenco. Leggo un file di riferimento.", listing.len()) }),
    );

    let workspace = workspace_of(app);
    if workspace.join("package.json").exists() {
        let _ = run_tool(app, "read_file", json!({ "path": "package.json" })).await;
    }

    let _ = run_tool(
        app,
        "run_terminal_command",
        json!({ "command": "Get-Location | Select-Object -ExpandProperty Path" }),
    )
    .await;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let suffix = Uuid::new_v4().to_string();
    let short = suffix.split('-').next().unwrap_or("run");
    let file_path = format!("agent-notes/{timestamp}-{short}.md");
    let content = format!(
        "# helmcode — esecuzione mock\n\n- Prompt: {prompt}\n- Workspace: {}\n- Timestamp: {timestamp}\n\nQuesta nota è stata proposta dall'agente in modalità mock. Accettala per scriverla su disco, oppure scartala per verificare che il working tree resti invariato.\n",
        workspace.display()
    );

    let outcome = run_tool(
        app,
        "propose_edit",
        json!({ "path": file_path, "new_content": content }),
    )
    .await?;

    emit(app, json!({ "kind": "message", "text": outcome }));
    Ok(())
}

pub async fn run_tool(app: &AppHandle, tool: &str, args: Value) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    emit(
        app,
        json!({ "kind": "tool_call", "id": id, "tool": tool, "args": args }),
    );

    let result = execute_tool(app, tool, &args).await;
    match &result {
        Ok(output) => emit(
            app,
            json!({
                "kind": "tool_result",
                "id": id,
                "tool": tool,
                "ok": true,
                "output": truncate(output, EVENT_OUTPUT_LIMIT)
            }),
        ),
        Err(error) => emit(
            app,
            json!({
                "kind": "tool_result",
                "id": id,
                "tool": tool,
                "ok": false,
                "output": error.to_string()
            }),
        ),
    }
    result
}

async fn execute_tool(app: &AppHandle, tool: &str, args: &Value) -> Result<String> {
    let workspace = workspace_of(app);
    match tool {
        "read_file" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .context("parametro path mancante")?;
            let content = read_text(&workspace, path)?;
            Ok(truncate(&content, 64_000))
        }
        "list_directory" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
            let entries = list_entries(&workspace, path)?;
            Ok(serde_json::to_string_pretty(&entries)?)
        }
        "propose_edit" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .context("parametro path mancante")?;
            let content = args
                .get("new_content")
                .and_then(Value::as_str)
                .context("parametro new_content mancante")?;
            let (review, decision) = {
                let state = app.state::<AppState>();
                let mut delta = state
                    .delta
                    .lock()
                    .map_err(|_| anyhow!("stato delle revisioni non disponibile"))?;
                let proposed = delta.propose(&workspace, path, content.to_string())?;
                (proposed.review, proposed.decision)
            };
            app.emit("open-diff-review", &review)
                .context("impossibile aprire la revisione nella UI")?;

            match tokio::time::timeout(REVIEW_TIMEOUT, decision).await {
                Ok(Ok(DiffDecision::Accepted)) => Ok(format!(
                    "Modifica accettata e scritta su disco: {}",
                    review.file_path
                )),
                Ok(Ok(DiffDecision::Rejected)) => Ok(format!(
                    "Modifica scartata dall'utente: {}",
                    review.file_path
                )),
                Ok(Err(_)) => Ok(format!("Revisione annullata: {}", review.file_path)),
                Err(_) => {
                    let state = app.state::<AppState>();
                    if let Ok(mut delta) = state.delta.lock() {
                        let _ = delta.reject(&review.id);
                    }
                    let _ = app.emit(
                        "diff-resolved",
                        json!({ "id": review.id, "path": review.file_path, "status": "expired" }),
                    );
                    Ok(format!(
                        "Revisione scaduta dopo {}s: {}",
                        REVIEW_TIMEOUT.as_secs(),
                        review.file_path
                    ))
                }
            }
        }
        "run_terminal_command" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .context("parametro command mancante")?;
            let workspace = workspace.clone();
            let command = command.to_string();
            let result = tokio::task::spawn_blocking(move || {
                crate::pty::session::run_command_blocking(
                    &workspace,
                    &command,
                    Duration::from_secs(120),
                )
            })
            .await
            .context("esecuzione del comando interrotta")??;
            Ok(format!(
                "exit={}\n{}",
                result
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "?".to_string()),
                result.output
            ))
        }
        other => bail!("tool non registrata: {other}"),
    }
}

fn workspace_of(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().workspace_root()
}

pub fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("agent-event", payload);
}

fn truncate(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[output troncato]", &value[..end])
}
