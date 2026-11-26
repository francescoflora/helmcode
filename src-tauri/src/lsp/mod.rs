mod file_changes;
mod installer;
mod languages;
pub use file_changes::{FileMove, OpenDocument};
pub use installer::{install_server, InstallableServer};
#[cfg(test)]
#[path = "tests.rs"]
mod protocol_tests;

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

use languages::{language_for, Language};

type Reply = std::result::Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>;
type Registrations = Arc<Mutex<HashMap<String, Value>>>;
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

pub struct LspManager {
    clients: HashMap<String, Arc<LspClient>>,
    failures: HashMap<String, (Instant, String)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStatus {
    pub language: String,
    pub state: &'static str,
    pub message: Option<String>,
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installable: Option<InstallableServer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationTarget {
    pub path: String,
    pub line: u64,
    pub column: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub external: bool,
}

pub struct DocumentClient {
    client: Arc<LspClient>,
    language: Language,
    path: PathBuf,
}

impl Default for LspManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
            failures: HashMap::new(),
        }
    }

    /// Only process creation holds the manager lock. Initialization and all RPC
    /// waits happen on an independent client, so project changes stay responsive.
    pub fn document(
        &mut self,
        app: &AppHandle,
        workspace: &Path,
        path: &Path,
    ) -> Result<Option<DocumentClient>> {
        let Some(language) = language_for(workspace, path)? else {
            return Ok(None);
        };
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        (
            &language.command,
            &language.args,
            language.initialization_options.to_string(),
            language.settings.to_string(),
        )
            .hash(&mut fingerprint);
        let key = format!("{}:{}", language.key, fingerprint.finish());
        let prefix = format!("{}:", language.key);
        let obsolete: Vec<String> = self
            .clients
            .keys()
            .filter(|existing| existing.starts_with(&prefix) && **existing != key)
            .cloned()
            .collect();
        for old_key in obsolete {
            if let Some(client) = self.clients.remove(&old_key) {
                client.stop();
            }
        }
        if self.clients.get(&key).is_some_and(|client| {
            (!client.alive.load(Ordering::SeqCst)
                && client.created_at.elapsed() >= Duration::from_secs(10))
                || (path.is_file()
                    && file_uri(path).ok().is_some_and(|uri| {
                        client
                            .retired_paths
                            .lock()
                            .map(|retired| retired.contains(&uri))
                            .unwrap_or(false)
                    }))
        }) {
            self.clients.remove(&key);
        }
        if let Some((when, message)) = self.failures.get(&key) {
            if when.elapsed() < Duration::from_secs(10) {
                bail!("{message}");
            }
        }
        if !self.clients.contains_key(&key) {
            match LspClient::spawn(app, workspace, &language) {
                Ok(client) => {
                    self.failures.remove(&key);
                    self.clients.insert(key.clone(), Arc::new(client));
                }
                Err(error) => {
                    let message = format!("Language server {} non disponibile ({}). Installa il server nel PATH o configuralo in .helmcode/languages.json. {error:#}", language.language_id, language.command);
                    self.failures
                        .insert(key.clone(), (Instant::now(), message.clone()));
                    bail!(message);
                }
            }
        }
        Ok(Some(DocumentClient {
            client: self
                .clients
                .get(&key)
                .context("client LSP non disponibile")?
                .clone(),
            language,
            path: path.to_path_buf(),
        }))
    }

    pub fn close(&self, path: &Path) -> Result<()> {
        for client in self.clients.values() {
            client.close(path)?;
        }
        Ok(())
    }

    pub fn clear_failures(&mut self) {
        self.failures.clear();
    }

    pub fn read_target(&self, path: &Path) -> Result<String> {
        let canonical = dunce::canonicalize(path).context("destinazione non disponibile")?;
        let authorized = self.clients.values().any(|client| {
            client
                .targets
                .lock()
                .map(|targets| targets.contains(&canonical))
                .unwrap_or(false)
        });
        if !authorized {
            bail!("destinazione non restituita da un language server del progetto corrente");
        }
        let metadata = std::fs::metadata(&canonical)?;
        if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
            bail!("destinazione non leggibile o troppo grande");
        }
        std::fs::read_to_string(canonical).context("destinazione non leggibile come testo UTF-8")
    }

    pub fn virtual_target(&self, uri: &str) -> Result<VirtualTargetClient> {
        if !is_virtual_jdt_uri(uri) {
            bail!("destinazione virtuale non supportata");
        }
        let client = self
            .clients
            .values()
            .find(|client| {
                client
                    .virtual_targets
                    .lock()
                    .map(|targets| targets.contains(uri))
                    .unwrap_or(false)
            })
            .cloned()
            .context("destinazione non restituita da un language server del progetto corrente")?;
        Ok(VirtualTargetClient { client })
    }
}

pub struct VirtualTargetClient {
    client: Arc<LspClient>,
}

impl VirtualTargetClient {
    pub fn read(&self, uri: &str) -> Result<String> {
        self.client.read_virtual_target(uri)
    }
}

pub fn is_virtual_jdt_uri(uri: &str) -> bool {
    uri.starts_with("jdt://")
}

impl Drop for LspManager {
    fn drop(&mut self) {
        for client in self.clients.values() {
            client.stop();
        }
    }
}

pub fn status_for(
    workspace: &Path,
    path: &Path,
    state: &'static str,
    message: Option<String>,
) -> LanguageStatus {
    match language_for(workspace, path) {
        Ok(Some(language)) => LanguageStatus {
            language: language.language_id,
            state,
            message,
            server: Some(language.command),
            installable: if state == "missing" {
                installer::installable_for_key(&language.key)
            } else {
                None
            },
        },
        Ok(None) => LanguageStatus {
            language: path.extension().unwrap_or_default().to_string_lossy().into_owned(),
            state: "unsupported",
            message: Some("Nessun language server configurato. I suggerimenti locali restano disponibili; puoi aggiungere un server in .helmcode/languages.json.".into()),
            server: None,
            installable: None,
        },
        Err(error) => LanguageStatus {
            language: String::new(),
            state: "error",
            message: Some(format!("{error:#}")),
            server: None,
            installable: None,
        },
    }
}

impl DocumentClient {
    fn request(&self, text: &str, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        // A background sync must not slip between this snapshot and its request.
        // Release the buffer lock immediately after enqueueing, before waiting.
        let mut documents = self
            .client
            .documents
            .lock()
            .map_err(|_| anyhow!("documenti LSP bloccati"))?;
        self.client
            .sync_document(&mut documents, &self.path, &self.language.language_id, text)?;
        let (id, receiver) = self.client.begin_request(method, params)?;
        drop(documents);
        self.client.await_response(id, receiver, method, timeout)
    }

    pub fn sync(&self, text: &str) -> Result<()> {
        self.client.initialize(&self.language)?;
        self.client
            .sync(&self.path, &self.language.language_id, text)
    }

    pub fn complete(
        &self,
        text: &str,
        line: u32,
        character: u32,
        trigger: Option<&str>,
    ) -> Result<Value> {
        self.client.initialize(&self.language)?;
        let capabilities = self.client.capabilities()?;
        if capabilities
            .get("completionProvider")
            .is_some_and(|value| value == &Value::Bool(false))
        {
            return Ok(Value::Null);
        }
        let mut context = json!({"triggerKind": 1});
        if let Some(trigger) = trigger {
            let recognized = capabilities
                .pointer("/completionProvider/triggerCharacters")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(trigger)));
            if recognized {
                context = json!({"triggerKind": 2,"triggerCharacter": trigger});
            }
        }
        self.request(text, "textDocument/completion", json!({
            "textDocument": {"uri": file_uri(&self.path)?}, "position": {"line": line,"character": character}, "context": context
        }), Duration::from_secs(8))
    }

    pub fn navigate(
        &self,
        text: &str,
        line: u32,
        character: u32,
        kind: &str,
    ) -> Result<Vec<NavigationTarget>> {
        if !["auto", "definition", "declaration", "implementation"].contains(&kind) {
            bail!("tipo di navigazione non valido");
        }
        self.client.initialize(&self.language)?;
        let capabilities = self.client.capabilities()?;
        let result = if kind == "auto" {
            self.contextual_navigation(text, line, character, &capabilities)?
        } else {
            let primary = self.navigation_request(text, line, character, kind, &capabilities)?;
            if kind == "definition" && location_values(&primary).is_empty() {
                self.navigation_request(text, line, character, "declaration", &capabilities)?
            } else {
                primary
            }
        };
        let (targets, authorized, virtual_authorized, unsupported_uri) =
            navigation_targets(&self.client.workspace, &result);
        self.client
            .targets
            .lock()
            .map_err(|_| anyhow!("destinazioni LSP bloccate"))?
            .extend(authorized);
        self.client
            .virtual_targets
            .lock()
            .map_err(|_| anyhow!("destinazioni virtuali LSP bloccate"))?
            .extend(virtual_authorized);
        if targets.is_empty() && unsupported_uri {
            bail!("Il server ha restituito una sorgente virtuale o un archivio che non può essere aperto come file.");
        }
        Ok(targets)
    }

    fn navigation_request(
        &self,
        text: &str,
        line: u32,
        character: u32,
        method: &str,
        capabilities: &Value,
    ) -> Result<Value> {
        if capabilities
            .get(format!("{method}Provider"))
            .is_some_and(|value| value == &Value::Bool(false))
        {
            return Ok(Value::Null);
        }
        match self.request(text, &format!("textDocument/{method}"), json!({
            "textDocument": {"uri":file_uri(&self.path)?}, "position":{"line":line,"character":character}
        }), Duration::from_secs(15)) {
            Err(error) if error.to_string().contains("-32601") => Ok(Value::Null),
            result => result,
        }
    }

    fn contextual_navigation(
        &self,
        text: &str,
        line: u32,
        character: u32,
        capabilities: &Value,
    ) -> Result<Value> {
        let mut symbols = None;
        let mut definition =
            self.navigation_request(text, line, character, "definition", capabilities)?;
        let mut declaration_queried = false;
        if location_values(&definition).is_empty() {
            definition =
                self.navigation_request(text, line, character, "declaration", capabilities)?;
            declaration_queried = true;
        }
        let elsewhere = self.distinct_locations(
            &definition,
            text,
            line,
            character,
            capabilities,
            &mut symbols,
        );
        if !elsewhere.is_empty() {
            return Ok(Value::Array(elsewhere));
        }

        // At a declaration/signature, follow the semantic implementation link.
        // The same logic also handles servers with no definition support.
        let implementations =
            self.navigation_request(text, line, character, "implementation", capabilities)?;
        let elsewhere = self.distinct_locations(
            &implementations,
            text,
            line,
            character,
            capabilities,
            &mut symbols,
        );
        if !elsewhere.is_empty() {
            return Ok(Value::Array(elsewhere));
        }
        if !declaration_queried {
            let declarations =
                self.navigation_request(text, line, character, "declaration", capabilities)?;
            let elsewhere = self.distinct_locations(
                &declarations,
                text,
                line,
                character,
                capabilities,
                &mut symbols,
            );
            if !elsewhere.is_empty() {
                return Ok(Value::Array(elsewhere));
            }
        }
        Ok(Value::Null)
    }

    fn distinct_locations(
        &self,
        value: &Value,
        text: &str,
        line: u32,
        character: u32,
        capabilities: &Value,
        symbols: &mut Option<Value>,
    ) -> Vec<Value> {
        let cursor = SymbolPosition {
            line: u64::from(line),
            character: u64::from(character),
        };
        let token = identifier_range(text, cursor);
        let locations = location_values(value);
        let has_ambiguous = locations.iter().any(|location| {
            self_location(location, &self.path, cursor, token, None) == SelfLocation::Ambiguous
        });
        if has_ambiguous && symbols.is_none() {
            let available = capabilities
                .get("documentSymbolProvider")
                .is_some_and(|value| value != &Value::Bool(false) && !value.is_null());
            // Symbol ranges distinguish a declaration's name from references in
            // its body. This optional request never turns a broad range alone
            // into a declaration heuristic.
            *symbols = Some(if available {
                self.request(
                    text,
                    "textDocument/documentSymbol",
                    json!({"textDocument":{"uri":file_uri(&self.path).unwrap_or_default()}}),
                    Duration::from_secs(5),
                )
                .unwrap_or(Value::Null)
            } else {
                Value::Null
            });
        }
        locations
            .into_iter()
            .filter(|location| {
                self_location(location, &self.path, cursor, token, symbols.as_ref())
                    != SelfLocation::Yes
            })
            .cloned()
            .collect()
    }

    pub fn save(&self, text: &str) -> Result<()> {
        self.client.initialize(&self.language)?;
        let capabilities = self.client.capabilities()?;
        let save = capabilities.pointer("/textDocumentSync/save");
        if save.is_some_and(|value| value == &Value::Bool(false)) {
            return Ok(());
        }
        let mut documents = self
            .client
            .documents
            .lock()
            .map_err(|_| anyhow!("documenti LSP bloccati"))?;
        self.client
            .sync_document(&mut documents, &self.path, &self.language.language_id, text)?;
        self.client.notify(
            "textDocument/didSave",
            json!({"textDocument":{"uri":file_uri(&self.path)?},"text":text}),
        )
    }
}

struct Document {
    version: u64,
    text: String,
}

struct LspClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    pending: Pending,
    registrations: Registrations,
    retired_paths: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    initialization: Mutex<Option<Reply>>,
    documents: Mutex<HashMap<String, Document>>,
    targets: Mutex<HashSet<PathBuf>>,
    virtual_targets: Mutex<HashSet<String>>,
    workspace: PathBuf,
    created_at: Instant,
}

impl LspClient {
    fn spawn(app: &AppHandle, workspace: &Path, language: &Language) -> Result<Self> {
        let mut command = server_command(workspace, &language.command, &language.args)?;
        command
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().context("avvio del processo LSP fallito")?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().context("stdin LSP non disponibile")?,
        ));
        let stdout = child.stdout.take().context("stdout LSP non disponibile")?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let registrations = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let client = Self {
            stdin: stdin.clone(),
            child: Mutex::new(child),
            pending: pending.clone(),
            registrations: registrations.clone(),
            retired_paths: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            alive: alive.clone(),
            initialization: Mutex::new(None),
            documents: Mutex::new(HashMap::new()),
            targets: Mutex::new(HashSet::new()),
            virtual_targets: Mutex::new(HashSet::new()),
            workspace: workspace.to_path_buf(),
            created_at: Instant::now(),
        };
        let app = app.clone();
        let workspace = workspace.to_path_buf();
        let settings = language.settings.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = read_message(&mut reader) {
                route_message(
                    &message,
                    &pending,
                    &stdin,
                    &workspace,
                    &settings,
                    &registrations,
                    |params| {
                        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                            return;
                        };
                        let Some(path) = uri_path(uri) else { return };
                        let Ok(relative) = path.strip_prefix(&workspace) else {
                            return;
                        };
                        let _ = app.emit("lsp-diagnostics", json!({"workspace": workspace.to_string_lossy(),"uri": uri,"path": relative.to_string_lossy().replace('\\', "/"),"diagnostics":params.get("diagnostics").cloned().unwrap_or_else(||json!([]))}));
                    },
                );
            }
            alive.store(false, Ordering::SeqCst);
            fail_pending(&pending, "Il language server si è chiuso");
        });
        Ok(client)
    }

    fn initialize(&self, language: &Language) -> Result<()> {
        self.initialize_with_timeout(language, Duration::from_secs(45))
    }

    fn initialize_with_timeout(&self, language: &Language, timeout: Duration) -> Result<()> {
        let mut initialized = self
            .initialization
            .lock()
            .map_err(|_| anyhow!("inizializzazione LSP bloccata"))?;
        if initialized.is_none() {
            let result = (|| -> Result<Value> {
                let root_uri = Url::from_directory_path(&self.workspace).map_err(|_| anyhow!("workspace non convertibile in URI"))?.to_string();
                let result = self.request("initialize", json!({
                    "processId": std::process::id(), "clientInfo":{"name":"helmcode","version":env!("CARGO_PKG_VERSION")},
                    "rootUri":root_uri,"workspaceFolders":[{"uri":root_uri,"name":self.workspace.file_name().unwrap_or_default().to_string_lossy()}],
                    "capabilities":{
                        "general":{"positionEncodings":["utf-16"]},
                        "workspace":{"configuration":true,"workspaceFolders":true,
                            "workspaceEdit":{"documentChanges":true,"resourceOperations":["rename"],"failureHandling":"transactional"},
                            "fileOperations":{"dynamicRegistration":true,"willRename":true,"didRename":true,"didDelete":true}},
                        "textDocument":{
                            "synchronization":{"didSave":true,"dynamicRegistration":false},
                            "publishDiagnostics":{"relatedInformation":true},
                            "completion":{"completionItem":{"snippetSupport":true,"documentationFormat":["plaintext"],"insertReplaceSupport":true},"contextSupport":true},
                            "rename":{"dynamicRegistration":true,"prepareSupport":true,"prepareSupportDefaultBehavior":1},
                            "definition":{"linkSupport":true},"declaration":{"linkSupport":true},"implementation":{"linkSupport":true}
                            ,"documentSymbol":{"hierarchicalDocumentSymbolSupport":true}
                        }
                    },"initializationOptions":language.initialization_options
                }), timeout)?;
                if result.pointer("/capabilities/positionEncoding").and_then(Value::as_str).is_some_and(|encoding| encoding != "utf-16") { bail!("Il server richiede una codifica delle posizioni diversa da UTF-16"); }
                self.notify("initialized", json!({}))?;
                self.notify("workspace/didChangeConfiguration", json!({"settings":language.settings}))?;
                Ok(result.get("capabilities").cloned().unwrap_or_else(|| json!({})))
            })().map_err(|error| format!("{error:#}"));
            if result.is_err() {
                self.stop();
            }
            *initialized = Some(result);
        }
        initialized
            .as_ref()
            .expect("inizializzazione impostata")
            .as_ref()
            .map(|_| ())
            .map_err(|message| anyhow!(message.clone()))
    }

    fn capabilities(&self) -> Result<Value> {
        self.initialization
            .lock()
            .map_err(|_| anyhow!("inizializzazione LSP bloccata"))?
            .as_ref()
            .context("server non inizializzato")?
            .as_ref()
            .cloned()
            .map_err(|message| anyhow!(message.clone()))
    }

    fn sync(&self, path: &Path, language_id: &str, text: &str) -> Result<()> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| anyhow!("documenti LSP bloccati"))?;
        self.sync_document(&mut documents, path, language_id, text)
    }

    fn sync_document(
        &self,
        documents: &mut HashMap<String, Document>,
        path: &Path,
        language_id: &str,
        text: &str,
    ) -> Result<()> {
        let uri = file_uri(path)?;
        if self
            .retired_paths
            .lock()
            .map_err(|_| anyhow!("documenti ritirati LSP bloccati"))?
            .contains(&uri)
        {
            bail!("Il file è stato spostato o eliminato");
        }
        if let Some(document) = documents.get_mut(&uri) {
            if document.text == text {
                return Ok(());
            }
            let version = document.version + 1;
            let capabilities = self.capabilities()?;
            let kind = capabilities
                .pointer("/textDocumentSync/change")
                .or_else(|| capabilities.get("textDocumentSync"))
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let changes = if kind == 2 {
                json!([incremental_change(&document.text, text)])
            } else {
                json!([{"text":text}])
            };
            self.notify(
                "textDocument/didChange",
                json!({"textDocument":{"uri":uri,"version":version},"contentChanges":changes}),
            )?;
            document.version = version;
            document.text = text.to_string();
        } else {
            self.notify("textDocument/didOpen", json!({"textDocument":{"uri":uri,"languageId":language_id,"version":1,"text":text}}))?;
            documents.insert(
                uri,
                Document {
                    version: 1,
                    text: text.to_string(),
                },
            );
        }
        Ok(())
    }

    fn close(&self, path: &Path) -> Result<()> {
        let uri = file_uri(path)?;
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| anyhow!("documenti LSP bloccati"))?;
        if documents.remove(&uri).is_some() && self.alive.load(Ordering::SeqCst) {
            self.notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))?;
        }
        Ok(())
    }

    fn read_virtual_target(&self, uri: &str) -> Result<String> {
        let result = self.request(
            "java/classFileContents",
            json!({ "uri": uri }),
            Duration::from_secs(15),
        )?;
        let Some(text) = result.as_str() else {
            bail!("contenuto della classe non disponibile dal language server");
        };
        if text.len() > 2 * 1024 * 1024 {
            bail!("destinazione non leggibile o troppo grande");
        }
        Ok(text.to_owned())
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let (id, receiver) = self.begin_request(method, params)?;
        self.await_response(id, receiver, method, timeout)
    }

    fn begin_request(&self, method: &str, params: Value) -> Result<(u64, mpsc::Receiver<Reply>)> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        let mut pending = self.pending
            .lock()
            .map_err(|_| anyhow!("richieste LSP bloccate"))?;
        // Shutdown marks the client dead before draining this same map. Keep
        // registration atomic with that check so no waiter can be added later.
        if !self.alive.load(Ordering::SeqCst) {
            bail!("Il language server non è in esecuzione");
        }
        pending.insert(id, sender);
        drop(pending);
        if let Err(error) = write_message(
            &self.stdin,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        ) {
            self.pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&id));
            return Err(error);
        }
        Ok((id, receiver))
    }

    fn await_response(
        &self,
        id: u64,
        receiver: mpsc::Receiver<Reply>,
        method: &str,
        timeout: Duration,
    ) -> Result<Value> {
        match receiver.recv_timeout(timeout) {
            Ok(result) => result.map_err(|message| anyhow!(message)),
            Err(_) => {
                self.pending
                    .lock()
                    .ok()
                    .map(|mut pending| pending.remove(&id));
                let _ = self.notify("$/cancelRequest", json!({"id":id}));
                bail!("Tempo di attesa scaduto per {method}");
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<()> {
        write_message(
            &self.stdin,
            &json!({"jsonrpc":"2.0","method":method,"params":params}),
        )
    }

    fn stop(&self) {
        self.alive.store(false, Ordering::SeqCst);
        fail_pending(&self.pending, "Sessione LSP terminata o progetto cambiato");
        if let Ok(mut child) = self.child.lock() {
            #[cfg(windows)]
            if matches!(child.try_wait(), Ok(None)) {
                use std::os::windows::process::CommandExt;
                // npm and jdtls launchers can own another process. Terminate the
                // complete tree so a workspace switch leaves no orphan servers.
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        self.stop();
    }
}

fn file_uri(path: &Path) -> Result<String> {
    Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|_| anyhow!("percorso non convertibile in URI: {}", path.display()))
}

fn uri_path(uri: &str) -> Option<PathBuf> {
    Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()
        .and_then(|path| dunce::canonicalize(&path).ok().or(Some(path)))
}

fn end_position(text: &str) -> Value {
    let mut line = 0;
    let mut tail = 0;
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\r' {
            line += 1;
            tail = index + 1;
        } else if *byte == b'\n' {
            if index == 0 || bytes[index - 1] != b'\r' {
                line += 1;
            }
            tail = index + 1;
        }
    }
    json!({"line":line,"character":text[tail..].encode_utf16().count()})
}

/// Retain the unchanged prefix/suffix so a keystroke does not send the entire
/// document to an incremental server. Ranges must stay on Unicode boundaries
/// and may not address the middle of a CRLF line ending.
fn incremental_change(before: &str, after: &str) -> Value {
    let mut start = before
        .bytes()
        .zip(after.bytes())
        .take_while(|(before, after)| before == after)
        .count();
    while !before.is_char_boundary(start) || !after.is_char_boundary(start) {
        start -= 1;
    }
    let splits_crlf = |text: &str, offset: usize| {
        offset > 0
            && text.as_bytes().get(offset - 1) == Some(&b'\r')
            && text.as_bytes().get(offset) == Some(&b'\n')
    };
    if splits_crlf(before, start) || splits_crlf(after, start) {
        start -= 1;
    }

    let suffix = before[start..]
        .bytes()
        .rev()
        .zip(after[start..].bytes().rev())
        .take_while(|(before, after)| before == after)
        .count();
    let mut before_end = before.len() - suffix;
    let mut after_end = after.len() - suffix;
    while !before.is_char_boundary(before_end) || !after.is_char_boundary(after_end) {
        before_end += 1;
        after_end += 1;
    }
    if splits_crlf(before, before_end) || splits_crlf(after, after_end) {
        before_end += 1;
        after_end += 1;
    }
    json!({
        "range": {"start": end_position(&before[..start]), "end": end_position(&before[..before_end])},
        "text": &after[start..after_end]
    })
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SymbolPosition {
    line: u64,
    character: u64,
}

impl SymbolPosition {
    fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            line: value.get("line")?.as_u64()?,
            character: value.get("character")?.as_u64()?,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SymbolRange {
    start: SymbolPosition,
    end: SymbolPosition,
}

impl SymbolRange {
    fn parse(value: &Value) -> Option<Self> {
        let range = Self {
            start: SymbolPosition::parse(value.get("start")?)?,
            end: SymbolPosition::parse(value.get("end")?)?,
        };
        (range.start <= range.end).then_some(range)
    }

    fn contains(self, position: SymbolPosition) -> bool {
        self.start <= position
            && (position < self.end || self.start == self.end && position == self.start)
    }

    fn contains_range(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }

    fn contains_click(self, position: SymbolPosition, token: Option<Self>) -> bool {
        self.contains(position)
            || token.is_some_and(|token| {
                position == token.end && position == self.end && self.start >= token.start
            })
    }

    fn distance(self, other: Self) -> (u64, u64) {
        (
            self.start
                .line
                .abs_diff(other.start.line)
                .saturating_add(self.end.line.abs_diff(other.end.line)),
            self.start
                .character
                .abs_diff(other.start.character)
                .saturating_add(self.end.character.abs_diff(other.end.character)),
        )
    }
}

fn identifier_range(text: &str, cursor: SymbolPosition) -> Option<SymbolRange> {
    let line = text.split('\n').nth(usize::try_from(cursor.line).ok()?)?;
    let mut start = None;
    let mut offset = 0u64;
    for character in line.chars().chain(std::iter::once(' ')) {
        let identifier = character.is_alphanumeric()
            || matches!(character, '_' | '$' | '\u{200c}' | '\u{200d}')
            || ('\u{0300}'..='\u{036f}').contains(&character);
        if identifier {
            start.get_or_insert(offset);
        } else if let Some(start) = start.take() {
            if start <= cursor.character && cursor.character <= offset {
                return Some(SymbolRange {
                    start: SymbolPosition {
                        line: cursor.line,
                        character: start,
                    },
                    end: SymbolPosition {
                        line: cursor.line,
                        character: offset,
                    },
                });
            }
        }
        offset += character.len_utf16() as u64;
    }
    None
}

fn location_values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(values) => values.iter().collect(),
        Value::Null => Vec::new(),
        value => vec![value],
    }
}

#[derive(Eq, PartialEq)]
enum SelfLocation {
    Yes,
    No,
    Ambiguous,
}

fn same_file(left: &Path, right: &Path) -> bool {
    let left = dunce::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = dunce::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn self_location(
    location: &Value,
    source: &Path,
    cursor: SymbolPosition,
    token: Option<SymbolRange>,
    symbols: Option<&Value>,
) -> SelfLocation {
    let Some(path) = location
        .get("targetUri")
        .or_else(|| location.get("uri"))
        .and_then(Value::as_str)
        .and_then(uri_path)
    else {
        return SelfLocation::No;
    };
    if !same_file(&path, source) {
        return SelfLocation::No;
    }
    let selection = location.get("targetSelectionRange");
    let Some(range) = selection
        .or_else(|| location.get("range"))
        .and_then(SymbolRange::parse)
    else {
        return SelfLocation::No;
    };
    if !range.contains_click(cursor, token) {
        return SelfLocation::No;
    }
    if selection.is_some() || token.is_some_and(|token| token.contains(range.start)) {
        return SelfLocation::Yes;
    }
    let Some(symbols) = symbols else {
        return SelfLocation::Ambiguous;
    };
    let mut candidates = Vec::new();
    document_symbol_ranges(symbols, &mut candidates);
    // Prefer an exact full symbol range. For servers returning only a signature
    // or including annotations, choose the nearest comparable semantic range.
    // Nested names cannot turn a class body's references into its declaration.
    let candidate = candidates
        .into_iter()
        .filter(|(symbol, selection)| {
            range.contains_range(*selection)
                && (symbol.contains_range(range) || range.contains_range(*symbol))
        })
        .min_by_key(|(symbol, _)| range.distance(*symbol));
    if candidate.is_some_and(|(_, selection)| selection.contains_click(cursor, token)) {
        SelfLocation::Yes
    } else {
        SelfLocation::No
    }
}

fn document_symbol_ranges(value: &Value, ranges: &mut Vec<(SymbolRange, SymbolRange)>) {
    if let Some(values) = value.as_array() {
        for value in values {
            document_symbol_ranges(value, ranges);
        }
        return;
    }
    if let (Some(range), Some(selection)) = (
        value.get("range").and_then(SymbolRange::parse),
        value.get("selectionRange").and_then(SymbolRange::parse),
    ) {
        ranges.push((range, selection));
    }
    if let Some(children) = value.get("children") {
        document_symbol_ranges(children, ranges);
    }
}

fn navigation_targets(
    workspace: &Path,
    value: &Value,
) -> (Vec<NavigationTarget>, HashSet<PathBuf>, HashSet<String>, bool) {
    let values: Vec<&Value> = match value {
        Value::Array(values) => values.iter().collect(),
        Value::Null => Vec::new(),
        value => vec![value],
    };
    let mut targets = Vec::new();
    let mut authorized = HashSet::new();
    let mut virtual_authorized = HashSet::new();
    let mut seen = HashSet::new();
    let mut unsupported_uri = false;
    for value in values {
        let Some(uri) = value
            .get("targetUri")
            .or_else(|| value.get("uri"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(position) = value
            .get("targetSelectionRange")
            .or_else(|| value.get("range"))
            .and_then(|range| range.get("start"))
        else {
            continue;
        };
        let line = position.get("line").and_then(Value::as_u64).unwrap_or(0) + 1;
        let column = position
            .get("character")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        if let Some(path) = uri_path(uri) {
            let dedup_key = path.to_string_lossy().into_owned();
            if !seen.insert((dedup_key, line, column)) {
                continue;
            }
            let (target, external) = match path.strip_prefix(workspace) {
                Ok(relative) => (relative.to_string_lossy().replace('\\', "/"), false),
                Err(_) => (path.to_string_lossy().into_owned(), true),
            };
            authorized.insert(path);
            targets.push(NavigationTarget {
                path: target,
                line,
                column,
                external,
            });
        } else if is_virtual_jdt_uri(uri) {
            if !seen.insert((uri.to_owned(), line, column)) {
                continue;
            }
            virtual_authorized.insert(uri.to_owned());
            targets.push(NavigationTarget {
                path: uri.to_owned(),
                line,
                column,
                external: true,
            });
        } else {
            unsupported_uri = true;
        }
    }
    (targets, authorized, virtual_authorized, unsupported_uri)
}

fn fail_pending(pending: &Pending, message: &str) {
    if let Ok(mut pending) = pending.lock() {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    let mut stdin = stdin.lock().map_err(|_| anyhow!("stdin LSP bloccato"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
    stdin.write_all(&body)?;
    stdin.flush()?;
    Ok(())
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        // Limit reads before allocating: an unterminated header must not grow
        // without bound even though the eventual body already has a size cap.
        let read = (&mut *reader).take((MAX_HEADER_BYTES - header_bytes + 1) as u64).read_line(&mut line)?;
        if read == 0 {
            if header_bytes == 0 { return Ok(None); }
            bail!("intestazione LSP incompleta");
        }
        header_bytes += read;
        if header_bytes > MAX_HEADER_BYTES {
            bail!("intestazione LSP troppo grande");
        }
        if line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                if length.is_some() { bail!("Content-Length LSP duplicato"); }
                length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .context("Content-Length non valido")?,
                );
            }
        }
    }
    let length = length.context("Content-Length mancante")?;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        bail!("dimensione messaggio LSP non valida");
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn route_message(
    message: &Value,
    pending: &Pending,
    stdin: &Arc<Mutex<ChildStdin>>,
    workspace: &Path,
    settings: &Value,
    registrations: &Registrations,
    diagnostics: impl FnOnce(&Value),
) {
    let method = message.get("method").and_then(Value::as_str);
    if method.is_none() {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(sender) = pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id))
            {
                let result = if let Some(error) = message.get("error") {
                    Err(format!(
                        "Errore LSP {}: {}",
                        error.get("code").unwrap_or(&Value::Null),
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("errore del server")
                    ))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = sender.send(result);
            }
        }
    } else if let Some(id) = message.get("id") {
        if let Ok(mut registrations) = registrations.lock() {
            if method == Some("client/registerCapability") {
                if let Some(values) = message
                    .pointer("/params/registrations")
                    .and_then(Value::as_array)
                {
                    for value in values {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            registrations.insert(id.to_string(), value.clone());
                        }
                    }
                }
            } else if method == Some("client/unregisterCapability") {
                if let Some(values) = message
                    .pointer("/params/unregisterations")
                    .or_else(|| message.pointer("/params/unregistrations"))
                    .and_then(Value::as_array)
                {
                    for value in values {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            registrations.remove(id);
                        }
                    }
                }
            }
        }
        let response = server_response(
            id.clone(),
            method.unwrap_or_default(),
            message.get("params").unwrap_or(&Value::Null),
            workspace,
            settings,
        );
        let _ = write_message(stdin, &response);
    } else if method == Some("textDocument/publishDiagnostics") {
        if let Some(params) = message.get("params") {
            diagnostics(params);
        }
    }
}

fn server_response(
    id: Value,
    method: &str,
    params: &Value,
    workspace: &Path,
    settings: &Value,
) -> Value {
    let result = match method {
        "workspace/configuration" => Value::Array(
            params
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            item.get("section")
                                .and_then(Value::as_str)
                                .map(|section| {
                                    section.split('.').fold(settings, |value, key| {
                                        value.get(key).unwrap_or(&Value::Null)
                                    })
                                })
                                .unwrap_or(settings)
                                .clone()
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        "workspace/workspaceFolders" => {
            json!([{"uri":Url::from_directory_path(workspace).ok().map(|uri|uri.to_string()),"name":"workspace"}])
        }
        "workspace/applyEdit" => {
            json!({"applied":false,"failureReason":"Modifiche dal server non supportate da questa operazione"})
        }
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest"
        | "workspace/semanticTokens/refresh"
        | "workspace/inlayHint/refresh"
        | "workspace/codeLens/refresh"
        | "workspace/diagnostic/refresh" => Value::Null,
        _ => {
            return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Metodo client non supportato"}})
        }
    };
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn server_command(workspace: &Path, command: &str, args: &[String]) -> Result<Command> {
    let executable = resolve_executable(workspace, command)
        .with_context(|| format!("eseguibile {command} non trovato"))?;
    #[cfg(windows)]
    if is_python_script(&executable) {
        if let Some(python) = resolve_executable(workspace, "python")
            .or_else(|| resolve_executable(workspace, "python3"))
        {
            let mut process = Command::new(python);
            process.arg(&executable).args(args);
            return Ok(process);
        }
    }
    let mut process = Command::new(executable);
    process.args(args);
    Ok(process)
}

#[cfg(windows)]
fn is_python_script(path: &Path) -> bool {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("py"))
    {
        return true;
    }
    if path.extension().is_some() {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 128];
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    let first_line = String::from_utf8_lossy(&header[..read]);
    let first_line = first_line.lines().next().unwrap_or("");
    first_line.starts_with("#!") && first_line.to_ascii_lowercase().contains("python")
}

fn resolve_executable(workspace: &Path, command: &str) -> Option<PathBuf> {
    let candidate = Path::new(command);
    if candidate.is_absolute() || command.contains(['/', '\\']) {
        let path = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            workspace.join(candidate)
        };
        #[cfg(windows)]
        if path.extension().is_none() {
            for extension in ["exe", "cmd", "bat", "com"] {
                let executable = path.with_extension(extension);
                if executable.is_file() {
                    return Some(executable);
                }
            }
        }
        return path.is_file().then_some(path);
    }
    let mut directories = vec![workspace.join("node_modules/.bin")];
    if let Ok(current) = std::env::current_dir() {
        directories.push(current.join("node_modules/.bin"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&paths));
    }
    directories.extend(installer::managed_bin_dirs());
    #[cfg(windows)]
    // npm creates extensionless POSIX shims beside Windows launchers.
    // Prefer the Windows executable to avoid ERROR_BAD_EXE_FORMAT (193).
    let extensions = [".exe", ".cmd", ".bat", ".com", ""];
    #[cfg(not(windows))]
    let extensions = [""];
    for directory in directories {
        for extension in extensions {
            let path = directory.join(format!("{command}{extension}"));
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[cfg(windows)]
    #[test]
    fn windows_prefers_native_npm_launchers_over_posix_shims() {
        let workspace =
            std::env::temp_dir().join(format!("helmcode-lsp-launcher-{}", uuid::Uuid::new_v4()));
        let binaries = workspace.join("node_modules/.bin");
        std::fs::create_dir_all(&binaries).unwrap();
        let name = "helmcode-test-language-server";
        std::fs::write(binaries.join(name), "#!/bin/sh\nexit 1").unwrap();
        let launcher = binaries.join(format!("{name}.cmd"));
        std::fs::write(
            &launcher,
            "@echo off\r\nnode -e \"process.stdout.write(process.argv.slice(1).join('|'))\" %*\r\n",
        )
        .unwrap();
        assert_eq!(resolve_executable(&workspace, name), Some(launcher.clone()));
        assert_eq!(
            resolve_executable(&workspace, &binaries.join(name).to_string_lossy()),
            Some(launcher)
        );
        let result = server_command(&workspace, name, &["hello space".into(), "second".into()])
            .unwrap()
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            "hello space|second"
        );
        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn framing_accepts_case_insensitive_headers_and_utf8_byte_lengths() {
        let body = json!({"jsonrpc":"2.0","id":1,"result":"città 🦀"}).to_string();
        let framed = format!("content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}",body.len(),body);
        assert_eq!(
            read_message(&mut Cursor::new(framed)).unwrap().unwrap()["result"],
            "città 🦀"
        );
        assert!(read_message(&mut Cursor::new("Content-Length: 999999999\r\n\r\n")).is_err());
        assert!(read_message(&mut Cursor::new("Content-Length: 100\r\n\r\n{}")).is_err());
    }

    #[test]
    fn framing_bounds_headers_before_allocating_and_preserves_following_messages() {
        let mut oversized = Cursor::new(format!("X-Trace: {}", "x".repeat(MAX_HEADER_BYTES * 4)));
        assert!(read_message(&mut oversized).unwrap_err().to_string().contains("troppo grande"));
        assert_eq!(oversized.position(), (MAX_HEADER_BYTES + 1) as u64);

        let prefix = "Content-Length: 2\r\nX-Trace: ";
        let suffix = "\r\n\r\n";
        let padding = "x".repeat(MAX_HEADER_BYTES - prefix.len() - suffix.len());
        let mut messages = Cursor::new(format!("{prefix}{padding}{suffix}{{}}Content-Length: 2\r\n\r\n[]"));
        assert_eq!(read_message(&mut messages).unwrap(), Some(json!({})));
        assert_eq!(read_message(&mut messages).unwrap(), Some(json!([])));
        assert_eq!(read_message(&mut messages).unwrap(), None);

        let small_headers = "X-Trace: value\r\n".repeat(MAX_HEADER_BYTES / 10);
        assert!(read_message(&mut Cursor::new(small_headers)).is_err());
    }

    #[test]
    fn framing_rejects_partial_and_ambiguous_headers() {
        assert_eq!(read_message(&mut Cursor::new("")).unwrap(), None);
        for header in [
            "Content-Length: 2",
            "Content-Length: 2\r\n",
            "Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
        ] {
            assert!(read_message(&mut Cursor::new(header)).is_err(), "{header:?}");
        }
        assert!(read_message(&mut Cursor::new(vec![0xff, b'\n'])).is_err());
    }

    #[test]
    fn computes_utf16_position_for_incremental_replacements() {
        assert_eq!(end_position("a\r\n🦀x"), json!({"line":1,"character":3}));
        assert_eq!(end_position("trailing\n"), json!({"line":1,"character":0}));
    }

    #[test]
    fn contextual_symbol_selection_uses_utf16_and_clicks_within_the_name() {
        let source = std::env::temp_dir().join("helmcode-context-unicode.ts");
        let text = "🦀 Δοκιμή";
        let cursor = SymbolPosition {
            line: 0,
            character: 6,
        };
        let token = identifier_range(text, cursor);
        assert_eq!(
            token,
            Some(SymbolRange {
                start: SymbolPosition {
                    line: 0,
                    character: 3
                },
                end: SymbolPosition {
                    line: 0,
                    character: 9
                }
            })
        );
        let location = json!({"targetUri":file_uri(&source).unwrap(),"targetSelectionRange":{"start":{"line":0,"character":3},"end":{"line":0,"character":9}}});
        assert!(self_location(&location, &source, cursor, token, None) == SelfLocation::Yes);
        let end = SymbolPosition {
            line: 0,
            character: 9,
        };
        assert!(
            self_location(&location, &source, end, identifier_range(text, end), None)
                == SelfLocation::Yes
        );
        assert!(
            self_location(
                &location,
                &source,
                SymbolPosition {
                    line: 0,
                    character: 2
                },
                None,
                None
            ) == SelfLocation::No
        );
    }

    #[test]
    fn flat_symbol_information_never_turns_body_references_into_declarations() {
        let source = std::env::temp_dir().join("helmcode-context-flat.java");
        let text = "class Foo {\n  Foo clone() {}\n}";
        let cursor = SymbolPosition {
            line: 1,
            character: 3,
        };
        let range = json!({"start":{"line":0,"character":0},"end":{"line":2,"character":1}});
        let location = json!({"uri":file_uri(&source).unwrap(),"range":range});
        let flat = json!([{"name":"Foo","kind":5,"location":location}]);
        assert!(
            self_location(
                &location,
                &source,
                cursor,
                identifier_range(text, cursor),
                Some(&flat)
            ) == SelfLocation::No
        );
        let declaration = SymbolPosition {
            line: 0,
            character: 7,
        };
        assert!(
            self_location(
                &location,
                &source,
                declaration,
                identifier_range(text, declaration),
                Some(&Value::Null)
            ) == SelfLocation::No
        );
    }

    #[test]
    fn server_requests_receive_correct_responses() {
        let workspace = std::env::temp_dir();
        let response = server_response(
            json!(9),
            "workspace/configuration",
            &json!({"items":[{"section":"python.analysis"},{"section":"missing"},{}]}),
            &workspace,
            &json!({"python":{"analysis":{"autoImportCompletions":true}}}),
        );
        assert_eq!(
            response["result"],
            json!([{"autoImportCompletions":true},null,{"python":{"analysis":{"autoImportCompletions":true}}}])
        );
        assert_eq!(
            server_response(
                json!("id"),
                "unknown",
                &Value::Null,
                &workspace,
                &Value::Null
            )["error"]["code"],
            -32601
        );
        assert_eq!(
            server_response(
                json!(1),
                "workspace/applyEdit",
                &Value::Null,
                &workspace,
                &Value::Null
            )["result"]["applied"],
            false
        );
    }

    #[test]
    fn translates_single_locations_links_and_external_targets() {
        let workspace = std::env::temp_dir().join("helmcode-lsp-navigation");
        let inside = workspace.join("some file.ts");
        let outside = std::env::temp_dir().join("external.ts");
        let values = json!([
            {"uri":file_uri(&inside).unwrap(),"range":{"start":{"line":3,"character":5}}},
            {"targetUri":file_uri(&inside).unwrap(),"targetSelectionRange":{"start":{"line":3,"character":5}}},
            {"uri":file_uri(&outside).unwrap(),"range":{"start":{"line":0,"character":0}}},
            {"uri":"jdt://contents/java.lang/String.class?=app","range":{"start":{"line":10,"character":2}}},
            {"uri":"zip://archive/Other.class","range":{"start":{"line":0,"character":0}}}
        ]);
        let (targets, authorized, virtual_authorized, unsupported) =
            navigation_targets(&workspace, &values);
        assert_eq!(targets.len(), 3);
        assert_eq!(targets[0].path, "some file.ts");
        assert_eq!((targets[0].line, targets[0].column), (4, 6));
        assert!(!targets[0].external);
        assert!(targets[1].external);
        assert_eq!(targets[2].path, "jdt://contents/java.lang/String.class?=app");
        assert_eq!((targets[2].line, targets[2].column), (11, 3));
        assert!(targets[2].external);
        assert_eq!(authorized.len(), 2);
        assert!(virtual_authorized.contains("jdt://contents/java.lang/String.class?=app"));
        assert!(unsupported);
        let (single, _, _, _) = navigation_targets(&workspace, &values[0]);
        assert_eq!(single.len(), 1);
    }
}
