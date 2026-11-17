use std::env;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::tools::tool_definitions;
use super::{emit, run_tool};

const SYSTEM_PROMPT: &str = "Sei l'agente di helmcode, un IDE desktop per lo sviluppo supervisionato. \
Lavori su un workspace Windows. Tutti i percorsi dei tool sono relativi alla radice del workspace. \
Non inventare mai il contenuto di un file: usa read_file prima di modificarlo. \
Ogni modifica deve passare da propose_edit con il contenuto completo del file; non dichiarare di aver scritto un file se non l'hai proposto. \
Usa list_directory per esplorare e run_terminal_command per build, test e linter. Non avviare sessioni interattive o programmi a lunga esecuzione. \
Quando hai finito, scrivi un riepilogo conciso in italiano di cosa hai proposto e di cosa resta da fare.";

#[derive(Clone)]
pub struct AgentConfig {
    pub mode: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

impl AgentConfig {
    pub fn from_env() -> Self {
        let mode = env::var("AGENT_MODE")
            .map(|value| value.to_lowercase())
            .unwrap_or_else(|_| "mock".to_string());
        let base_url = env::var("OPENAI_BASE_URL")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string())
            .trim_end_matches('/')
            .to_string();
        let default_model = if base_url.contains("11434") {
            "qwen2.5-coder"
        } else {
            "gpt-4o-mini"
        };
        let model = env::var("AGENT_MODEL").unwrap_or_else(|_| default_model.to_string());
        let api_key = env::var("OPENAI_API_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        Self {
            mode: if mode == "live" {
                "live".to_string()
            } else {
                "mock".to_string()
            },
            base_url,
            model,
            api_key,
        }
    }

    pub fn public_json(&self) -> Value {
        json!({
            "mode": self.mode,
            "baseUrl": self.base_url,
            "model": self.model,
            "hasKey": self.api_key.is_some()
        })
    }
}

pub async fn run_live(app: &AppHandle, config: AgentConfig, prompt: &str) -> Result<()> {
    if config.api_key.is_none() && config.base_url.contains("api.openai.com") {
        bail!("OPENAI_API_KEY mancante: impossibile usare l'endpoint OpenAI in modalità live");
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .context("impossibile creare il client HTTP")?;

    let mut messages = vec![
        json!({ "role": "system", "content": SYSTEM_PROMPT }),
        json!({ "role": "user", "content": prompt }),
    ];

    for _ in 0..12 {
        let body = json!({
            "model": config.model,
            "messages": messages,
            "tools": tool_definitions(),
            "tool_choice": "auto"
        });

        let mut request = client
            .post(format!("{}/chat/completions", config.base_url))
            .json(&body);
        if let Some(key) = &config.api_key {
            request = request.bearer_auth(key);
        }

        let response = request
            .send()
            .await
            .context("richiesta al provider LLM fallita")?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!(
                "il provider LLM ha risposto {}: {}",
                status,
                truncate(&raw, 800)
            );
        }

        let payload: Value =
            serde_json::from_str(&raw).context("risposta del provider LLM non valida")?;
        let message = payload
            .pointer("/choices/0/message")
            .cloned()
            .context("risposta del provider LLM priva di message")?;

        if let Some(content) = message.get("content").and_then(Value::as_str) {
            if !content.trim().is_empty() {
                emit(
                    app,
                    json!({ "kind": "message", "text": truncate(content, 16_000) }),
                );
            }
        }

        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        messages.push(message);

        if tool_calls.is_empty() {
            return Ok(());
        }

        for call in tool_calls {
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("call")
                .to_string();
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));

            let content = match run_tool(app, &name, args).await {
                Ok(output) => output,
                Err(error) => format!("errore: {error}"),
            };
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": truncate(&content, 64_000)
            }));
        }
    }

    bail!("limite di 12 iterazioni raggiunto senza una risposta finale del modello")
}

fn truncate(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}
