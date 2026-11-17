use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Legge il contenuto testuale di un file relativo al workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Percorso relativo, es. src/App.tsx" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "propose_edit",
                "description": "Propone una modifica a un file. Non scrive su disco: crea una revisione che l'utente deve accettare.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Percorso relativo del file" },
                        "new_content": { "type": "string", "description": "Contenuto completo proposto per il file" }
                    },
                    "required": ["path", "new_content"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_terminal_command",
                "description": "Esegue un comando PowerShell nella cartella del workspace e restituisce output ed exit code.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Comando PowerShell da eseguire" }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "Elenca file e cartelle di un percorso relativo al workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Cartella relativa, es. . oppure src" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }
            }
        }
    ])
}
