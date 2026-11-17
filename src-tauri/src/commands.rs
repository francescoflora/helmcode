use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::agent::delta::DeltaManager;
use crate::agent::{self, llm::AgentConfig};
use crate::fs_util::{self, DirEntry};
use crate::git::{self, GitStatus};
use crate::lsp::LspManager;
use crate::search::{self, FileMatch, SearchMatch, SearchOptions, SearchDocument, ReplaceRequest, ReplaceResult};
use crate::state::AppState;
use crate::tasks::{self, WorkspaceTasks};
use crate::watcher::{should_watch, WorkspaceWatcher};

type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> String {
    state.workspace_root().display().to_string()
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> CommandResult<Option<String>> {
    let picked = pick_folder_path(&app, "Scegli la cartella")?;
    Ok(picked.map(|path| path.display().to_string()))
}

#[tauri::command]
pub async fn open_workspace(app: AppHandle, path: String) -> CommandResult<String> {
    let canonical = dunce::canonicalize(&path).map_err(|error| error.to_string())?;
    if !canonical.is_dir() {
        return Err("la cartella selezionata non esiste".to_string());
    }
    apply_workspace(&app, canonical.clone())?;
    Ok(canonical.display().to_string())
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    parent: String,
    name: String,
    open: bool,
) -> CommandResult<String> {
    let name = validate_project_name(&name)?;
    let parent = dunce::canonicalize(&parent).map_err(|error| error.to_string())?;
    if !parent.is_dir() {
        return Err("la cartella padre non esiste".to_string());
    }
    let path = parent.join(name);
    if path.exists() {
        return Err("esiste già una cartella con questo nome".to_string());
    }
    std::fs::create_dir(&path).map_err(|error| error.to_string())?;
    let canonical = dunce::canonicalize(&path).map_err(|error| error.to_string())?;
    if open {
        apply_workspace(&app, canonical.clone())?;
    }
    Ok(canonical.display().to_string())
}

#[tauri::command]
pub fn open_new_window(workspace: Option<String>) -> CommandResult<()> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("impossibile trovare l'eseguibile: {error}"))?;
    let mut command = std::process::Command::new(exe);
    command
        .env_remove("DEV_WORKSPACE")
        .env_remove("HELMCODE_WORKSPACE")
        .env_remove("HELMCODE_START_EMPTY");
    if let Some(workspace) = workspace {
        let canonical = dunce::canonicalize(&workspace).map_err(|error| error.to_string())?;
        if !canonical.is_dir() {
            return Err("la cartella del progetto non esiste".into());
        }
        command.env("HELMCODE_WORKSPACE", canonical);
    } else {
        command.env("HELMCODE_START_EMPTY", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("impossibile aprire una nuova finestra: {error}"))
}

#[tauri::command]
pub fn startup_empty_requested() -> bool {
    std::env::var_os("HELMCODE_START_EMPTY").is_some()
}

fn pick_folder_path(app: &AppHandle, title: &str) -> CommandResult<Option<PathBuf>> {
    let picked = app.dialog().file().set_title(title).blocking_pick_folder();
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    let canonical = dunce::canonicalize(&path).map_err(|error| error.to_string())?;
    Ok(Some(canonical))
}

fn validate_project_name(name: &str) -> CommandResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("inserisci un nome per il progetto".to_string());
    }
    if name == "." || name == ".." || name.ends_with('.') || name.ends_with(' ') {
        return Err("nome progetto non valido".to_string());
    }
    if name.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err("il nome non può contenere caratteri speciali".to_string());
    }
    Ok(name.to_string())
}

#[tauri::command]
pub async fn list_directory(state: State<'_, AppState>, path: String) -> CommandResult<Vec<DirEntry>> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || {
        fs_util::list_entries(&workspace, &path).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_entry(state: State<'_, AppState>, expected_workspace: String, parent: String, name: String, is_dir: bool) -> CommandResult<DirEntry> {
    let workspace = state.workspace_root();
    if workspace != std::path::Path::new(&expected_workspace) { return Err("Il progetto è cambiato: riprova".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        fs_util::create_entry(&workspace, &parent, &name, is_dir).map_err(|error| format!("{error:#}"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_file_text(state: State<'_, AppState>, path: String) -> CommandResult<String> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || {
        fs_util::read_text(&workspace, &path).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_file(app: AppHandle, expected_workspace: String, path: String, content: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state.file_operations.lock().map_err(|_| "Operazione file non disponibile".to_string())?;
        let workspace = state.workspace.read().map_err(|_| "Progetto non disponibile".to_string())?;
        if workspace.as_path() != std::path::Path::new(&expected_workspace) {
            return Err("Il progetto è cambiato: riprova".into());
        }
        fs_util::write_text(&workspace, &path, &content).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    id: String,
    rows: u16,
    cols: u16,
    agent: Option<String>,
) -> CommandResult<()> {
    let workspace = app.state::<AppState>().workspace_root();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut manager = state
            .pty
            .lock()
            .map_err(|_| "terminali non disponibili".to_string())?;
        if state.workspace_root() != workspace {
            return Err("Il progetto è cambiato: riprova".into());
        }
        manager
            .create(&app, &id, &workspace, rows, cols, agent.as_deref())
            .map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_write(app: AppHandle, id: String, data: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut manager = state
            .pty
            .lock()
            .map_err(|_| "terminali non disponibili".to_string())?;
        manager.write(&id, &data).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    app: AppHandle,
    id: String,
    rows: u16,
    cols: u16,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut manager = state
            .pty
            .lock()
            .map_err(|_| "terminali non disponibili".to_string())?;
        manager
            .resize(&id, rows, cols)
            .map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_snapshot(app: AppHandle, id: String) -> CommandResult<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        Ok(state
            .pty
            .lock()
            .ok()
            .map(|manager| manager.snapshot(&id))
            .unwrap_or_default())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_close(app: AppHandle, id: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut manager = state
            .pty
            .lock()
            .map_err(|_| "terminali non disponibili".to_string())?;
        manager.close(&id);
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn accept_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    diff_id: String,
) -> CommandResult<String> {
    let workspace = state.workspace_root();
    let path = {
        let mut delta = state
            .delta
            .lock()
            .map_err(|_| "revisioni non disponibili".to_string())?;
        delta
            .accept(&workspace, &diff_id)
            .map_err(|error| error.to_string())?
    };
    let _ = app.emit(
        "diff-resolved",
        json!({ "id": diff_id, "path": path, "status": "accepted" }),
    );
    Ok(path)
}

#[tauri::command]
pub fn reject_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    diff_id: String,
) -> CommandResult<String> {
    let path = {
        let mut delta = state
            .delta
            .lock()
            .map_err(|_| "revisioni non disponibili".to_string())?;
        delta.reject(&diff_id).map_err(|error| error.to_string())?
    };
    let _ = app.emit(
        "diff-resolved",
        json!({ "id": diff_id, "path": path, "status": "rejected" }),
    );
    Ok(path)
}

#[tauri::command]
pub async fn run_agent_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
) -> CommandResult<()> {
    if prompt.trim().is_empty() {
        return Err("il prompt è vuoto".to_string());
    }
    if state.agent_busy.swap(true, Ordering::SeqCst) {
        return Err("l'agente è già in esecuzione".to_string());
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = agent::run(app_handle.clone(), prompt).await;
        if let Err(error) = result {
            agent::emit(
                &app_handle,
                json!({ "kind": "error", "message": error.to_string() }),
            );
        }
        app_handle
            .state::<AppState>()
            .agent_busy
            .store(false, Ordering::SeqCst);
        agent::emit(&app_handle, json!({ "kind": "done" }));
    });

    Ok(())
}

#[tauri::command]
pub fn get_agent_config() -> Value {
    AgentConfig::from_env().public_json()
}

#[tauri::command]
pub async fn search_text(
    state: State<'_, AppState>,
    query: String,
    case_sensitive: bool,
    options: Option<SearchOptions>,
    documents: Option<Vec<SearchDocument>>,
    replacement: Option<String>,
) -> CommandResult<Vec<SearchMatch>> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || {
        let options = options.unwrap_or(SearchOptions { case_sensitive, ..Default::default() });
        search::search_with_options(&workspace, &query, &options, &documents.unwrap_or_default(), replacement.as_deref(), 200)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn replace_text(app: AppHandle, expected_workspace: String, request: ReplaceRequest, documents: Vec<SearchDocument>) -> CommandResult<ReplaceResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state.file_operations.lock().map_err(|_| "Operazione file non disponibile".to_string())?;
        let workspace = state.workspace.read().map_err(|_| "Progetto non disponibile".to_string())?;
        if workspace.as_path() != std::path::Path::new(&expected_workspace) { return Err("Il progetto è cambiato: riprova".into()); }
        let result = search::replace(&workspace, &request, &documents).map_err(|error| format!("{error:#}"))?;
        let paths: Vec<_> = result.documents.iter().map(|doc| doc.path.clone()).collect();
        let _ = app.emit("fs-changed", json!({ "workspace": expected_workspace, "paths": paths }));
        Ok(result)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn search_files(state: State<'_, AppState>, query: String) -> CommandResult<Vec<FileMatch>> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || search::search_files(&workspace, &query, 200))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn workspace_tasks(state: State<'_, AppState>) -> WorkspaceTasks {
    tasks::detect(&state.workspace_root())
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> CommandResult<GitStatus> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || git::status(&workspace))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_open_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> CommandResult<()> {
    let workspace = state.workspace_root();
    tauri::async_runtime::spawn_blocking(move || {
        let (_,_,document)=lsp_document(&app,&workspace.to_string_lossy(),&path)?;
        if let Some(document)=document { document.sync(&text).map_err(|error|error.to_string())?; }
        Ok(())
    }).await.map_err(|error|error.to_string())?
}

fn lsp_document(app: &AppHandle, expected_workspace: &str, path: &str) -> CommandResult<(PathBuf, PathBuf, Option<crate::lsp::DocumentClient>)> {
    let state = app.state::<AppState>();
    let workspace = state.workspace_root();
    if workspace != std::path::Path::new(expected_workspace) { return Err("Il progetto è cambiato: riprova".into()); }
    let absolute = fs_util::resolve_workspace_path(&workspace, path).map_err(|error| error.to_string())?;
    let mut manager = state.lsp.lock().map_err(|_| "LSP non disponibile".to_string())?;
    if state.workspace_root() != workspace { return Err("Il progetto è cambiato: riprova".into()); }
    let document = manager.document(app, &workspace, &absolute).map_err(|error| format!("{error:#}"))?;
    Ok((workspace,absolute,document))
}

#[tauri::command]
pub async fn lsp_sync_file(app: AppHandle, expected_workspace: String, path: String, text: String) -> CommandResult<crate::lsp::LanguageStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = std::path::Path::new(&expected_workspace);
        let absolute = workspace.join(&path);
        match lsp_document(&app,&expected_workspace,&path) {
            Ok((workspace,absolute,Some(document))) => match document.sync(&text) {
                Ok(()) => Ok(crate::lsp::status_for(&workspace,&absolute,"ready",None)),
                Err(error) => Ok(crate::lsp::status_for(&workspace,&absolute,"error",Some(format!("{error:#}")))),
            },
            Ok((workspace,absolute,None)) => Ok(crate::lsp::status_for(&workspace,&absolute,"unsupported",None)),
            Err(message) if app.state::<AppState>().workspace_root() == workspace => Ok(crate::lsp::status_for(workspace,&absolute,"missing",Some(message))),
            Err(message) => Err(message),
        }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn lsp_completion(app: AppHandle, expected_workspace: String, path: String, text: String, line: u32, character: u32, trigger_character: Option<String>) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_,_,document) = lsp_document(&app,&expected_workspace,&path)?;
        match document {
            Some(document) => document.complete(&text,line,character,trigger_character.as_deref()).map_err(|error|format!("{error:#}")),
            None => Ok(Value::Null),
        }
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub async fn lsp_navigate(app: AppHandle, expected_workspace: String, path: String, text: String, line: u32, character: u32, kind: String) -> CommandResult<Vec<crate::lsp::NavigationTarget>> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_,_,document) = lsp_document(&app,&expected_workspace,&path)?;
        match document {
            Some(document) => document.navigate(&text,line,character,&kind).map_err(|error|format!("{error:#}")),
            None => Err("Nessun language server configurato per questo linguaggio".into()),
        }
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub async fn lsp_save_file(app: AppHandle, expected_workspace: String, path: String, text: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_,_,document) = lsp_document(&app,&expected_workspace,&path)?;
        if let Some(document) = document { document.save(&text).map_err(|error|format!("{error:#}"))?; }
        Ok(())
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub async fn lsp_close_file(app: AppHandle, expected_workspace: String, path: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<AppState>();
        let workspace=state.workspace_root();
        if workspace != std::path::Path::new(&expected_workspace) { return Ok(()); }
        let absolute=fs_util::resolve_workspace_path(&workspace,&path).map_err(|error|error.to_string())?;
        let manager=state.lsp.lock().map_err(|_|"LSP non disponibile".to_string())?;
        manager.close(&absolute).map_err(|error|error.to_string())
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub async fn lsp_read_target(app: AppHandle, expected_workspace: String, path: String) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<AppState>();
        if state.workspace_root() != std::path::Path::new(&expected_workspace) { return Err("Il progetto è cambiato: riprova".into()); }
        let manager=state.lsp.lock().map_err(|_|"LSP non disponibile".to_string())?;
        manager.read_target(std::path::Path::new(&path)).map_err(|error|format!("{error:#}"))
    }).await.map_err(|error|error.to_string())?
}

fn restart_watcher(
    app: &AppHandle,
    state: &AppState,
    workspace: &std::path::Path,
) -> anyhow::Result<()> {
    {
        let mut watcher = state
            .watcher
            .lock()
            .map_err(|_| anyhow::anyhow!("watcher non disponibile"))?;
        *watcher = None;
    }
    if should_watch(workspace) {
        let watcher = WorkspaceWatcher::start(app, workspace)?;
        let mut guard = state
            .watcher
            .lock()
            .map_err(|_| anyhow::anyhow!("watcher non disponibile"))?;
        *guard = Some(watcher);
    }
    Ok(())
}

fn apply_workspace(app: &AppHandle, workspace: PathBuf) -> CommandResult<()> {
    let state = app.state::<AppState>();
    state.set_workspace(workspace.clone());
    {
        let mut delta = state
            .delta
            .lock()
            .map_err(|_| "revisioni non disponibili".to_string())?;
        *delta = DeltaManager::new();
    }
    {
        let mut lsp = state
            .lsp
            .lock()
            .map_err(|_| "LSP non disponibile".to_string())?;
        *lsp = LspManager::new();
    }
    {
        let mut pty = state
            .pty
            .lock()
            .map_err(|_| "terminali non disponibili".to_string())?;
        pty.close_all();
    }
    if let Err(error) = restart_watcher(app, &state, &workspace) {
        eprintln!("watcher non avviato: {error}");
    }
    let _ = app.emit("workspace-changed", workspace.display().to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_project_name;

    #[test]
    fn accepts_plain_project_names() {
        assert_eq!(validate_project_name(" demo ").unwrap(), "demo");
        assert_eq!(validate_project_name("my-app_2").unwrap(), "my-app_2");
    }

    #[test]
    fn rejects_paths_and_windows_specials() {
        for name in ["", "  ", ".", "..", "a/b", "a\\b", "CON:", "a?", "bad."] {
            assert!(validate_project_name(name).is_err(), "{name}");
        }
    }
}
