use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use url::Url;
use uuid::Uuid;

use crate::fs_util;
use crate::state::AppState;

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryOperation {
    kind: String,
    path: String,
    new_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    path: String,
    text: String,
    saved_text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMove {
    pub old_path: String,
    pub new_path: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedDocument {
    path: String,
    content: String,
    saved_content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    moves: Vec<EntryMove>,
    deleted: Vec<String>,
    documents: Vec<ChangedDocument>,
    warnings: Vec<String>,
    references_updated: bool,
}

#[derive(Debug)]
struct ValidatedOperation {
    path: String,
    absolute: PathBuf,
    destination: Option<(String, PathBuf)>,
    is_dir: bool,
}

#[derive(Debug)]
struct Snapshot {
    path: String,
    disk: String,
    content: String,
    dirty: bool,
    open: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TextChange {
    from: usize,
    to: usize,
    text: String,
}

fn path_key(path: &str) -> String {
    #[cfg(windows)]
    { path.to_lowercase() }
    #[cfg(not(windows))]
    { path.to_owned() }
}

fn within(path: &str, ancestor: &str) -> bool {
    let path = path_key(path);
    let ancestor = path_key(ancestor);
    path == ancestor || path.strip_prefix(&ancestor).is_some_and(|tail| tail.starts_with('/'))
}

fn relative_path(path: &str) -> Result<String> {
    let path = path.replace('\\', "/");
    if path.is_empty() || path.starts_with('/') || path.contains(':') {
        bail!("Percorso non valido: {path}");
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." || part.eq_ignore_ascii_case(".git") || part.starts_with(".helmcode-fileops-")
            || part.ends_with(['.', ' '])
            || part.chars().any(|ch| ch.is_control() || matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
            bail!("Percorso non consentito: {path}");
        }
        let stem = part.split('.').next().unwrap_or_default().to_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))) {
            bail!("Nome riservato: {part}");
        }
        parts.push(part);
    }
    if parts.is_empty() { bail!("Non puoi modificare la cartella radice del progetto"); }
    Ok(parts.join("/"))
}

fn validate_operations(workspace: &Path, operations: &[EntryOperation]) -> Result<Vec<ValidatedOperation>> {
    if operations.is_empty() || operations.len() > 1000 { bail!("Seleziona da 1 a 1000 elementi"); }
    let mut normalized = Vec::new();
    let mut sources = HashSet::new();
    for operation in operations {
        if !["move", "delete"].contains(&operation.kind.as_str()) { bail!("Operazione non valida"); }
        let path = relative_path(&operation.path)?;
        if !sources.insert(path_key(&path)) { bail!("Elemento selezionato più volte: {path}"); }
        let absolute = fs_util::resolve_workspace_path(workspace, &path)?;
        let metadata = std::fs::symlink_metadata(&absolute).with_context(|| format!("Elemento non trovato: {path}"))?;
        if metadata.file_type().is_symlink() { bail!("Non puoi modificare collegamenti simbolici: {path}"); }
        let destination = if operation.kind == "move" {
            let target = relative_path(operation.new_path.as_deref().context("Destinazione mancante")?)?;
            if target == path { bail!("La destinazione coincide con il percorso attuale: {path}"); }
            let target_absolute = fs_util::resolve_workspace_path(workspace, &target)?;
            if !target_absolute.parent().is_some_and(Path::is_dir) { bail!("La cartella di destinazione non esiste: {target}"); }
            if metadata.is_dir() && path_key(&target) != path_key(&path) && within(&target, &path) { bail!("Non puoi spostare una cartella al suo interno: {path}"); }
            if target_absolute.exists() && path_key(&target) != path_key(&path) {
                bail!("Esiste già un elemento nella destinazione: {target}");
            }
            Some((target, target_absolute))
        } else { None };
        normalized.push(ValidatedOperation { path, absolute, destination, is_dir: metadata.is_dir() });
    }
    normalized.sort_by_key(|operation| operation.path.split('/').count());
    let mut result: Vec<ValidatedOperation> = Vec::new();
    for operation in normalized {
        if result.iter().any(|ancestor| ancestor.is_dir && within(&operation.path, &ancestor.path)) { continue; }
        result.push(operation);
    }
    let mut targets = HashSet::new();
    for operation in &result {
        if let Some((target, _)) = &operation.destination {
            if !targets.insert(path_key(target)) { bail!("Più elementi hanno la stessa destinazione: {target}"); }
            if result.iter().any(|source| source.path != operation.path && within(target, &source.path)) {
                bail!("La destinazione viene spostata o cancellata nella stessa operazione: {target}");
            }
        }
    }
    Ok(result)
}

fn remap_path(path: &str, operations: &[ValidatedOperation]) -> Option<String> {
    for operation in operations {
        if within(path, &operation.path) {
            return operation.destination.as_ref().map(|(target, _)| format!("{target}{}", &path[operation.path.len()..]));
        }
    }
    Some(path.to_owned())
}

fn snapshot(workspace: &Path, path: &str, open: &HashMap<String, OpenDocument>) -> Result<Snapshot> {
    let absolute = fs_util::resolve_workspace_path(workspace, path)?;
    let metadata = std::fs::metadata(&absolute)?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES { bail!("File non leggibile o troppo grande per aggiornare i riferimenti: {path}"); }
    let disk = std::fs::read_to_string(&absolute).with_context(|| format!("File non UTF-8: {path}"))?;
    let document = open.get(&path_key(path));
    if document.is_some_and(|document| document.saved_text != disk) { bail!("Il file è cambiato sul disco; ricaricalo prima di procedere: {path}"); }
    Ok(Snapshot { path: path.to_owned(), content: document.map(|document| document.text.clone()).unwrap_or_else(|| disk.clone()), dirty: document.is_some_and(|document| document.text != disk), open: document.is_some(), disk })
}

fn edit_path(workspace: &Path, uri: &str) -> Result<String> {
    let path = Url::parse(uri)?.to_file_path().map_err(|_| anyhow!("Il server ha restituito un URI non locale: {uri}"))?;
    let canonical = dunce::canonicalize(&path).with_context(|| format!("File del refactoring non disponibile: {}", path.display()))?;
    let root = dunce::canonicalize(workspace)?;
    let relative = canonical.strip_prefix(root).context("Il refactoring tenta di modificare un file esterno al progetto")?;
    let relative = relative.components().map(|component| match component { Component::Normal(value) => Ok(value.to_string_lossy().into_owned()), _ => Err(anyhow!("Percorso del refactoring non valido")) }).collect::<Result<Vec<_>>>()?.join("/");
    relative_path(&relative)
}

fn utf16_offset(text: &str, position: &Value) -> Result<usize> {
    let line = position.get("line").and_then(Value::as_u64).context("Riga del refactoring non valida")? as usize;
    let character = position.get("character").and_then(Value::as_u64).context("Colonna del refactoring non valida")? as usize;
    let mut start = 0;
    for _ in 0..line {
        start += text[start..].find('\n').context("Riga del refactoring fuori dal documento")? + 1;
    }
    let tail = text[start..].split('\n').next().unwrap_or_default().trim_end_matches('\r');
    let mut units = 0;
    for (offset, ch) in tail.char_indices() {
        if units == character { return Ok(start + offset); }
        units += ch.len_utf16();
        if units > character { bail!("Colonna del refactoring all'interno di un carattere UTF-16"); }
    }
    if units == character { Ok(start + tail.len()) } else { bail!("Colonna del refactoring fuori dal documento") }
}

fn gather_edits(workspace: &Path, edits: &[Value], operations: &[ValidatedOperation], versions: &HashMap<String, u64>) -> Result<BTreeMap<String, Vec<Value>>> {
    let mut grouped = BTreeMap::<String, Vec<Value>>::new();
    for edit in edits {
        if edit.is_null() { continue; }
        if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
            for (uri, changes) in changes {
                let path = edit_path(workspace, uri)?;
                grouped.entry(path).or_default().extend(changes.as_array().context("Modifiche del refactoring non valide")?.iter().cloned());
            }
        }
        if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
            for change in changes {
                if let Some(kind) = change.get("kind").and_then(Value::as_str) {
                    if kind == "rename" {
                        let old_path = edit_path(workspace, change.get("oldUri").and_then(Value::as_str).context("oldUri mancante")?)?;
                        let new_uri = change.get("newUri").and_then(Value::as_str).context("newUri mancante")?;
                        let new_absolute = Url::parse(new_uri)?.to_file_path().map_err(|_| anyhow!("newUri non locale"))?;
                        let matches = operations.iter().any(|operation| operation.path == old_path && operation.destination.as_ref().is_some_and(|(_, path)| *path == new_absolute));
                        if matches { continue; }
                    }
                    bail!("Il server richiede un'operazione aggiuntiva sui file non prevista: {kind}");
                }
                let uri = change.pointer("/textDocument/uri").and_then(Value::as_str).context("Documento del refactoring mancante")?;
                if let Some(version) = change.pointer("/textDocument/version").filter(|version| !version.is_null()) {
                    let version = version.as_u64().context("Versione del refactoring non valida")?;
                    if versions.get(uri) != Some(&version) { bail!("Il server ha restituito modifiche per una versione diversa del documento: {uri}"); }
                }
                let path = edit_path(workspace, uri)?;
                grouped.entry(path).or_default().extend(change.get("edits").and_then(Value::as_array).context("Modifiche del refactoring non valide")?.iter().cloned());
            }
        }
    }
    Ok(grouped)
}

fn apply_text_edits(text: &str, edits: &[Value]) -> Result<String> {
    let mut changes = Vec::new();
    for edit in edits {
        let range = edit.get("range").context("Intervallo del refactoring mancante")?;
        let from = utf16_offset(text, range.get("start").context("Inizio intervallo mancante")?)?;
        let to = utf16_offset(text, range.get("end").context("Fine intervallo mancante")?)?;
        if from > to { bail!("Intervallo del refactoring invertito"); }
        let change = TextChange { from, to, text: edit.get("newText").and_then(Value::as_str).context("Testo del refactoring mancante")?.to_owned() };
        if !changes.contains(&change) { changes.push(change); }
    }
    changes.sort_by_key(|change| (change.from, change.to));
    for pair in changes.windows(2) {
        if pair[1].from < pair[0].to || pair[0].from == pair[1].from { bail!("Il server ha restituito modifiche incompatibili sullo stesso testo"); }
    }
    let mut result = text.to_owned();
    for change in changes.into_iter().rev() { result.replace_range(change.from..change.to, &change.text); }
    Ok(result)
}

struct StagedEntry<'a> {
    operation: &'a ValidatedOperation,
    holding: PathBuf,
    installed: bool,
}

struct StagedWrite {
    path: PathBuf,
    backup: PathBuf,
    installed: bool,
    content: String,
}

fn checked_rename(source: &Path, destination: &Path) -> Result<()> {
    if std::fs::symlink_metadata(destination).is_ok() { bail!("Esiste già un elemento: {}", destination.display()); }
    std::fs::rename(source, destination).with_context(|| format!("Impossibile spostare {} in {}", source.display(), destination.display()))
}

fn commit_changes(workspace: &Path, operations: &[ValidatedOperation], snapshots: &BTreeMap<String, Snapshot>, before_write: &mut impl FnMut(usize) -> Result<()>) -> Result<Vec<String>> {
    // The generated staging directory always lives below this verified workspace.
    // Deletions remain recoverable here until the complete transaction succeeds.
    let stage = workspace.join(format!(".helmcode-fileops-{}", Uuid::new_v4()));
    if stage.parent() != Some(workspace) { bail!("Cartella temporanea non valida"); }
    std::fs::create_dir(&stage).context("Impossibile preparare l'operazione")?;
    let mut staged = Vec::<StagedEntry<'_>>::new();
    let mut writes = Vec::<StagedWrite>::new();
    let result = (|| -> Result<()> {
        for (index, operation) in operations.iter().enumerate() {
            fs_util::resolve_workspace_path(workspace, &operation.path)?;
            let holding = stage.join(format!("entry-{index}"));
            checked_rename(&operation.absolute, &holding)?;
            staged.push(StagedEntry { operation, holding, installed: false });
        }
        for entry in &mut staged {
            if let Some((path, target)) = &entry.operation.destination {
                fs_util::resolve_workspace_path(workspace, path)?;
                checked_rename(&entry.holding, target)?;
                entry.installed = true;
            }
        }
        for snapshot in snapshots.values() {
            let Some(path) = remap_path(&snapshot.path, operations) else { continue; };
            let absolute = fs_util::resolve_workspace_path(workspace, &path)?;
            if std::fs::read_to_string(absolute)? != snapshot.disk {
                bail!("Il file è cambiato durante lo spostamento: {path}");
            }
        }
        for (index, snapshot) in snapshots.values().filter(|snapshot| !snapshot.dirty && snapshot.content != snapshot.disk).enumerate() {
            let Some(path) = remap_path(&snapshot.path, operations) else { continue; };
            let absolute = fs_util::resolve_workspace_path(workspace, &path)?;
            if std::fs::read_to_string(&absolute).context("File del refactoring non più leggibile")? != snapshot.disk {
                bail!("Il file è cambiato durante l'operazione: {path}");
            }
            before_write(index)?;
            let replacement = stage.join(format!("replacement-{index}"));
            let backup = stage.join(format!("backup-{index}"));
            std::fs::write(&replacement, snapshot.content.as_bytes())?;
            checked_rename(&absolute, &backup)?;
            writes.push(StagedWrite { path: absolute.clone(), backup, installed: false, content: snapshot.content.clone() });
            checked_rename(&replacement, &absolute)?;
            writes.last_mut().expect("scrittura registrata").installed = true;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (index, write) in writes.iter().enumerate().rev() {
            if write.installed && write.path.exists() {
                if std::fs::read_to_string(&write.path).ok().as_deref() == Some(write.content.as_str()) {
                    if let Err(error) = std::fs::remove_file(&write.path) { failures.push(error.to_string()); continue; }
                } else if let Err(error) = checked_rename(&write.path, &stage.join(format!("concurrent-{index}"))) {
                    failures.push(error.to_string()); continue;
                } else {
                    failures.push(format!("Una modifica concorrente è conservata in {}", stage.display()));
                }
            }
            if let Err(error) = checked_rename(&write.backup, &write.path) { failures.push(error.to_string()); }
        }
        for entry in staged.iter().rev() {
            if entry.installed {
                let target = &entry.operation.destination.as_ref().expect("destinazione presente").1;
                if let Err(error) = checked_rename(target, &entry.holding) { failures.push(error.to_string()); continue; }
            }
            if let Err(error) = checked_rename(&entry.holding, &entry.operation.absolute) { failures.push(error.to_string()); }
        }
        if failures.is_empty() {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error);
        }
        bail!("{error:#}. Ripristino incompleto; copie conservate in {}: {}", stage.display(), failures.join("; "));
    }
    let mut warnings = Vec::new();
    if let Err(error) = std::fs::remove_dir_all(&stage) {
        warnings.push(format!("Operazione completata; alcune copie temporanee non sono state eliminate da {}: {error}", stage.display()));
    }
    Ok(warnings)
}

fn expand_moves(workspace: &Path, operations: &[ValidatedOperation]) -> Result<Vec<crate::lsp::FileMove>> {
    let mut moves = Vec::new();
    fn files(workspace: &Path, directory: &Path, source: &str, target: &str, result: &mut Vec<crate::lsp::FileMove>) -> Result<()> {
        if result.len() > 20_000 { bail!("Troppi file da analizzare nello spostamento"); }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if metadata.is_dir() {
                if !fs_util::is_skipped_dir(&name) { files(workspace, &entry.path(), source, target, result)?; }
            } else if metadata.is_file() {
                let old = entry.path().strip_prefix(workspace)?.to_string_lossy().replace('\\', "/");
                result.push(crate::lsp::FileMove { old_path: old.clone(), new_path: format!("{target}{}", &old[source.len()..]), is_dir: false, rename_symbol: false });
            }
        }
        Ok(())
    }
    for operation in operations {
        let Some((target, _)) = &operation.destination else { continue; };
        let old = Path::new(&operation.path);
        let new = Path::new(target);
        moves.push(crate::lsp::FileMove { old_path: operation.path.clone(), new_path: target.clone(), is_dir: operation.is_dir,
            rename_symbol: !operation.is_dir && old.file_stem() != new.file_stem() && old.extension() == new.extension() });
        if operation.is_dir { files(workspace, &operation.absolute, &operation.path, target, &mut moves)?; }
    }
    Ok(moves)
}

#[tauri::command]
pub async fn mutate_entries(app: AppHandle, expected_workspace: String, operations: Vec<EntryOperation>, documents: Vec<OpenDocument>) -> Result<MutationResult, String> {
    tauri::async_runtime::spawn_blocking(move || mutate(&app, &expected_workspace, &operations, &documents))
        .await.map_err(|error| error.to_string())?.map_err(|error| format!("{error:#}"))
}

fn mutate(app: &AppHandle, expected_workspace: &str, operations: &[EntryOperation], documents: &[OpenDocument]) -> Result<MutationResult> {
    let state = app.state::<AppState>();
    let _serial = state.file_operations.lock().map_err(|_| anyhow!("Operazioni sui file non disponibili"))?;
    let workspace_guard = state.workspace.read().map_err(|_| anyhow!("Progetto non disponibile"))?;
    if *workspace_guard != Path::new(expected_workspace) { bail!("Il progetto è cambiato: riprova"); }
    let workspace = dunce::canonicalize(&*workspace_guard)?;
    let operations = validate_operations(&workspace, operations)?;
    let mut open = HashMap::new();
    for document in documents {
        let path = relative_path(&document.path)?;
        if open.insert(path_key(&path), OpenDocument { path, ..document.clone() }).is_some() { bail!("Documento aperto duplicato"); }
    }
    let moves = expand_moves(&workspace, &operations)?;
    let lsp_documents: Vec<_> = open.values().map(|document| crate::lsp::OpenDocument { path: document.path.clone(), text: document.text.clone() }).collect();
    let session = {
        let mut manager = state.lsp.lock().map_err(|_| anyhow!("Language server non disponibile"))?;
        manager.file_change_session(app, &workspace, &moves, &lsp_documents)?
    };
    let plan = session.prepare();
    let grouped = gather_edits(&workspace, &plan.edits, &operations, &plan.document_versions)?;
    let mut snapshots = BTreeMap::new();
    for (path, edits) in grouped {
        if remap_path(&path, &operations).is_none() { continue; }
        let mut snapshot = snapshot(&workspace, &path, &open)?;
        snapshot.content = apply_text_edits(&snapshot.content, &edits)?;
        snapshots.insert(path, snapshot);
    }
    for document in open.values() {
        if operations.iter().any(|operation| within(&document.path, &operation.path)) && !snapshots.contains_key(&document.path) {
            snapshots.insert(document.path.clone(), snapshot(&workspace, &document.path, &open)?);
        }
    }
    // Validate every affected original immediately before the first mutation.
    for snapshot in snapshots.values() {
        let path = fs_util::resolve_workspace_path(&workspace, &snapshot.path)?;
        if std::fs::read_to_string(path)? != snapshot.disk { bail!("Il file è cambiato durante l'analisi: {}", snapshot.path); }
    }
    let mut warnings = plan.warnings;
    warnings.extend(commit_changes(&workspace, &operations, &snapshots, &mut |_| Ok(()))?);
    let changed: Vec<_> = snapshots.values().filter(|snapshot| snapshot.open).filter_map(|snapshot| {
        let path = remap_path(&snapshot.path, &operations)?;
        if path == snapshot.path && snapshot.content == snapshot.disk && !snapshot.dirty { return None; }
        Some(ChangedDocument { path, content: snapshot.content.clone(), saved_content: if snapshot.dirty { snapshot.disk.clone() } else { snapshot.content.clone() } })
    }).collect();
    let final_documents: Vec<_> = open.values().filter_map(|document| {
        let path = remap_path(&document.path, &operations)?;
        let text = snapshots.get(&document.path).map(|snapshot| snapshot.content.clone()).unwrap_or_else(|| document.text.clone());
        Some(crate::lsp::OpenDocument { path, text })
    }).collect();
    warnings.extend(session.did_rename(&final_documents));
    let deleted: Vec<_> = operations.iter().filter(|operation| operation.destination.is_none()).map(|operation| operation.path.clone()).collect();
    warnings.extend(session.did_delete(&deleted));
    warnings.sort(); warnings.dedup();
    let moves = operations.into_iter().filter_map(|operation| operation.destination.map(|(new_path, _)| EntryMove { old_path: operation.path, new_path, is_dir: operation.is_dir })).collect();
    Ok(MutationResult { moves, deleted, documents: changed, warnings, references_updated: plan.updated_references })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("helmcode-fileops-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(dunce::canonicalize(path).unwrap())
        }
        fn file(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
    }
    impl Drop for Workspace { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn move_entry(path: &str, target: &str) -> EntryOperation {
        EntryOperation { kind: "move".into(), path: path.into(), new_path: Some(target.into()) }
    }
    fn delete_entry(path: &str) -> EntryOperation {
        EntryOperation { kind: "delete".into(), path: path.into(), new_path: None }
    }
    fn edit(line: usize, start: usize, end: usize, text: &str) -> Value {
        json!({"range":{"start":{"line":line,"character":start},"end":{"line":line,"character":end}},"newText":text})
    }

    #[test]
    fn moves_files_and_directories_without_overwriting_and_deletes_selections() {
        let workspace = Workspace::new();
        workspace.file("src/file.ts", "export const value = 1;");
        workspace.file("notes.txt", "delete me");
        fs::create_dir(workspace.0.join("lib")).unwrap();
        let operations = validate_operations(&workspace.0, &[move_entry("src", "lib/source"), delete_entry("notes.txt")]).unwrap();
        assert_eq!(remap_path("src/file.ts", &operations), Some("lib/source/file.ts".into()));
        commit_changes(&workspace.0, &operations, &BTreeMap::new(), &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(workspace.0.join("lib/source/file.ts")).unwrap(), "export const value = 1;");
        assert!(!workspace.0.join("src").exists());
        assert!(!workspace.0.join("notes.txt").exists());
        assert!(!fs::read_dir(&workspace.0).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".helmcode-fileops-")));
    }

    #[test]
    fn rejects_traversal_root_collisions_cycles_and_invalid_windows_names() {
        let workspace = Workspace::new();
        workspace.file("src/file.ts", "keep");
        workspace.file("existing.ts", "existing");
        for source in [".", "..", "../escape", "C:/Windows/win.ini", "/tmp/external", ".git/config"] {
            assert!(validate_operations(&workspace.0, &[delete_entry(source)]).is_err(), "{source}");
        }
        for destination in ["existing.ts", "../escape.ts", "missing/file.ts", "CON.ts", "bad?.ts", "bad.", "bad "] {
            assert!(validate_operations(&workspace.0, &[move_entry("src/file.ts", destination)]).is_err(), "{destination}");
        }
        assert!(validate_operations(&workspace.0, &[move_entry("src", "src/nested")]).is_err());
        assert!(validate_operations(&workspace.0, &[move_entry("src/file.ts", "src/file.ts")]).is_err());
        assert_eq!(fs::read_to_string(workspace.0.join("src/file.ts")).unwrap(), "keep");
        assert_eq!(fs::read_to_string(workspace.0.join("existing.ts")).unwrap(), "existing");
    }

    #[test]
    fn normalizes_parent_and_child_selections_and_rejects_ambiguous_destinations() {
        let workspace = Workspace::new();
        workspace.file("src/file.ts", "keep");
        workspace.file("other.ts", "other");
        let operations = validate_operations(&workspace.0, &[delete_entry("src/file.ts"), delete_entry("src")]).unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].path, "src");
        assert!(validate_operations(&workspace.0, &[move_entry("src/file.ts", "same.ts"), move_entry("other.ts", "same.ts")]).is_err());
        assert!(validate_operations(&workspace.0, &[move_entry("src", "target"), move_entry("other.ts", "src/other.ts")]).is_err());
    }

    #[test]
    fn edits_use_utf16_and_deduplicate_identical_semantic_edits() {
        let text = "const emoji = '🦀';\r\nconst café = emoji;\r\n";
        assert_eq!(utf16_offset(text, &json!({"line":0,"character":17})).unwrap(), "const emoji = '🦀".len());
        assert!(utf16_offset(text, &json!({"line":0,"character":16})).is_err());
        let rename = edit(1, 6, 10, "coffee");
        let result = apply_text_edits(text, &[rename.clone(), rename]).unwrap();
        assert!(result.contains("const coffee = emoji;"));
        assert!(apply_text_edits(text, &[edit(1, 6, 10, "a"), edit(1, 7, 9, "b")]).is_err());
        assert!(apply_text_edits(text, &[edit(99, 0, 1, "x")]).is_err());
    }

    #[test]
    fn dirty_buffers_stay_unsaved_during_moves_and_refactoring() {
        let workspace = Workspace::new();
        workspace.file("Old.ts", "export class Old {}\n");
        let operations = validate_operations(&workspace.0, &[move_entry("Old.ts", "New.ts")]).unwrap();
        let open = HashMap::from([(path_key("Old.ts"), OpenDocument { path:"Old.ts".into(),text:"export class Old {}\n// unsaved\n".into(),saved_text:"export class Old {}\n".into() })]);
        let mut snapshot = snapshot(&workspace.0, "Old.ts", &open).unwrap();
        snapshot.content = apply_text_edits(&snapshot.content, &[edit(0, 13, 16, "New")]).unwrap();
        assert!(snapshot.dirty);
        let snapshots = BTreeMap::from([("Old.ts".into(), snapshot)]);
        commit_changes(&workspace.0, &operations, &snapshots, &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(workspace.0.join("New.ts")).unwrap(), "export class Old {}\n");
        assert_eq!(snapshots["Old.ts"].content, "export class New {}\n// unsaved\n");
        assert!(!workspace.0.join("Old.ts").exists());
    }

    #[test]
    fn moving_a_file_updates_its_imports_and_references_in_unopened_project_files() {
        let workspace = Workspace::new();
        let feature = "import { value } from './value';\nexport const feature = value;\n";
        let consumer = "import { feature } from './src/feature';\nconsole.log(feature);\n";
        workspace.file("src/feature.ts", feature);
        workspace.file("src/value.ts", "export const value = 42;\n");
        workspace.file("main.ts", consumer);
        fs::create_dir(workspace.0.join("lib")).unwrap();
        let operations = validate_operations(&workspace.0, &[move_entry("src/feature.ts", "lib/feature.ts")]).unwrap();
        let moves = expand_moves(&workspace.0, &operations).unwrap();
        assert_eq!(moves.len(), 1);
        assert!(!moves[0].rename_symbol, "moving a file must keep its declared symbol name");
        let feature_uri = Url::from_file_path(workspace.0.join("src/feature.ts")).unwrap().to_string();
        let main_uri = Url::from_file_path(workspace.0.join("main.ts")).unwrap().to_string();
        let changes = json!({"changes": {
            feature_uri: [edit(0, feature.find("./value").unwrap(), feature.find("./value").unwrap() + 7, "../src/value")],
            main_uri: [edit(0, consumer.find("./src/feature").unwrap(), consumer.find("./src/feature").unwrap() + 13, "./lib/feature")]
        }});
        let grouped = gather_edits(&workspace.0, &[changes], &operations, &HashMap::new()).unwrap();
        let mut snapshots = BTreeMap::new();
        for (path, edits) in grouped {
            let mut snapshot = snapshot(&workspace.0, &path, &HashMap::new()).unwrap();
            snapshot.content = apply_text_edits(&snapshot.content, &edits).unwrap();
            snapshots.insert(path, snapshot);
        }
        commit_changes(&workspace.0, &operations, &snapshots, &mut |_| Ok(())).unwrap();
        assert!(!workspace.0.join("src/feature.ts").exists());
        assert_eq!(fs::read_to_string(workspace.0.join("lib/feature.ts")).unwrap(), feature.replace("./value", "../src/value"));
        assert_eq!(fs::read_to_string(workspace.0.join("main.ts")).unwrap(), consumer.replace("./src/feature", "./lib/feature"));
    }

    #[test]
    fn rollback_restores_deleted_moved_and_already_rewritten_files() {
        let workspace = Workspace::new();
        workspace.file("src/one.ts", "one");
        workspace.file("src/two.ts", "two");
        workspace.file("delete.txt", "recover this");
        fs::create_dir(workspace.0.join("lib")).unwrap();
        let operations = validate_operations(&workspace.0, &[move_entry("src", "lib/src"), delete_entry("delete.txt")]).unwrap();
        let mut first = snapshot(&workspace.0, "src/one.ts", &HashMap::new()).unwrap();
        first.content = "updated one".into();
        let mut second = snapshot(&workspace.0, "src/two.ts", &HashMap::new()).unwrap();
        second.content = "updated two".into();
        let snapshots = BTreeMap::from([("src/one.ts".into(), first), ("src/two.ts".into(), second)]);
        let result = commit_changes(&workspace.0, &operations, &snapshots, &mut |index| if index == 1 { bail!("injected write failure") } else { Ok(()) });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(workspace.0.join("src/one.ts")).unwrap(), "one");
        assert_eq!(fs::read_to_string(workspace.0.join("src/two.ts")).unwrap(), "two");
        assert_eq!(fs::read_to_string(workspace.0.join("delete.txt")).unwrap(), "recover this");
        assert!(!workspace.0.join("lib/src").exists());
    }

    #[test]
    fn stale_disk_snapshots_are_rejected_before_mutation() {
        let workspace = Workspace::new();
        workspace.file("file.ts", "external update");
        let open = HashMap::from([(path_key("file.ts"), OpenDocument { path:"file.ts".into(),text:"local unsaved".into(),saved_text:"original".into() })]);
        assert!(snapshot(&workspace.0, "file.ts", &open).is_err());
        assert_eq!(fs::read_to_string(workspace.0.join("file.ts")).unwrap(), "external update");
    }

    #[test]
    fn workspace_edits_are_confined_and_version_checked_and_resource_renames_must_match() {
        let workspace = Workspace::new();
        workspace.file("Old.ts", "export class Old {}");
        let uri = Url::from_file_path(workspace.0.join("Old.ts")).unwrap().to_string();
        let new_uri = Url::from_file_path(workspace.0.join("New.ts")).unwrap().to_string();
        let operations = validate_operations(&workspace.0, &[move_entry("Old.ts", "New.ts")]).unwrap();
        let edits = vec![json!({"documentChanges":[{"textDocument":{"uri":uri,"version":5},"edits":[edit(0,13,16,"New")]},{"kind":"rename","oldUri":uri,"newUri":new_uri}]})];
        assert!(gather_edits(&workspace.0, &edits, &operations, &HashMap::new()).is_err());
        let versions = HashMap::from([(uri.clone(), 5)]);
        let grouped = gather_edits(&workspace.0, &edits, &operations, &versions).unwrap();
        assert_eq!(grouped["Old.ts"].len(), 1);
        let unknown_resource = vec![json!({"documentChanges":[{"kind":"delete","uri":uri}]})];
        assert!(gather_edits(&workspace.0, &unknown_resource, &operations, &versions).is_err());
        let external = Workspace::new();
        external.file("external.ts", "private");
        let external_uri = Url::from_file_path(external.0.join("external.ts")).unwrap().to_string();
        assert!(gather_edits(&workspace.0, &[json!({"changes":{external_uri:[edit(0,0,7,"changed")]}})], &operations, &versions).is_err());
        assert_eq!(fs::read_to_string(external.0.join("external.ts")).unwrap(), "private");
    }

    #[cfg(windows)]
    #[test]
    fn supports_case_only_file_and_folder_renames() {
        let workspace = Workspace::new();
        workspace.file("src/Name.ts", "keep");
        let operations = validate_operations(&workspace.0, &[move_entry("src/Name.ts", "src/name.ts")]).unwrap();
        commit_changes(&workspace.0, &operations, &BTreeMap::new(), &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read_dir(workspace.0.join("src")).unwrap().next().unwrap().unwrap().file_name(), "name.ts");
        let operations = validate_operations(&workspace.0, &[move_entry("src", "SRC")]).unwrap();
        commit_changes(&workspace.0, &operations, &BTreeMap::new(), &mut |_| Ok(())).unwrap();
        assert_eq!(fs::read_dir(&workspace.0).unwrap().next().unwrap().unwrap().file_name(), "SRC");
    }
}
