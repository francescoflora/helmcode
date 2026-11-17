use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use similar::{ChangeTag, TextDiff};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::fs_util::{atomic_write, normalize_relative, resolve_workspace_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DiffStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffDecision {
    Accepted,
    Rejected,
}

pub struct PendingDiff {
    pub id: String,
    pub file_path: String,
    pub original_content: String,
    pub proposed_content: String,
    #[allow(dead_code)]
    pub status: DiffStatus,
    decision: Option<oneshot::Sender<DiffDecision>>,
}

pub struct ProposedDiff {
    pub review: DiffReview,
    pub decision: oneshot::Receiver<DiffDecision>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReview {
    pub id: String,
    pub file_path: String,
    pub original_content: String,
    pub proposed_content: String,
    pub stats: DiffStats,
}

impl DiffReview {
    fn from_pending(diff: &PendingDiff) -> Self {
        Self {
            id: diff.id.clone(),
            file_path: diff.file_path.clone(),
            original_content: diff.original_content.clone(),
            proposed_content: diff.proposed_content.clone(),
            stats: diff_stats(&diff.original_content, &diff.proposed_content),
        }
    }
}

#[derive(Default)]
pub struct DeltaManager {
    pending: Vec<PendingDiff>,
}

impl DeltaManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn propose(
        &mut self,
        workspace: &Path,
        file_path: &str,
        proposed: String,
    ) -> Result<ProposedDiff> {
        let absolute = resolve_workspace_path(workspace, file_path)?;
        let original = std::fs::read_to_string(&absolute).unwrap_or_default();
        let (sender, receiver) = oneshot::channel();
        let diff = PendingDiff {
            id: Uuid::new_v4().to_string(),
            file_path: normalize_relative(file_path),
            original_content: original,
            proposed_content: proposed,
            status: DiffStatus::Pending,
            decision: Some(sender),
        };
        let review = DiffReview::from_pending(&diff);
        self.pending.push(diff);
        Ok(ProposedDiff {
            review,
            decision: receiver,
        })
    }

    pub fn accept(&mut self, workspace: &Path, id: &str) -> Result<String> {
        let index = self
            .pending
            .iter()
            .position(|diff| diff.id == id)
            .with_context(|| format!("diff {id} non trovato"))?;
        let absolute = resolve_workspace_path(workspace, &self.pending[index].file_path)?;
        atomic_write(&absolute, self.pending[index].proposed_content.as_bytes())?;
        let mut diff = self.pending.remove(index);
        if let Some(sender) = diff.decision.take() {
            let _ = sender.send(DiffDecision::Accepted);
        }
        Ok(diff.file_path)
    }

    pub fn reject(&mut self, id: &str) -> Result<String> {
        let index = self
            .pending
            .iter()
            .position(|diff| diff.id == id)
            .with_context(|| format!("diff {id} non trovato"))?;
        let mut diff = self.pending.remove(index);
        if let Some(sender) = diff.decision.take() {
            let _ = sender.send(DiffDecision::Rejected);
        }
        Ok(diff.file_path)
    }
}

pub fn diff_stats(original: &str, proposed: &str) -> DiffStats {
    let diff = TextDiff::from_lines(original, proposed);
    let mut added = 0;
    let mut removed = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    DiffStats { added, removed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_util::resolve_workspace_path;
    use std::fs;

    fn temp_workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("helmcode-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let workspace = temp_workspace();
        assert!(resolve_workspace_path(&workspace, "../escape.txt").is_err());
        #[cfg(windows)]
        assert!(resolve_workspace_path(&workspace, "C:/Windows/win.ini").is_err());
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn staging_does_not_touch_disk_until_accept() {
        let workspace = temp_workspace();
        fs::write(workspace.join("notes.txt"), "vecchio\n").unwrap();
        let mut delta = DeltaManager::new();
        let proposed = delta
            .propose(&workspace, "notes.txt", "nuovo\n".into())
            .unwrap();
        let review = proposed.review;
        assert_eq!(
            fs::read_to_string(workspace.join("notes.txt")).unwrap(),
            "vecchio\n"
        );
        assert_eq!(review.stats.added, 1);
        assert_eq!(review.stats.removed, 1);

        delta.reject(&review.id).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("notes.txt")).unwrap(),
            "vecchio\n"
        );

        let proposed = delta
            .propose(&workspace, "nuovo.txt", "contenuto\n".into())
            .unwrap();
        delta.accept(&workspace, &proposed.review.id).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("nuovo.txt")).unwrap(),
            "contenuto\n"
        );
        fs::remove_dir_all(workspace).ok();
    }
}
