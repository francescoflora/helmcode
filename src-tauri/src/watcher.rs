use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::fs_util::is_skipped_dir;

pub struct WorkspaceWatcher {
    _watcher: RecommendedWatcher,
    pending: Arc<PendingChanges>,
    wake: mpsc::SyncSender<()>,
}

#[derive(Default)]
struct PendingChanges {
    paths: Mutex<HashSet<PathBuf>>,
    stopped: AtomicBool,
}

impl PendingChanges {
    fn enqueue(&self, event: notify::Result<Event>, root: &Path) -> bool {
        if self.stopped.load(Ordering::Acquire) { return false; }
        let Ok(event) = event else { return false; };
        let mut incoming = event.paths.into_iter().filter(|path| {
            let Ok(relative) = path.strip_prefix(root) else { return false; };
            !relative.as_os_str().is_empty() && !relative.components().any(|component| {
                is_skipped_dir(&component.as_os_str().to_string_lossy())
            })
        }).peekable();
        if incoming.peek().is_none() { return false; }
        let Ok(mut paths) = self.paths.lock() else { return false; };
        if self.stopped.load(Ordering::Acquire) { return false; }
        let mut changed = false;
        for path in incoming { changed |= paths.insert(path); }
        changed
    }

    fn take(&self, root: &Path) -> Vec<String> {
        let paths = self.paths.lock().map(|mut paths| std::mem::take(&mut *paths)).unwrap_or_default();
        if self.stopped.load(Ordering::Acquire) { return Vec::new(); }
        // Directory changes also refresh Explorer, including newly created empty folders.
        // The frontend only reads content for paths matching an open file.
        let mut paths: Vec<String> = paths.into_iter()
            .filter_map(|path| path.strip_prefix(root).ok().map(|path| path.to_string_lossy().replace('\\', "/")))
            .collect();
        paths.sort();
        paths
    }
}

impl WorkspaceWatcher {
    pub fn start(app: &AppHandle, workspace: &Path) -> Result<Self> {
        let root = dunce::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        // Coalesce duplicate paths before queuing work. Even a long burst has at
        // most one queued wakeup, rather than one heap-allocated event per write.
        let (sender, receiver) = mpsc::sync_channel(1);
        let pending = Arc::new(PendingChanges::default());
        let callback_pending = pending.clone();
        let callback_root = root.clone();
        let wake = sender.clone();
        let mut watcher = notify::recommended_watcher(move |result| {
            if callback_pending.enqueue(result, &callback_root) {
                let _ = sender.try_send(());
            }
        })
        .context("impossibile creare il watcher del workspace")?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .with_context(|| format!("impossibile osservare {}", root.display()))?;

        let app = app.clone();
        let worker_pending = pending.clone();
        std::thread::spawn(move || {
            while receiver.recv().is_ok() {
                if worker_pending.stopped.load(Ordering::Acquire) { break; }
                let deadline = Instant::now() + Duration::from_millis(180);
                loop {
                    if worker_pending.stopped.load(Ordering::Acquire) { return; }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match receiver.recv_timeout(remaining) {
                        Ok(()) => {},
                        Err(_) => break,
                    }
                }
                let paths = worker_pending.take(&root);
                if !paths.is_empty() && !worker_pending.stopped.load(Ordering::Acquire) {
                    let _ = app.emit("fs-changed", serde_json::json!({ "workspace": root.display().to_string(), "paths": paths }));
                }
            }
        });

        Ok(Self { _watcher: watcher, pending, wake })
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.pending.stopped.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
}

pub fn should_watch(workspace: &Path) -> bool {
    !workspace.as_os_str().is_empty()
}

#[cfg(test)]
mod tests {
    use super::{should_watch, PendingChanges};
    use notify::Event;
    use std::path::Path;
    use std::sync::atomic::Ordering;

    #[test]
    fn watches_any_non_empty_workspace() {
        assert!(should_watch(Path::new("workspace")));
        assert!(!should_watch(Path::new("")));
    }

    #[test]
    fn coalesces_repeated_paths_and_ignores_generated_events_before_queuing() {
        let pending = PendingChanges::default();
        let root = Path::new("workspace");
        for _ in 0..10_000 {
            pending.enqueue(Ok(Event::default().add_path(root.join("src/main.ts"))), root);
            pending.enqueue(Ok(Event::default().add_path(root.join("target/debug/output"))), root);
            pending.enqueue(Ok(Event::default().add_path(root.join("node_modules/pkg/index.js"))), root);
        }
        assert_eq!(pending.paths.lock().unwrap().len(), 1);
        assert_eq!(pending.take(root), vec!["src/main.ts"]);
        assert!(pending.take(root).is_empty());
    }

    #[test]
    fn preserves_all_distinct_paths_and_discards_pending_work_after_stop() {
        let pending = PendingChanges::default();
        let root = Path::new("workspace");
        pending.enqueue(Ok(Event::default().add_path(root.join("b.ts")).add_path(root.join("a.ts"))), root);
        pending.enqueue(Ok(Event::default().add_path(Path::new("other").join("outside.ts"))), root);
        assert_eq!(pending.take(root), vec!["a.ts", "b.ts"]);
        pending.enqueue(Ok(Event::default().add_path(root.join("old.ts"))), root);
        pending.stopped.store(true, Ordering::Release);
        assert!(pending.take(root).is_empty());
        assert!(!pending.enqueue(Ok(Event::default().add_path(root.join("new.ts"))), root));
    }

    #[test]
    fn reports_new_empty_directories_without_metadata_filtering() {
        let root = std::env::temp_dir().join(format!("helmcode-watcher-{}", uuid::Uuid::new_v4()));
        let directory = root.join("empty");
        std::fs::create_dir_all(&directory).unwrap();
        let pending = PendingChanges::default();
        pending.enqueue(Ok(Event::default().add_path(directory.clone())), &root);
        assert_eq!(pending.take(&root), vec!["empty"]);
        std::fs::remove_dir(directory).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
