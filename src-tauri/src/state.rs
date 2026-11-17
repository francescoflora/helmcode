use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, RwLock};

use crate::agent::delta::DeltaManager;
use crate::lsp::LspManager;
use crate::pty::manager::PtyManager;
use crate::watcher::WorkspaceWatcher;

pub struct AppState {
    pub workspace: RwLock<PathBuf>,
    pub pty: Mutex<PtyManager>,
    pub delta: Mutex<DeltaManager>,
    pub lsp: Mutex<LspManager>,
    pub file_operations: Mutex<()>,
    pub watcher: Mutex<Option<WorkspaceWatcher>>,
    pub agent_busy: AtomicBool,
}

impl AppState {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace: RwLock::new(workspace),
            pty: Mutex::new(PtyManager::new()),
            delta: Mutex::new(DeltaManager::new()),
            lsp: Mutex::new(LspManager::new()),
            file_operations: Mutex::new(()),
            watcher: Mutex::new(None),
            agent_busy: AtomicBool::new(false),
        }
    }

    pub fn workspace_root(&self) -> PathBuf {
        self.workspace
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    pub fn set_workspace(&self, path: PathBuf) {
        if let Ok(mut guard) = self.workspace.write() {
            *guard = path;
        }
    }
}

pub fn default_workspace() -> PathBuf {
    for key in ["HELMCODE_WORKSPACE", "DEV_WORKSPACE"] {
        if let Ok(value) = std::env::var(key) {
            let path = PathBuf::from(value);
            if path.is_dir() {
                return path;
            }
        }
    }
    PathBuf::new()
}
