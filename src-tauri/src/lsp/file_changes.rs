//! Semantic edits are planned before filesystem changes. The filesystem engine
//! validates and applies these untrusted WorkspaceEdits against its snapshots.
use super::*;

#[derive(Clone, Debug)]
pub struct FileMove {
    pub old_path: String,
    pub new_path: String,
    pub is_dir: bool,
    pub rename_symbol: bool,
}

#[derive(Clone, Debug)]
pub struct OpenDocument {
    pub path: String,
    pub text: String,
}

pub struct FileChangePlan {
    pub edits: Vec<Value>,
    pub warnings: Vec<String>,
    pub updated_references: bool,
    pub document_versions: HashMap<String, u64>,
}

struct SessionClient {
    client: Arc<LspClient>,
    language: Language,
}

pub struct FileChangeSession {
    workspace: PathBuf,
    moves: Vec<FileMove>,
    documents: Vec<OpenDocument>,
    clients: Vec<SessionClient>,
    warnings: Vec<String>,
}

impl LspManager {
    pub fn file_change_session(
        &mut self,
        app: &AppHandle,
        workspace: &Path,
        moves: &[FileMove],
        documents: &[OpenDocument],
    ) -> Result<FileChangeSession> {
        let mut clients = Vec::new();
        let mut seen = HashSet::new();
        let mut warnings = Vec::new();
        let mut paths: Vec<PathBuf> = Vec::new();
        for movement in moves {
            let old = crate::fs_util::resolve_workspace_path(workspace, &movement.old_path)?;
            crate::fs_util::resolve_workspace_path(workspace, &movement.new_path)?;
            if !movement.is_dir {
                paths.push(old);
            }
        }
        for document in documents {
            paths.push(crate::fs_util::resolve_workspace_path(
                workspace,
                &document.path,
            )?);
        }
        for path in paths {
            match self.document(app, workspace, &path) {
                Ok(Some(document)) => {
                    if seen.insert(Arc::as_ptr(&document.client) as usize) {
                        clients.push(SessionClient {
                            client: document.client,
                            language: document.language,
                        });
                    }
                }
                Ok(None) => {}
                Err(error) => warnings.push(format!(
                    "Aggiornamento riferimenti non disponibile: {error:#}"
                )),
            }
        }
        // An active server may own imports even when the moved file has another
        // extension (for example JSON imported by TypeScript).
        for client in self.clients.values() {
            if seen.contains(&(Arc::as_ptr(client) as usize)) {
                continue;
            }
            let path = client
                .documents
                .lock()
                .ok()
                .and_then(|documents| documents.keys().find_map(|uri| uri_path(uri)));
            if let Some(language) = path
                .as_ref()
                .and_then(|path| language_for(workspace, path).ok().flatten())
            {
                seen.insert(Arc::as_ptr(client) as usize);
                clients.push(SessionClient {
                    client: client.clone(),
                    language,
                });
            }
        }
        if clients.is_empty() && !moves.is_empty() {
            warnings.push("Nessun language server disponibile: file spostati senza aggiornamento automatico dei riferimenti.".into());
        }
        warnings.sort();
        warnings.dedup();
        Ok(FileChangeSession {
            workspace: workspace.to_path_buf(),
            moves: moves.to_vec(),
            documents: documents.to_vec(),
            clients,
            warnings,
        })
    }
}

impl FileChangeSession {
    pub fn prepare(&self) -> FileChangePlan {
        let mut plan = FileChangePlan {
            edits: Vec::new(),
            warnings: self.warnings.clone(),
            updated_references: false,
            document_versions: HashMap::new(),
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        for session in &self.clients {
            if Instant::now() >= deadline {
                plan.warnings.push("Tempo disponibile per aggiornare i riferimenti esaurito; alcune modifiche richiedono una verifica manuale.".into());
                break;
            }
            let client = &session.client;
            let result = (|| -> Result<()> {
                client.initialize_with_timeout(&session.language, remaining(deadline, 8)?)?;
                for document in &self.documents {
                    let path = self.workspace.join(&document.path);
                    if let Some(language) = language_for(&self.workspace, &path)? {
                        if language.key == session.language.key {
                            client.sync(&path, &language.language_id, &document.text)?;
                        }
                    }
                }
                let capabilities = client.capabilities()?;
                let files:Vec<Value>=self.moves.iter().filter(|movement|operation_matches(client,&capabilities,"willRename",movement,&self.workspace)).map(|movement|json!({"oldUri":file_uri(&self.workspace.join(&movement.old_path)).unwrap_or_default(),"newUri":file_uri(&self.workspace.join(&movement.new_path)).unwrap_or_default()})).collect();
                if !files.is_empty() {
                    match client.request(
                        "workspace/willRenameFiles",
                        json!({"files":files}),
                        remaining(deadline, 8)?,
                    ) {
                        Ok(edit) if has_workspace_edits(&edit) => plan.edits.push(edit),
                        Ok(_) => {}
                        Err(error) => plan.warnings.push(format!(
                            "{}: impossibile aggiornare gli import per lo spostamento: {error:#}",
                            session.language.language_id
                        )),
                    }
                } else if !self.moves.is_empty() {
                    plan.warnings.push(format!("{}: aggiornamento automatico degli import non supportato per questi percorsi.",session.language.language_id));
                }
                for movement in self
                    .moves
                    .iter()
                    .filter(|movement| movement.rename_symbol && !movement.is_dir)
                {
                    if Instant::now() >= deadline {
                        plan.warnings.push(
                            "Rinomina dei simboli incompleta: tempo disponibile esaurito.".into(),
                        );
                        break;
                    }
                    let path = self.workspace.join(&movement.old_path);
                    let Some(language) = language_for(&self.workspace, &path)? else {
                        continue;
                    };
                    if language.key != session.language.key {
                        continue;
                    }
                    if let Err(error) = self.rename_class(
                        session,
                        movement,
                        &capabilities,
                        deadline,
                        &mut plan.edits,
                    ) {
                        plan.warnings.push(format!(
                            "{}: nome della classe non aggiornato automaticamente: {error:#}",
                            movement.old_path
                        ));
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                plan.warnings.push(format!(
                    "{}: aggiornamento semantico non disponibile: {error:#}",
                    session.language.language_id
                ));
            }
            if let Ok(documents) = client.documents.lock() {
                for (uri, document) in documents.iter() {
                    plan.document_versions.insert(uri.clone(), document.version);
                }
            }
        }
        plan.updated_references = plan.edits.iter().any(has_workspace_edits);
        plan.warnings.sort();
        plan.warnings.dedup();
        plan
    }

    fn rename_class(
        &self,
        session: &SessionClient,
        movement: &FileMove,
        capabilities: &Value,
        deadline: Instant,
        edits: &mut Vec<Value>,
    ) -> Result<()> {
        let old = self.workspace.join(&movement.old_path);
        let new = self.workspace.join(&movement.new_path);
        if old.extension() != new.extension() {
            return Ok(());
        }
        let old_name = old
            .file_stem()
            .and_then(|stem| stem.to_str())
            .context("nome file non valido")?;
        let new_name = new
            .file_stem()
            .and_then(|stem| stem.to_str())
            .context("nome file non valido")?;
        if old_name == new_name {
            return Ok(());
        }
        let text = match self
            .documents
            .iter()
            .find(|document| document.path == movement.old_path)
        {
            Some(document) => document.text.clone(),
            None => crate::fs_util::read_text(&self.workspace, &movement.old_path)?,
        };
        session
            .client
            .sync(&old, &session.language.language_id, &text)?;
        if !method_supported(
            &session.client,
            capabilities,
            "textDocument/documentSymbol",
            "documentSymbolProvider",
        ) {
            bail!("il server non fornisce simboli di documento per riconoscere la classe");
        }
        let symbols = session.client.request(
            "textDocument/documentSymbol",
            json!({"textDocument":{"uri":file_uri(&old)?}}),
            remaining(deadline, 4)?,
        )?;
        let mut declarations = Vec::new();
        matching_types(&symbols, &text, old_name, &mut declarations);
        if declarations.is_empty() {
            return Ok(());
        }
        if declarations.len() != 1 {
            bail!("più dichiarazioni di tipo corrispondono al nome del file");
        }
        let selection = declarations[0];
        // JDT and other servers may include the type rename in willRenameFiles.
        // Never request a duplicate rename over that same declaration snapshot.
        if edits
            .iter()
            .any(|edit| workspace_edit_touches(edit, &old, selection))
        {
            return Ok(());
        }
        if !method_supported(
            &session.client,
            capabilities,
            "textDocument/rename",
            "renameProvider",
        ) {
            bail!("il server non supporta la rinomina semantica dei simboli");
        }
        let position = json!({"line":selection.start.line,"character":selection.start.character});
        if capabilities
            .pointer("/renameProvider/prepareProvider")
            .and_then(Value::as_bool)
            == Some(true)
        {
            let prepared = session.client.request(
                "textDocument/prepareRename",
                json!({"textDocument":{"uri":file_uri(&old)?},"position":position}),
                remaining(deadline, 4)?,
            )?;
            if prepared.is_null() {
                bail!("la dichiarazione non può essere rinominata dal server");
            }
        }
        let edit = session.client.request(
            "textDocument/rename",
            json!({"textDocument":{"uri":file_uri(&old)?},"position":position,"newName":new_name}),
            remaining(deadline, 6)?,
        )?;
        if has_workspace_edits(&edit) {
            edits.push(edit);
        } else {
            bail!("il server non ha restituito modifiche per la rinomina della classe");
        }
        Ok(())
    }

    /// Called after a successful filesystem transaction, using final unsaved
    /// buffers. Old URIs are retired so in-flight requests cannot reopen them.
    pub fn did_rename(&self, final_documents: &[OpenDocument]) -> Vec<String> {
        let mut warnings = Vec::new();
        for session in &self.clients {
            let result = (|| -> Result<()> {
                let client = &session.client;
                let known: Vec<String> = client
                    .documents
                    .lock()
                    .map_err(|_| anyhow!("documenti LSP bloccati"))?
                    .keys()
                    .cloned()
                    .collect();
                for uri in known {
                    if let Some(path) = uri_path(&uri) {
                        if self.moves.iter().any(|movement| {
                            path_matches(
                                &path,
                                &self.workspace.join(&movement.old_path),
                                movement.is_dir,
                            )
                        }) {
                            client
                                .retired_paths
                                .lock()
                                .map_err(|_| anyhow!("documenti LSP bloccati"))?
                                .insert(uri.clone());
                            client.close(&path)?;
                        }
                    }
                }
                for movement in &self.moves {
                    if !movement.is_dir {
                        client
                            .retired_paths
                            .lock()
                            .map_err(|_| anyhow!("documenti LSP bloccati"))?
                            .insert(file_uri(&self.workspace.join(&movement.old_path))?);
                    }
                }
                let capabilities = client.capabilities()?;
                let files:Vec<Value>=self.moves.iter().filter(|movement|operation_matches(client,&capabilities,"didRename",movement,&self.workspace)).map(|movement|json!({"oldUri":file_uri(&self.workspace.join(&movement.old_path)).unwrap_or_default(),"newUri":file_uri(&self.workspace.join(&movement.new_path)).unwrap_or_default()})).collect();
                if !files.is_empty() {
                    client.notify("workspace/didRenameFiles", json!({"files":files}))?;
                }
                for document in final_documents {
                    let path = self.workspace.join(&document.path);
                    if let Some(language) = language_for(&self.workspace, &path)? {
                        if language.key == session.language.key {
                            client.sync(&path, &language.language_id, &document.text)?;
                        }
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(format!(
                    "Language server da ricaricare dopo lo spostamento: {error:#}"
                ));
            }
        }
        warnings
    }

    pub fn did_delete(&self, deleted_paths: &[String]) -> Vec<String> {
        let mut warnings = Vec::new();
        for session in &self.clients {
            let result = (|| -> Result<()> {
                let client = &session.client;
                let mut uris: HashSet<String> = deleted_paths
                    .iter()
                    .filter_map(|path| file_uri(&self.workspace.join(path)).ok())
                    .collect();
                if let Ok(documents) = client.documents.lock() {
                    uris.extend(
                        documents
                            .keys()
                            .filter(|uri| {
                                uri_path(uri).is_some_and(|path| {
                                    deleted_paths.iter().any(|deleted| {
                                        path_matches(&path, &self.workspace.join(deleted), true)
                                    })
                                })
                            })
                            .cloned(),
                    );
                }
                for uri in uris {
                    client
                        .retired_paths
                        .lock()
                        .map_err(|_| anyhow!("documenti LSP bloccati"))?
                        .insert(uri.clone());
                    if let Some(path) = uri_path(&uri) {
                        client.close(&path)?;
                    }
                }
                let capabilities = client.capabilities()?;
                let files:Vec<Value>=deleted_paths.iter().filter_map(|path|{
                    let movement=FileMove {old_path:path.clone(),new_path:path.clone(),is_dir:false,rename_symbol:false};
                    operation_matches(client,&capabilities,"didDelete",&movement,&self.workspace).then(||json!({"uri":file_uri(&self.workspace.join(path)).unwrap_or_default()}))
                }).collect();
                if !files.is_empty() {
                    client.notify("workspace/didDeleteFiles", json!({"files":files}))?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(format!(
                    "Language server da ricaricare dopo l'eliminazione: {error:#}"
                ));
            }
        }
        warnings
    }
}

fn remaining(deadline: Instant, max_secs: u64) -> Result<Duration> {
    let time = deadline.saturating_duration_since(Instant::now());
    if time.is_zero() {
        bail!("tempo disponibile per il refactoring esaurito");
    }
    Ok(time.min(Duration::from_secs(max_secs)))
}

fn path_matches(path: &Path, parent: &Path, is_dir: bool) -> bool {
    same_file(path, parent) || (is_dir && path.starts_with(parent))
}

fn method_supported(
    client: &LspClient,
    capabilities: &Value,
    method: &str,
    capability: &str,
) -> bool {
    capabilities
        .get(capability)
        .is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
        || client
            .registrations
            .lock()
            .map(|registrations| {
                registrations
                    .values()
                    .any(|value| value.get("method").and_then(Value::as_str) == Some(method))
            })
            .unwrap_or(false)
}

fn operation_matches(
    client: &LspClient,
    capabilities: &Value,
    operation: &str,
    movement: &FileMove,
    workspace: &Path,
) -> bool {
    let method = format!(
        "workspace/{}Files",
        match operation {
            "willRename" => "willRename",
            "didRename" => "didRename",
            _ => "didDelete",
        }
    );
    let mut options = Vec::new();
    if let Some(value) = capabilities.pointer(&format!("/workspace/fileOperations/{operation}")) {
        options.push(value.clone());
    }
    if let Ok(registrations) = client.registrations.lock() {
        options.extend(
            registrations
                .values()
                .filter(|value| value.get("method").and_then(Value::as_str) == Some(&method))
                .filter_map(|value| value.get("registerOptions"))
                .cloned(),
        );
    }
    options
        .iter()
        .any(|options| file_operation_filter_matches(options, movement, workspace))
}

fn file_operation_filter_matches(options: &Value, movement: &FileMove, workspace: &Path) -> bool {
    if options == &Value::Bool(true) {
        return true;
    }
    options
        .get("filters")
        .and_then(Value::as_array)
        .is_some_and(|filters| {
            filters.iter().any(|filter| {
                if filter
                    .get("scheme")
                    .and_then(Value::as_str)
                    .is_some_and(|scheme| scheme != "file")
                {
                    return false;
                }
                let Some(pattern) = filter.get("pattern") else {
                    return false;
                };
                if pattern
                    .get("matches")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| (kind == "folder") != movement.is_dir)
                {
                    return false;
                }
                let Some(glob) = pattern.get("glob").and_then(Value::as_str) else {
                    return false;
                };
                let ignore_case = pattern
                    .pointer("/options/ignoreCase")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                [&movement.old_path, &movement.new_path].iter().any(|path| {
                    let absolute = workspace.join(path).to_string_lossy().replace('\\', "/");
                    let uri_path = Url::from_file_path(workspace.join(path))
                        .ok()
                        .map(|uri| uri.path().to_string())
                        .unwrap_or_default();
                    [path.replace('\\', "/"), absolute, uri_path]
                        .iter()
                        .any(|path| glob_matches(glob, path, ignore_case))
                })
            })
        })
}

fn glob_matches(pattern: &str, text: &str, ignore_case: bool) -> bool {
    let pattern = if ignore_case {
        pattern.to_lowercase()
    } else {
        pattern.to_string()
    };
    let text = if ignore_case {
        text.to_lowercase()
    } else {
        text.to_string()
    };
    fn alternatives(pattern: String, remaining: &mut usize) -> Vec<String> {
        if *remaining == 0 {
            return Vec::new();
        }
        *remaining -= 1;
        let Some(start) = pattern.find('{') else {
            return vec![pattern];
        };
        let Some(end) = pattern[start + 1..].find('}').map(|end| end + start + 1) else {
            return vec![pattern];
        };
        let mut values = Vec::new();
        for choice in pattern[start + 1..end].split(',') {
            values.extend(alternatives(
                format!("{}{}{}", &pattern[..start], choice, &pattern[end + 1..]),
                remaining,
            ));
        }
        values
    }
    fn matches(
        pattern: &[char],
        text: &[char],
        p: usize,
        t: usize,
        memo: &mut HashMap<(usize, usize), bool>,
    ) -> bool {
        if let Some(value) = memo.get(&(p, t)) {
            return *value;
        }
        let result = if p == pattern.len() {
            t == text.len()
        } else {
            match pattern[p] {
                '*' => {
                    let double = pattern.get(p + 1) == Some(&'*');
                    let next = p + if double { 2 } else { 1 };
                    (double
                        && pattern.get(next) == Some(&'/')
                        && matches(pattern, text, next + 1, t, memo))
                        || matches(pattern, text, next, t, memo)
                        || (t < text.len()
                            && (double || text[t] != '/')
                            && matches(pattern, text, p, t + 1, memo))
                }
                '?' => {
                    t < text.len() && text[t] != '/' && matches(pattern, text, p + 1, t + 1, memo)
                }
                '[' => {
                    if let Some(end) = pattern[p + 1..]
                        .iter()
                        .position(|value| *value == ']')
                        .map(|offset| p + 1 + offset)
                    {
                        let mut index = p + 1;
                        let negate = matches!(pattern.get(index), Some('!' | '^'));
                        if negate {
                            index += 1;
                        }
                        let mut included = false;
                        while index < end {
                            if index + 2 < end && pattern[index + 1] == '-' {
                                included |= t < text.len()
                                    && pattern[index] <= text[t]
                                    && text[t] <= pattern[index + 2];
                                index += 3;
                            } else {
                                included |= t < text.len() && pattern[index] == text[t];
                                index += 1;
                            }
                        }
                        t < text.len()
                            && text[t] != '/'
                            && (included != negate)
                            && matches(pattern, text, end + 1, t + 1, memo)
                    } else {
                        t < text.len()
                            && pattern[p] == text[t]
                            && matches(pattern, text, p + 1, t + 1, memo)
                    }
                }
                value => {
                    t < text.len() && value == text[t] && matches(pattern, text, p + 1, t + 1, memo)
                }
            }
        };
        memo.insert((p, t), result);
        result
    }
    alternatives(pattern, &mut 64).iter().any(|pattern| {
        matches(
            &pattern.chars().collect::<Vec<_>>(),
            &text.chars().collect::<Vec<_>>(),
            0,
            0,
            &mut HashMap::new(),
        )
    })
}

fn matching_types(value: &Value, text: &str, name: &str, types: &mut Vec<SymbolRange>) {
    if let Some(values) = value.as_array() {
        for value in values {
            matching_types(value, text, name, types);
        }
        return;
    }
    let kind = value.get("kind").and_then(Value::as_u64).unwrap_or(0);
    if matches!(kind, 5 | 10 | 11 | 23) {
        if let Some(selection) = value.get("selectionRange").and_then(SymbolRange::parse) {
            if text_for_range(text, selection).as_deref() == Some(name) {
                types.push(selection);
            }
        }
    } else if matches!(kind, 0 | 1 | 2 | 3 | 4) {
        if let Some(children) = value.get("children") {
            matching_types(children, text, name, types);
        }
    }
}

fn text_for_range(text: &str, range: SymbolRange) -> Option<String> {
    if range.start.line != range.end.line {
        return None;
    }
    let line = text.split('\n').nth(range.start.line as usize)?;
    let units: Vec<u16> = line.encode_utf16().collect();
    String::from_utf16(units.get(range.start.character as usize..range.end.character as usize)?)
        .ok()
}

fn has_workspace_edits(edit: &Value) -> bool {
    edit.get("changes")
        .and_then(Value::as_object)
        .is_some_and(|changes| {
            changes
                .values()
                .any(|edits| edits.as_array().is_some_and(|edits| !edits.is_empty()))
        })
        || edit
            .get("documentChanges")
            .and_then(Value::as_array)
            .is_some_and(|changes| !changes.is_empty())
}

fn workspace_edit_touches(edit: &Value, path: &Path, selection: SymbolRange) -> bool {
    let touches = |uri: &str, edits: &Value| {
        uri_path(uri).is_some_and(|target| same_file(&target, path))
            && edits.as_array().is_some_and(|edits| {
                edits
                    .iter()
                    .filter_map(|edit| edit.get("range").and_then(SymbolRange::parse))
                    .any(|range| range.start < selection.end && selection.start < range.end)
            })
    };
    edit.get("changes")
        .and_then(Value::as_object)
        .is_some_and(|changes| changes.iter().any(|(uri, edits)| touches(uri, edits)))
        || edit
            .get("documentChanges")
            .and_then(Value::as_array)
            .is_some_and(|changes| {
                changes.iter().any(|change| {
                    change
                        .pointer("/textDocument/uri")
                        .and_then(Value::as_str)
                        .is_some_and(|uri| {
                            touches(uri, change.get("edits").unwrap_or(&Value::Null))
                        })
                })
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_typescript_server_plans_import_updates_for_a_file_move() {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let workspace = std::env::temp_dir().join(format!("helmcode-lsp-move-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::create_dir_all(workspace.join("lib")).unwrap();
        let workspace = dunce::canonicalize(workspace).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(workspace.clone());
        std::fs::write(workspace.join("tsconfig.json"), r#"{"compilerOptions":{"module":"commonjs","target":"ES2022"},"include":["**/*.ts"]}"#).unwrap();
        let feature = "import { value } from './value';\nexport const feature = value;\n";
        std::fs::write(workspace.join("src/feature.ts"), feature).unwrap();
        std::fs::write(workspace.join("src/value.ts"), "export const value = 42;\n").unwrap();
        std::fs::write(workspace.join("main.ts"), "import { feature } from './src/feature';\nconsole.log(feature);\n").unwrap();
        let language = Language {
            key: "typescript".into(), language_id: "typescript".into(), command: "node".into(), args: vec![],
            initialization_options: json!({"tsserver":{"path":dunce::canonicalize(repository.join("node_modules/typescript/lib/tsserver.js")).unwrap()}}),
            settings: json!({}),
        };
        let mut command = Command::new("node");
        command.arg(repository.join("node_modules/typescript-language-server/lib/cli.mjs")).arg("--stdio");
        let client = crate::lsp::protocol_tests::spawn_test_client(command, workspace.clone(), language.settings.clone());
        client.initialize(&language).unwrap();
        client.sync(&workspace.join("src/feature.ts"), "typescript", feature).unwrap();
        let session = FileChangeSession {
            workspace: workspace.clone(),
            moves: vec![FileMove { old_path: "src/feature.ts".into(), new_path: "lib/feature.ts".into(), is_dir: false, rename_symbol: false }],
            documents: vec![OpenDocument { path: "src/feature.ts".into(), text: feature.into() }],
            clients: vec![SessionClient { client: client.clone(), language }], warnings: vec![],
        };
        let plan = session.prepare();
        assert!(plan.updated_references, "No import edits from TypeScript: {:?}", plan.warnings);
        let replacements = |path: &str| {
            let target = workspace.join(path);
            let matches = |uri: &str| uri_path(uri).is_some_and(|path| same_file(&path, &target));
            let mut texts = Vec::new();
            for edit in &plan.edits {
                if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
                    for (uri, edits) in changes.iter().filter(|(uri, _)| matches(uri)) {
                        let _ = uri;
                        texts.extend(edits.as_array().into_iter().flatten().filter_map(|edit| edit.get("newText").and_then(Value::as_str)).map(str::to_owned));
                    }
                }
                if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
                    for change in changes {
                        if change.pointer("/textDocument/uri").and_then(Value::as_str).is_some_and(matches) {
                            texts.extend(change.get("edits").and_then(Value::as_array).into_iter().flatten().filter_map(|edit| edit.get("newText").and_then(Value::as_str)).map(str::to_owned));
                        }
                    }
                }
            }
            texts
        };
        assert!(replacements("main.ts").iter().any(|text| text.contains("./lib/feature")), "Closed importing file was not updated: {:?}", plan.edits);
        assert!(replacements("src/feature.ts").iter().any(|text| text.contains("../src/value")), "Moved file imports were not updated: {:?}", plan.edits);
        client.stop();
    }

    #[test]
    fn file_operation_globs_match_braces_folders_and_case_options() {
        assert!(glob_matches(
            "**/*.{ts,js,jsx,tsx}",
            "C:/project/main.ts",
            false
        ));
        assert!(glob_matches("**/*.ts", "main.ts", false));
        assert!(!glob_matches("*.ts", "src/main.ts", false));
        assert!(glob_matches("src/[A-Z]*.TS", "src/App.ts", true));
        let file = FileMove {
            old_path: "src/A.java".into(),
            new_path: "src/B.java".into(),
            is_dir: false,
            rename_symbol: true,
        };
        let options = json!({"filters":[{"scheme":"file","pattern":{"glob":"**/*.java","matches":"folder"}}]});
        assert!(!file_operation_filter_matches(
            &options,
            &file,
            Path::new("/workspace")
        ));
    }
    #[test]
    fn class_names_come_only_from_semantic_top_level_type_selection_ranges() {
        let text = "class Old { class Old {} }";
        let symbols = json!([{"name":"Old<T>","kind":5,"selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":9}},"children":[{"name":"Old","kind":5,"selectionRange":{"start":{"line":0,"character":18},"end":{"line":0,"character":21}}}]}]);
        let mut ranges = Vec::new();
        matching_types(&symbols, text, "Old", &mut ranges);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start.character, 6);
    }
}
