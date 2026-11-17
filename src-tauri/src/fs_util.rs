use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use uuid::Uuid;

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const SKIPPED_DIRS: [&str; 7] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".cache",
];

pub fn is_skipped_dir(name: &str) -> bool {
    SKIPPED_DIRS.contains(&name)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

pub fn normalize_relative(file_path: &str) -> String {
    let normalized = file_path.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./").trim_end_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_workspace_path(workspace: &Path, file_path: &str) -> Result<PathBuf> {
    let relative = Path::new(file_path);
    if relative.is_absolute() {
        bail!("percorso assoluto non consentito: {file_path}");
    }
    for component in relative.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("percorso non consentito: {file_path}"),
        }
    }

    let workspace_root = dunce::canonicalize(workspace)
        .with_context(|| format!("workspace non valido: {}", workspace.display()))?;
    let joined = workspace_root.join(relative);

    let mut probe = joined.as_path();
    while !probe.exists() {
        probe = probe
            .parent()
            .with_context(|| format!("percorso non risolvibile: {file_path}"))?;
    }
    let resolved = dunce::canonicalize(probe)
        .with_context(|| format!("impossibile risolvere: {}", probe.display()))?;
    if !resolved.starts_with(&workspace_root) {
        bail!("il percorso esce dal workspace: {file_path}");
    }
    Ok(joined)
}

pub fn read_text(workspace: &Path, file_path: &str) -> Result<String> {
    let absolute = resolve_workspace_path(workspace, file_path)?;
    let metadata =
        std::fs::metadata(&absolute).with_context(|| format!("file non trovato: {file_path}"))?;
    if metadata.len() > MAX_TEXT_BYTES {
        bail!("file troppo grande ({} byte): {file_path}", metadata.len());
    }
    std::fs::read_to_string(&absolute).with_context(|| format!("file non leggibile: {file_path}"))
}

pub fn write_text(workspace: &Path, file_path: &str, content: &str) -> Result<()> {
    let absolute = resolve_workspace_path(workspace, file_path)?;
    atomic_write(&absolute, content.as_bytes())
}

pub fn create_entry(workspace: &Path, parent: &str, name: &str, is_dir: bool) -> Result<DirEntry> {
    if name.trim().is_empty() || name == "." || name == ".." || name.ends_with(['.', ' '])
        || name.chars().any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        bail!("Nome non valido");
    }
    let directory = resolve_workspace_path(workspace, parent)?;
    if !directory.is_dir() { bail!("La cartella di destinazione non esiste"); }
    let path = directory.join(name);
    let result = if is_dir {
        std::fs::create_dir(&path)
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ())
    };
    result.with_context(|| format!("Impossibile creare {name}; verifica che non esista già"))?;
    let parent = normalize_relative(parent);
    Ok(DirEntry { name: name.to_string(), path: if parent == "." { name.to_string() } else { format!("{parent}/{name}") }, is_dir, size: 0 })
}

pub fn list_entries(workspace: &Path, directory: &str) -> Result<Vec<DirEntry>> {
    let absolute = resolve_workspace_path(workspace, directory)?;
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&absolute)
        .with_context(|| format!("cartella non leggibile: {directory}"))?
    {
        let item = match item {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && is_skipped_dir(&name) {
            continue;
        }
        let metadata = item.metadata().ok();
        let relative = if directory == "." || directory.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", normalize_relative(directory), name)
        };
        entries.push(DirEntry {
            name,
            path: relative,
            is_dir: file_type.is_dir(),
            size: metadata.map(|value| value.len()).unwrap_or(0),
        });
    }
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    atomic_write_with_rename(path, data, |source, destination| std::fs::rename(source, destination))
}

fn atomic_write_with_rename(
    path: &Path,
    data: &[u8],
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("cartella non valida per {}", path.display()))?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp = parent.join(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temp, data) {
        std::fs::remove_file(&temp).ok();
        return Err(error).with_context(|| format!("scrittura fallita: {}", temp.display()));
    }
    // rename replaces existing files on supported platforms. Never delete the
    // destination after a failure: a retry could fail too and lose the original.
    match rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            std::fs::remove_file(&temp).ok();
            Err(rename_error).with_context(|| format!("salvataggio fallito: {}", path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn atomic_writes_create_and_replace_existing_files() {
        let workspace = std::env::temp_dir().join(format!("helmcode-write-{}", Uuid::new_v4()));
        let path = workspace.join("file.txt");
        atomic_write(&path, b"original").unwrap();
        atomic_write(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn failed_atomic_rename_preserves_original_and_cleans_temporary_file() {
        let workspace = std::env::temp_dir().join(format!("helmcode-write-failure-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace).unwrap();
        let path = workspace.join("file.txt");
        fs::write(&path, b"original").unwrap();
        let result = atomic_write_with_rename(&path, b"replacement", |temporary, destination| {
            assert_eq!(fs::read(temporary).unwrap(), b"replacement");
            assert_eq!(fs::read(destination).unwrap(), b"original");
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected rename failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 1);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn creates_entries_without_overwriting_or_leaving_workspace() {
        let workspace = std::env::temp_dir().join(format!("helmcode-create-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace).unwrap();
        let folder = create_entry(&workspace, ".", "src", true).unwrap();
        let file = create_entry(&workspace, &folder.path, "file.ts", false).unwrap();
        assert_eq!(file.path, "src/file.ts");
        fs::write(workspace.join(&file.path), "keep me").unwrap();
        assert!(create_entry(&workspace, "src", "file.ts", false).is_err());
        assert_eq!(fs::read_to_string(workspace.join(&file.path)).unwrap(), "keep me");
        for name in ["", "..", "../escape", "a/b", "a\\b", "x:y", "bad."] {
            assert!(create_entry(&workspace, ".", name, false).is_err());
        }
        assert!(create_entry(&workspace, "../", "escape", true).is_err());
        assert!(create_entry(&workspace, "missing", "file", false).is_err());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let workspace = std::env::temp_dir().join(format!("helmcode-fs-{}", Uuid::new_v4()));
        fs::create_dir_all(&workspace).unwrap();
        assert!(resolve_workspace_path(&workspace, "../escape.txt").is_err());
        #[cfg(windows)]
        assert!(resolve_workspace_path(&workspace, "C:/Windows/win.ini").is_err());
        assert!(resolve_workspace_path(&workspace, "ok/file.txt").is_ok());
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn lists_entries_with_relative_paths() {
        let workspace = std::env::temp_dir().join(format!("helmcode-list-{}", Uuid::new_v4()));
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.ts"), "x").unwrap();
        let entries = list_entries(&workspace, "src").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/main.ts");
        assert!(!entries[0].is_dir);
        fs::remove_dir_all(workspace).ok();
    }
}
