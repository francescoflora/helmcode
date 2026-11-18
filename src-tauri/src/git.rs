use std::borrow::Cow;
use std::collections::HashSet;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use similar::{ChangeTag, TextDiff};
use tauri::State;

use crate::fs_util;
use crate::state::AppState;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub label: String,
    pub staged: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub changes: Vec<GitChange>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub merging: bool,
    pub cherry_picking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
    pub unpushed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLog {
    pub commits: Vec<GitCommit>,
    pub truncated: bool,
    pub remotes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub lines: Vec<DiffLine>,
    pub added: usize,
    pub removed: usize,
    pub is_new: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub status: GitStatus,
    pub conflicts: Vec<String>,
}

pub fn branches(workspace: &Path) -> Result<Vec<GitBranch>> {
    let raw = run(workspace, &[
        "for-each-ref",
        "--format=%(refname)%1f%(HEAD)%1f%(symref)%1f%(objectname:short)%1f%(authorname)%1f%(committerdate:iso-strict)%1f%(subject)",
        "refs/heads",
        "refs/remotes",
    ])?;
    Ok(String::from_utf8_lossy(&raw)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\x1f');
            let reference = fields.next()?;
            let current = fields.next()? == "*";
            if !fields.next().unwrap_or_default().is_empty() { return None; }
            let short_hash = fields.next().unwrap_or_default().to_string();
            let author = fields.next().unwrap_or_default().to_string();
            let date = fields.next().unwrap_or_default().to_string();
            let subject = fields.next().unwrap_or_default().to_string();
            let remote = reference.starts_with("refs/remotes/");
            let name = reference.strip_prefix(if remote { "refs/remotes/" } else { "refs/heads/" })?;
            Some(GitBranch { name: name.to_string(), current, remote, short_hash, author, date, subject })
        })
        .collect())
}

pub fn log(workspace: &Path, limit: usize) -> Result<GitLog> {
    let limit = limit.clamp(1, 2000);
    let has_history = run(workspace, &["rev-parse", "--verify", "HEAD"]).is_ok()
        || run(workspace, &["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"])
            .map(|raw| !raw.is_empty())
            .unwrap_or(false);
    if !has_history {
        return Ok(GitLog { commits: Vec::new(), truncated: false, remotes: Vec::new() });
    }
    let count = format!("--max-count={}", limit + 1);
    let raw = run(workspace, &[
        "log", "--all", "--topo-order", "--no-color", &count,
        "--pretty=format:%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s",
    ])?;
    let mut history = parse_log(&raw, limit);
    history.remotes = run(workspace, &["remote"])
        .map(|raw| String::from_utf8_lossy(&raw).lines().map(str::trim).filter(|remote| !remote.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default();
    let unpushed = unpushed_hashes(workspace);
    for commit in &mut history.commits {
        commit.unpushed = unpushed.contains(&commit.hash);
    }
    Ok(history)
}

fn unpushed_hashes(workspace: &Path) -> HashSet<String> {
    let comparison = run(workspace, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .ok()
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let branch = run(workspace, &["symbolic-ref", "--short", "-q", "HEAD"]).ok()?;
            let candidate = format!("origin/{}", String::from_utf8_lossy(&branch).trim());
            run(workspace, &["rev-parse", "--verify", "--quiet", &candidate]).ok().map(|_| candidate)
        });
    let Some(comparison) = comparison else { return HashSet::new(); };
    run(workspace, &["rev-list", &format!("{comparison}..HEAD")])
        .map(|raw| String::from_utf8_lossy(&raw).lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn parse_log(raw: &[u8], limit: usize) -> GitLog {
    let text = String::from_utf8_lossy(raw);
    let mut commits = Vec::new();
    let mut truncated = false;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some(index) = line.find('\u{1f}') else { continue; };
        let mut fields = line[index + 1..].split('\u{1f}');
        let (Some(hash), Some(short_hash), Some(parents), Some(author), Some(email), Some(date), Some(refs), Some(subject)) =
            (fields.next(), fields.next(), fields.next(), fields.next(), fields.next(), fields.next(), fields.next(), fields.next())
        else { continue; };
        if commits.len() == limit {
            truncated = true;
            break;
        }
        commits.push(GitCommit {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            parents: parents.split_whitespace().map(str::to_owned).collect(),
            author: author.to_string(),
            email: email.to_string(),
            date: date.to_string(),
            subject: subject.to_string(),
            refs: refs
                .split(", ")
                .filter(|reference| !reference.is_empty() && !reference.ends_with("/HEAD"))
                .map(str::to_owned)
                .collect(),
            unpushed: false,
        });
    }
    GitLog { commits, truncated, remotes: Vec::new() }
}

fn remote_local_name(workspace: &Path, remote_branch: &str) -> Result<String> {
    let raw = run(workspace, &["remote"])?;
    let remotes = String::from_utf8_lossy(&raw);
    let mut matched: Option<&str> = None;
    for remote in remotes.lines().map(str::trim).filter(|remote| !remote.is_empty()) {
        let is_prefix = remote_branch.len() > remote.len() + 1
            && remote_branch.starts_with(remote)
            && remote_branch.as_bytes()[remote.len()] == b'/';
        if is_prefix && matched.map_or(true, |current| remote.len() > current.len()) {
            matched = Some(remote);
        }
    }
    let remote = matched.with_context(|| format!("Remote non riconosciuto per {remote_branch}"))?;
    Ok(remote_branch[remote.len() + 1..].to_string())
}

pub fn checkout(workspace: &Path, branch: &str, remote: bool) -> Result<()> {
    let all = branches(workspace)?;
    if remote {
        let item = all.iter().find(|item| item.remote && item.name == branch)
            .with_context(|| format!("Il branch remoto non esiste: {branch}"))?;
        let local = remote_local_name(workspace, &item.name)?;
        if local.is_empty() || local.starts_with('-') {
            bail!("Nome branch non valido: {local}");
        }
        if all.iter().any(|item| !item.remote && item.name == local) {
            run(workspace, &["switch", "--", &local])?;
        } else {
            run(workspace, &["switch", "--track", "-c", &local, &item.name])?;
        }
    } else {
        if !all.iter().any(|item| !item.remote && item.name == branch) {
            bail!("Il branch locale non esiste: {branch}");
        }
        // Git refuses a switch that would overwrite local changes. Never use --force.
        run(workspace, &["switch", "--", branch])?;
    }
    Ok(())
}

pub fn create_branch(workspace: &Path, name: &str, base: Option<&str>, keep_changes: bool) -> Result<GitStatus> {
    let name = name.trim();
    if name.is_empty() {
        bail!("Inserisci il nome del branch");
    }
    if name.starts_with('-') {
        bail!("Nome branch non valido: {name}");
    }
    run(workspace, &["check-ref-format", "--branch", name])
        .with_context(|| format!("Nome branch non valido: {name}"))?;
    let all = branches(workspace)?;
    if all.iter().any(|item| !item.remote && item.name == name) {
        bail!("Il branch locale esiste già: {name}");
    }
    let current = String::from_utf8_lossy(
        &run(workspace, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default(),
    ).trim().to_string();
    let base = base.map(str::trim).filter(|base| !base.is_empty() && *base != current);
    let Some(base) = base else {
        run(workspace, &["switch", "-c", name])?;
        return Ok(status(workspace));
    };
    if !all.iter().any(|item| item.name == base) {
        bail!("Il branch di partenza non esiste: {base}");
    }
    if status(workspace).changes.is_empty() {
        run(workspace, &["switch", "-c", name, base])?;
        return Ok(status(workspace));
    }
    let message = format!("helmcode: modifiche per il nuovo branch {name}");
    run(workspace, &["stash", "push", "--include-untracked", "-m", &message])?;
    if let Err(error) = run(workspace, &["switch", "-c", name, base]) {
        // Put the working tree back on the original branch instead of leaving changes stashed.
        let _ = run(workspace, &["stash", "pop"]);
        return Err(error);
    }
    if keep_changes {
        run(workspace, &["stash", "pop"])
            .context("Branch creato, ma il ripristino delle modifiche è fallito: sono conservate nello stash")?;
    }
    Ok(status(workspace))
}

fn unmerged_paths(workspace: &Path) -> Vec<String> {
    let raw = match run(workspace, &["diff", "--name-only", "--diff-filter=U", "-z"]) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&raw)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| path.to_string())
        .collect()
}

pub fn merge(workspace: &Path, source: &str, target: &str) -> Result<MergeOutcome> {
    let all = branches(workspace)?;
    let source_item = all
        .iter()
        .find(|item| item.name == source)
        .with_context(|| format!("Il branch da mergiare non esiste: {source}"))?;
    let target_item = all
        .iter()
        .find(|item| !item.remote && item.name == target)
        .with_context(|| format!("Il branch di destinazione non esiste: {target}"))?;
    if !source_item.remote && source == target_item.name {
        bail!("Il branch da mergiare e la destinazione coincidono");
    }
    let current = String::from_utf8_lossy(&run(workspace, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default())
        .trim()
        .to_string();
    if current != target_item.name {
        // Git refuses a switch that would overwrite local changes. Never use --force.
        run(workspace, &["switch", "--", &target_item.name])?;
    }
    match run(workspace, &["merge", "--no-edit", source]) {
        Ok(_) => Ok(MergeOutcome { status: status(workspace), conflicts: Vec::new() }),
        Err(error) => {
            let conflicts = unmerged_paths(workspace);
            if conflicts.is_empty() {
                Err(error)
            } else {
                Ok(MergeOutcome { status: status(workspace), conflicts })
            }
        }
    }
}

pub fn complete_merge(workspace: &Path) -> Result<GitStatus> {
    if !unmerged_paths(workspace).is_empty() {
        bail!("Restano conflitti da risolvere prima di completare l'operazione");
    }
    if run(workspace, &["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).is_ok() {
        run(workspace, &["-c", "core.editor=true", "cherry-pick", "--continue"])
            .context("Impossibile completare il cherry-pick")?;
    } else if run(workspace, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok() {
        run(workspace, &["commit", "--no-edit"])?;
    } else {
        bail!("Nessuna operazione Git in corso");
    }
    Ok(status(workspace))
}

pub fn abort_merge(workspace: &Path) -> Result<GitStatus> {
    if run(workspace, &["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).is_ok() {
        run(workspace, &["cherry-pick", "--abort"]).context("Nessun cherry-pick in corso")?;
    } else if run(workspace, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok() {
        run(workspace, &["merge", "--abort"]).context("Nessun merge in corso")?;
    } else {
        bail!("Nessuna operazione Git in corso");
    }
    Ok(status(workspace))
}

pub fn cherry_pick(workspace: &Path, hash: &str) -> Result<MergeOutcome> {
    let hash = hash.trim();
    if hash.is_empty() || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
        bail!("Hash commit non valido");
    }
    match run(workspace, &["cherry-pick", hash]) {
        Ok(_) => Ok(MergeOutcome { status: status(workspace), conflicts: Vec::new() }),
        Err(error) => {
            let conflicts = unmerged_paths(workspace);
            if conflicts.is_empty() {
                Err(error)
            } else {
                Ok(MergeOutcome { status: status(workspace), conflicts })
            }
        }
    }
}

pub fn resolve_conflict(workspace: &Path, path: &str, content: &str) -> Result<()> {
    fs_util::write_text(workspace, path, content)?;
    run(workspace, &["add", "--", path])?;
    Ok(())
}

pub fn take_side(workspace: &Path, path: &str, side: &str) -> Result<()> {
    let (flag, stage) = match side {
        "ours" => ("--ours", "2"),
        "theirs" => ("--theirs", "3"),
        other => bail!("Lato del merge non valido: {other}"),
    };
    let listed = run(workspace, &["ls-files", "--stage", "--", path])?;
    let has_side = String::from_utf8_lossy(&listed)
        .lines()
        .any(|line| line.split_whitespace().nth(2) == Some(stage));
    if has_side {
        run(workspace, &["checkout", flag, "--", path])?;
        run(workspace, &["add", "--", path])?;
    } else {
        // A modify/delete conflict has no version on the chosen side: keep the deletion.
        run(workspace, &["rm", "-f", "--", path])?;
    }
    Ok(())
}

fn push_current_branch(workspace: &Path) -> Result<()> {
    let branch = String::from_utf8_lossy(&run(workspace, &["symbolic-ref", "--short", "-q", "HEAD"])?)
        .trim()
        .to_string();
    if branch.is_empty() || branch.starts_with('-') {
        bail!("Il branch corrente non è valido per il push");
    }
    let has_upstream = run(workspace, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_ok();
    let pushed = if has_upstream {
        run(workspace, &["push"])
    } else {
        let remotes = run(workspace, &["remote"])?;
        let remotes: Vec<String> = String::from_utf8_lossy(&remotes).lines().map(str::trim).filter(|remote| !remote.is_empty()).map(str::to_owned).collect();
        let Some(remote) = remotes.iter().find(|remote| remote.as_str() == "origin").or_else(|| remotes.first()) else {
            bail!("Nessun remote è configurato per il push");
        };
        run(workspace, &["push", "--set-upstream", remote, &branch])
    };
    pushed?;
    Ok(())
}

pub fn commit(workspace: &Path, message: &str, push: bool) -> Result<GitStatus> {
    let message = message.trim();
    if message.is_empty() {
        bail!("Inserisci un messaggio di commit");
    }
    if status(workspace).changes.is_empty() {
        bail!("Nessuna modifica da committare");
    }
    // ponytail: stage the whole workspace; add a staging UI when partial commits matter.
    run(workspace, &["add", "-A", "--", "."])?;
    run(workspace, &["commit", "-m", message])?;
    if push {
        if let Err(error) = push_current_branch(workspace) {
            bail!("Commit creato in locale, ma il push è fallito: {error:#}");
        }
    }
    Ok(status(workspace))
}

pub fn push(workspace: &Path) -> Result<GitStatus> {
    push_current_branch(workspace)?;
    Ok(status(workspace))
}

pub fn pull(workspace: &Path) -> Result<MergeOutcome> {
    run(workspace, &["fetch", "--all", "--prune"])?;
    run(workspace, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .context("Nessun branch remoto associato per il pull")?;
    let current = status(workspace);
    if current.behind == 0 {
        return Ok(MergeOutcome { status: current, conflicts: Vec::new() });
    }
    match run(workspace, &["merge", "--no-edit", "@{upstream}"]) {
        Ok(_) => Ok(MergeOutcome { status: status(workspace), conflicts: Vec::new() }),
        Err(error) => {
            let conflicts = unmerged_paths(workspace);
            if conflicts.is_empty() {
                Err(error)
            } else {
                Ok(MergeOutcome { status: status(workspace), conflicts })
            }
        }
    }
}

pub fn file_diff(workspace: &Path, path: &str, content: Option<String>) -> Result<FileDiff> {
    let absolute = fs_util::resolve_workspace_path(workspace, path)?;
    let normalized = fs_util::normalize_relative(path);
    let prefix = String::from_utf8(run(workspace, &["rev-parse", "--show-prefix"])?).context("percorso Git non UTF-8")?;
    let git_path = format!("{}{normalized}", prefix.trim_end_matches(['\r', '\n']));
    let head_exists = run(workspace, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let exists_in_head = if head_exists {
        !run(workspace, &["ls-tree", "--full-tree", "-z", "HEAD", "--", &git_path])?.is_empty()
    } else { false };
    let original = if exists_in_head {
        let raw = run(workspace, &["show", &format!("HEAD:{git_path}")])?;
        if raw.len() > 2 * 1024 * 1024 { bail!("Diff non disponibile per file superiori a 2 MB"); }
        String::from_utf8(raw).context("Il file Git è binario o non è UTF-8")?
    } else { String::new() };
    let current = match content {
        Some(text) => text,
        None if !absolute.exists() => String::new(),
        None => fs_util::read_text(workspace, path)?,
    };
    build_diff(&original, &current, !exists_in_head)
}

pub fn revert_file(workspace: &Path, path: &str) -> Result<()> {
    let absolute = fs_util::resolve_workspace_path(workspace, path)?;
    let normalized = fs_util::normalize_relative(path);
    let prefix = String::from_utf8(run(workspace, &["rev-parse", "--show-prefix"])?).context("percorso Git non UTF-8")?;
    let git_path = format!("{}{normalized}", prefix.trim_end_matches(['\r', '\n']));
    let head_exists = run(workspace, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let in_head = head_exists && !run(workspace, &["ls-tree", "--full-tree", "-z", "HEAD", "--", &git_path])?.is_empty();
    if in_head {
        run(workspace, &["checkout", "HEAD", "--", &git_path])?;
        return Ok(());
    }
    if run(workspace, &["ls-files", "--error-unmatch", "--", &git_path]).is_ok() {
        let mut args = if head_exists {
            vec!["reset", "-q", "HEAD", "--"]
        } else {
            vec!["rm", "--cached", "--force", "--"]
        };
        args.push(git_path.as_str());
        run(workspace, &args)?;
    }
    if absolute.exists() {
        if absolute.is_dir() { bail!("Il percorso non è un file: {path}"); }
        std::fs::remove_file(&absolute).with_context(|| format!("impossibile eliminare {}", absolute.display()))?;
    }
    Ok(())
}

pub fn revert_all(workspace: &Path) -> Result<()> {
    if run(workspace, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        run(workspace, &["reset", "-q", "HEAD", "--", "."])?;
        run(workspace, &["checkout", "--", "."])?;
    } else {
        let _ = run(workspace, &["rm", "--cached", "-r", "--force", "--", "."]);
    }
    run(workspace, &["clean", "-fd", "--", "."])?;
    Ok(())
}

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn validate_commit(hash: &str) -> Result<()> {
    if hash.len() < 7 || hash.len() > 40 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        bail!("commit non valido: {hash}");
    }
    Ok(())
}

fn commit_base(workspace: &Path, hash: &str) -> Result<String> {
    match run(workspace, &["rev-parse", "--verify", &format!("{hash}^1")]) {
        Ok(raw) => Ok(String::from_utf8_lossy(&raw).trim().to_string()),
        Err(_) => Ok(EMPTY_TREE.to_string()),
    }
}

pub fn commit_files(workspace: &Path, hash: &str) -> Result<Vec<GitCommitFile>> {
    validate_commit(hash)?;
    let base = commit_base(workspace, hash)?;
    let raw = run(workspace, &["diff", "--name-status", "-z", "-M", &base, hash])?;
    Ok(parse_commit_files(&raw))
}

fn parse_commit_files(raw: &[u8]) -> Vec<GitCommitFile> {
    let mut files = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0).filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let status = String::from_utf8_lossy(status);
        let kind = status.chars().next().unwrap_or('?').to_string();
        let Some(first) = fields.next() else { break; };
        let first = String::from_utf8_lossy(first).to_string();
        if matches!(kind.as_str(), "R" | "C") {
            let Some(second) = fields.next() else { break; };
            files.push(GitCommitFile { path: String::from_utf8_lossy(second).to_string(), old_path: Some(first), status: kind });
        } else {
            files.push(GitCommitFile { path: first, old_path: None, status: kind });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

fn blob_text(workspace: &Path, spec: &str) -> Result<Option<String>> {
    let raw = match run(workspace, &["show", spec]) {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    if raw.len() > 2 * 1024 * 1024 { bail!("Diff non disponibile per file superiori a 2 MB"); }
    Ok(Some(String::from_utf8(raw).context("Il file Git è binario o non è UTF-8")?))
}

pub fn commit_file_diff(workspace: &Path, hash: &str, path: &str, old_path: Option<&str>) -> Result<FileDiff> {
    validate_commit(hash)?;
    let base = commit_base(workspace, hash)?;
    let before = blob_text(workspace, &format!("{base}:{}", old_path.unwrap_or(path)))?;
    let after = blob_text(workspace, &format!("{hash}:{path}"))?;
    let is_new = before.is_none();
    build_diff(&before.unwrap_or_default(), &after.unwrap_or_default(), is_new)
}

fn unify_line_endings(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

fn build_diff(original: &str, current: &str, is_new: bool) -> Result<FileDiff> {
    if original.len() + current.len() > 4 * 1024 * 1024 || original.lines().count() + current.lines().count() > 40_000 {
        bail!("Il file è troppo grande per l'anteprima delle differenze");
    }
    if original.contains('\0') || current.contains('\0') { bail!("Il file è binario: anteprima non disponibile"); }
    let original = unify_line_endings(original);
    let current = unify_line_endings(current);
    let diff = TextDiff::from_lines(&original, &current);
    let mut added = 0;
    let mut removed = 0;
    let mut lines = Vec::new();
    // ponytail: every line of the file is returned; virtualize if files near the 40k cap feel slow.
    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Delete => { removed += 1; "remove" },
            ChangeTag::Insert => { added += 1; "add" },
            ChangeTag::Equal => "context",
        };
        lines.push(DiffLine {
            kind: kind.into(), text: change.value().trim_end_matches('\n').trim_end_matches('\r').into(),
            old_line: change.old_index().map(|index| index + 1),
            new_line: change.new_index().map(|index| index + 1),
        });
    }
    Ok(FileDiff { lines, added, removed, is_new })
}

fn checked_workspace(state: &AppState, expected: &str) -> Result<std::path::PathBuf, String> {
    let root = state.workspace_root();
    if root != Path::new(expected) { return Err("Il workspace è cambiato: riprova".into()); }
    Ok(root)
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, expected_workspace: String) -> Result<Vec<GitBranch>, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || branches(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, expected_workspace: String, limit: usize) -> Result<GitLog, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || log(&root, limit)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, AppState>, expected_workspace: String, branch: String, remote: bool) -> Result<(), String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || checkout(&root, &branch, remote)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_create_branch(state: State<'_, AppState>, expected_workspace: String, name: String, base: Option<String>, keep_changes: bool) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || create_branch(&root, &name, base.as_deref(), keep_changes)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, expected_workspace: String, message: String, push: bool) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || commit(&root, &message, push)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, expected_workspace: String) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || push(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, expected_workspace: String) -> Result<MergeOutcome, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || pull(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_cherry_pick(state: State<'_, AppState>, expected_workspace: String, hash: String) -> Result<MergeOutcome, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || cherry_pick(&root, &hash)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_revert_file(state: State<'_, AppState>, expected_workspace: String, path: String) -> Result<(), String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || revert_file(&root, &path)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_revert_all(state: State<'_, AppState>, expected_workspace: String) -> Result<(), String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || revert_all(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_merge(state: State<'_, AppState>, expected_workspace: String, source: String, target: String) -> Result<MergeOutcome, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || merge(&root, &source, &target)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_complete_merge(state: State<'_, AppState>, expected_workspace: String) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || complete_merge(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_abort_merge(state: State<'_, AppState>, expected_workspace: String) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || abort_merge(&root)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_resolve_conflict(state: State<'_, AppState>, expected_workspace: String, path: String, content: String) -> Result<(), String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || resolve_conflict(&root, &path, &content)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_take_side(state: State<'_, AppState>, expected_workspace: String, path: String, side: String) -> Result<(), String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || take_side(&root, &path, &side)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_file_diff(state: State<'_, AppState>, expected_workspace: String, path: String, content: Option<String>) -> Result<FileDiff, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || file_diff(&root, &path, content)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_commit_files(state: State<'_, AppState>, expected_workspace: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || commit_files(&root, &hash)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_commit_file_diff(state: State<'_, AppState>, expected_workspace: String, hash: String, path: String, old_path: Option<String>) -> Result<FileDiff, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || commit_file_diff(&root, &hash, &path, old_path.as_deref())).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, expected_workspace: String) -> Result<GitStatus, String> {
    let root = checked_workspace(&state, &expected_workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        run(&root, &["fetch", "--all", "--prune"])?;
        Ok(status(&root))
    }).await.map_err(|error| error.to_string())?.map_err(|error: anyhow::Error| error.to_string())
}

pub fn status(workspace: &Path) -> GitStatus {
    let raw = match run(workspace, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]) {
        Ok(raw) => raw,
        Err(_) => {
            return GitStatus {
                is_repo: false,
                branch: String::new(),
                changes: Vec::new(),
                upstream: None,
                ahead: 0,
                behind: 0,
                merging: false,
                cherry_picking: false,
            };
        }
    };
    // One status command provides branch, upstream, divergence and changes.
    // Resolve the workspace prefix and per-worktree operation markers together.
    let context = run(workspace, &["rev-parse", "--show-prefix", "--git-path", "MERGE_HEAD", "--git-path", "CHERRY_PICK_HEAD"])
        .unwrap_or_default();
    let context = String::from_utf8_lossy(&context);
    let mut lines = context.lines();
    let prefix = lines.next().unwrap_or_default().trim_end_matches('\r');
    let merge_path = lines.next().unwrap_or_default().trim_end_matches(['\r', '\n']);
    let cherry_pick_path = lines.next().unwrap_or_default().trim_end_matches(['\r', '\n']);
    let mut result = parse_status_v2_z(&raw, prefix);
    result.merging = !merge_path.is_empty() && workspace.join(merge_path).is_file();
    result.cherry_picking = !cherry_pick_path.is_empty() && workspace.join(cherry_pick_path).is_file();
    result
}

fn parse_status_v2_z(input: &[u8], workspace_prefix: &str) -> GitStatus {
    let mut branch = "HEAD".to_string();
    let mut upstream = None;
    let (mut ahead, mut behind) = (0, 0);
    let mut changes = Vec::new();
    let mut fields = input.split(|byte| *byte == 0).filter(|field| !field.is_empty());
    while let Some(entry) = fields.next() {
        if let Some(header) = entry.strip_prefix(b"# ") {
            let header = String::from_utf8_lossy(header);
            if let Some(value) = header.strip_prefix("branch.head ") {
                branch = if value == "(detached)" { "HEAD".into() } else { value.into() };
            } else if let Some(value) = header.strip_prefix("branch.upstream ") {
                upstream = Some(value.to_string());
            } else if let Some(value) = header.strip_prefix("branch.ab ") {
                let mut counts = value.split_whitespace();
                ahead = counts.next().and_then(|value| value.strip_prefix('+')).and_then(|value| value.parse().ok()).unwrap_or(0);
                behind = counts.next().and_then(|value| value.strip_prefix('-')).and_then(|value| value.parse().ok()).unwrap_or(0);
            }
            continue;
        }
        let kind = entry.first().copied().unwrap_or_default();
        let field_count = match kind {
            b'1' => 9,
            b'2' => 10,
            b'u' => 11,
            b'?' => 2,
            _ => continue,
        };
        let mut parts = entry.splitn(field_count, |byte| *byte == b' ');
        let _kind = parts.next();
        let (index, worktree, path) = if kind == b'?' {
            ('?', '?', parts.next())
        } else {
            let xy = parts.next().unwrap_or_default();
            let index = xy.first().copied().unwrap_or(b'.');
            let worktree = xy.get(1).copied().unwrap_or(b'.');
            let normalize = |value| if value == b'.' { ' ' } else { value as char };
            (normalize(index), normalize(worktree), parts.last())
        };
        // The source path of a rename/copy is a separate NUL-delimited field.
        if kind == b'2' { let _original = fields.next(); }
        let Some(path) = path else { continue; };
        let path = String::from_utf8_lossy(path);
        let Some(path) = strip_prefix(&path, workspace_prefix) else { continue; };
        changes.push(make_change(path, index, worktree));
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    GitStatus {
        is_repo: true,
        branch,
        changes,
        upstream,
        ahead,
        behind,
        merging: false,
        cherry_picking: false,
    }
}

#[cfg(test)]
// Keep the previous parser as a reference for status-format equivalence tests.
pub fn parse_status_z(input: &[u8], workspace_prefix: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut fields = input
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());

    while let Some(entry) = fields.next() {
        if entry.len() < 3 {
            continue;
        }
        let index = entry[0] as char;
        let worktree = entry[1] as char;
        let path = String::from_utf8_lossy(&entry[3..]).to_string();

        if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            let _original = fields.next();
        }

        let Some(path) = strip_prefix(&path, workspace_prefix) else {
            continue;
        };
        changes.push(make_change(path, index, worktree));
    }

    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

fn make_change(path: String, index: char, worktree: char) -> GitChange {
    let untracked = index == '?' && worktree == '?';
    let conflicted = index == 'U' || worktree == 'U' || matches!((index, worktree), ('A', 'A') | ('D', 'D'));
    let label = if conflicted { "!".to_string() }
        else if untracked { "U".to_string() }
        else if index != ' ' { index.to_string() }
        else { worktree.to_string() };
    GitChange { path, index: index.to_string(), worktree: worktree.to_string(), label,
        staged: index != ' ' && index != '?' && !conflicted, untracked }
}

fn strip_prefix(path: &str, prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        return Some(path.to_string());
    }
    path.strip_prefix(prefix).map(|value| value.to_string())
}

fn run(workspace: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(workspace)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().context("git non disponibile")?;
    if !output.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::{abort_merge, branches, build_diff, checkout, cherry_pick, commit, commit_file_diff, commit_files, complete_merge, create_branch, file_diff, log, merge, parse_log, parse_status_v2_z, parse_status_z, pull, push, resolve_conflict, revert_all, revert_file, run, status, take_side};
    use std::fs;
    use std::path::PathBuf;

    struct Repository(PathBuf);
    impl Repository {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("helmcode-git-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            run(&path, &["init", "--initial-branch=main"]).unwrap();
            run(&path, &["config", "user.name", "helmcode tests"]).unwrap();
            run(&path, &["config", "user.email", "helmcode@example.test"]).unwrap();
            Self(path)
        }
    }
    impl Drop for Repository {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).ok(); }
    }

    #[test]
    fn remote_counts_follow_fetch_and_ignore_uncommitted_files() {
        let remote = Repository::new();
        fs::write(remote.0.join("base.txt"), "initial").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "initial"]).unwrap();
        let local = Repository::new();
        run(&local.0, &["remote", "add", "origin", remote.0.to_str().unwrap()]).unwrap();
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        run(&local.0, &["checkout", "-B", "main", "origin/main"]).unwrap();
        fs::write(local.0.join("local.txt"), "unsaved").unwrap();
        let dirty = status(&local.0);
        assert_eq!((dirty.ahead, dirty.behind), (0, 0));
        assert!(!dirty.changes.is_empty());
        assert_eq!(dirty.upstream.as_deref(), Some("origin/main"));
        run(&local.0, &["add", "."]).unwrap();
        run(&local.0, &["commit", "-m", "local"]).unwrap();
        assert_eq!((status(&local.0).ahead, status(&local.0).behind), (1, 0));
        fs::write(remote.0.join("remote.txt"), "remote").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "remote"]).unwrap();
        assert_eq!(status(&local.0).behind, 0);
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        let divergent = status(&local.0);
        assert_eq!((divergent.ahead, divergent.behind), (1, 1));
        assert!(!local.0.join("remote.txt").exists(), "Fetch must not change working files");
        run(&local.0, &["branch", "--unset-upstream"]).unwrap();
        let untracked = status(&local.0);
        assert_eq!((untracked.ahead, untracked.behind), (0, 0));
        assert!(untracked.upstream.is_none());
    }

    #[test]
    fn commit_stages_changes_and_pushes_with_upstream_fallback() {
        let remote = Repository::new();
        fs::write(remote.0.join("base.txt"), "initial").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "initial"]).unwrap();
        run(&remote.0, &["config", "receive.denyCurrentBranch", "ignore"]).unwrap();
        let local = Repository::new();
        run(&local.0, &["remote", "add", "origin", remote.0.to_str().unwrap()]).unwrap();
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        run(&local.0, &["checkout", "-B", "main", "origin/main"]).unwrap();

        assert!(commit(&local.0, "   ", false).is_err());
        assert!(commit(&local.0, "nothing to commit", false).is_err());

        fs::write(local.0.join("local.txt"), "local").unwrap();
        let committed = commit(&local.0, "local change", false).unwrap();
        assert!(committed.changes.is_empty());
        assert_eq!(committed.ahead, 1);
        let history = log(&local.0, 10).unwrap();
        assert_eq!(history.commits[0].subject, "local change");
        assert!(history.commits[0].unpushed);
        assert!(!history.commits[1].unpushed);

        fs::write(local.0.join("pushed.txt"), "pushed").unwrap();
        let pushed = commit(&local.0, "push change", true).unwrap();
        assert!(pushed.changes.is_empty());
        assert_eq!(pushed.ahead, 0);
        assert!(log(&local.0, 10).unwrap().commits.iter().all(|commit| !commit.unpushed));
        let remote_head = String::from_utf8(run(&remote.0, &["log", "-1", "--format=%s", "main"]).unwrap()).unwrap();
        assert_eq!(remote_head.trim(), "push change");
    }

    #[test]
    fn push_and_pull_follow_upstream() {
        let remote = Repository::new();
        fs::write(remote.0.join("base.txt"), "initial").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "initial"]).unwrap();
        run(&remote.0, &["config", "receive.denyCurrentBranch", "ignore"]).unwrap();
        let local = Repository::new();
        run(&local.0, &["remote", "add", "origin", remote.0.to_str().unwrap()]).unwrap();
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        run(&local.0, &["checkout", "-B", "main", "origin/main"]).unwrap();

        fs::write(local.0.join("pushed.txt"), "pushed").unwrap();
        run(&local.0, &["add", "."]).unwrap();
        run(&local.0, &["commit", "-m", "to push"]).unwrap();
        assert_eq!(status(&local.0).ahead, 1);
        let pushed = push(&local.0).unwrap();
        assert_eq!(pushed.ahead, 0);
        let remote_head = String::from_utf8(run(&remote.0, &["log", "-1", "--format=%s", "main"]).unwrap()).unwrap();
        assert_eq!(remote_head.trim(), "to push");

        fs::write(remote.0.join("remote.txt"), "remote").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "from remote"]).unwrap();
        let fast_forward = pull(&local.0).unwrap();
        assert!(fast_forward.conflicts.is_empty());
        assert_eq!((fast_forward.status.ahead, fast_forward.status.behind), (0, 0));
        assert_eq!(fs::read_to_string(local.0.join("remote.txt")).unwrap(), "remote");

        fs::write(local.0.join("base.txt"), "local edit").unwrap();
        run(&local.0, &["add", "."]).unwrap();
        run(&local.0, &["commit", "-m", "local edit"]).unwrap();
        fs::write(remote.0.join("base.txt"), "remote edit").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "remote edit"]).unwrap();
        let divergent = pull(&local.0).unwrap();
        assert_eq!(divergent.conflicts, vec!["base.txt".to_string()]);
        assert!(divergent.status.merging);
        abort_merge(&local.0).unwrap();
    }

    #[test]
    fn diff_reports_every_line_with_changes_marked() {
        let diff = build_diff("one\ntwo\nthree\n", "one\nnew\nthree\nextra\n", false).unwrap();
        assert_eq!(diff.added, 2);
        assert_eq!(diff.removed, 1);
        assert_eq!(diff.lines.len(), 5);
        assert_eq!(diff.lines[0].kind, "context");
        assert_eq!(diff.lines[0].old_line, Some(1));
        assert!(diff.lines.iter().all(|line| line.kind != "gap"));
        assert!(diff.lines.iter().any(|line| line.kind == "remove" && line.old_line == Some(2)));
        assert!(diff.lines.iter().any(|line| line.kind == "add" && line.new_line == Some(4)));
        let unchanged = build_diff("same\n", "same\n", false).unwrap();
        assert_eq!((unchanged.added, unchanged.removed), (0, 0));
        assert!(unchanged.lines.iter().all(|line| line.kind == "context"));
        assert!(build_diff("binary\0", "", false).is_err());
    }

    #[test]
    fn diff_ignores_line_ending_changes() {
        let unchanged = build_diff("same\r\nfile\r\n", "same\nfile\n", false).unwrap();
        assert_eq!((unchanged.added, unchanged.removed), (0, 0));
        assert_eq!(unchanged.lines.len(), 2);
        assert!(unchanged.lines.iter().all(|line| line.kind == "context"));
        let diff = build_diff("a\r\nb\r\n", "a\nb\nc\n", false).unwrap();
        assert_eq!((diff.added, diff.removed), (1, 0));
    }

    #[test]
    fn commit_files_and_diff_follow_first_parent_and_renames() {
        let repo = Repository::new();
        fs::write(repo.0.join("one.txt"), "one\n").unwrap();
        fs::write(repo.0.join("old.txt"), "old\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        let first = String::from_utf8(run(&repo.0, &["rev-parse", "HEAD"]).unwrap()).unwrap().trim().to_string();
        fs::write(repo.0.join("one.txt"), "one\ntwo\n").unwrap();
        run(&repo.0, &["mv", "old.txt", "new.txt"]).unwrap();
        run(&repo.0, &["commit", "-a", "-m", "second"]).unwrap();
        let second = String::from_utf8(run(&repo.0, &["rev-parse", "HEAD"]).unwrap()).unwrap().trim().to_string();

        let files = commit_files(&repo.0, &second).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file.path == "one.txt" && file.status == "M"));
        assert!(files.iter().any(|file| file.path == "new.txt" && file.old_path.as_deref() == Some("old.txt") && file.status == "R"));

        let modified = commit_file_diff(&repo.0, &second, "one.txt", None).unwrap();
        assert_eq!((modified.added, modified.removed), (1, 0));
        let renamed = commit_file_diff(&repo.0, &second, "new.txt", Some("old.txt")).unwrap();
        assert_eq!((renamed.added, renamed.removed), (0, 0));

        let root_files = commit_files(&repo.0, &first).unwrap();
        assert_eq!(root_files.len(), 2);
        assert!(root_files.iter().all(|file| file.status == "A"));
        assert!(commit_files(&repo.0, "--help").is_err());
    }

    #[test]
    fn reads_head_for_nested_workspace_unsaved_and_deleted_files() {
        let repo = Repository::new();
        let nested = repo.0.join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file.txt"), "committed\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        let diff = file_diff(&nested, "file.txt", Some("unsaved\n".into())).unwrap();
        assert!(!diff.is_new);
        assert_eq!((diff.added, diff.removed), (1, 1));
        fs::remove_file(nested.join("file.txt")).unwrap();
        let deleted = file_diff(&nested, "file.txt", None).unwrap();
        assert_eq!((deleted.added, deleted.removed), (0, 1));
        fs::write(nested.join("new.txt"), "new\n").unwrap();
        let new = file_diff(&nested, "new.txt", None).unwrap();
        assert!(new.is_new);
        assert_eq!((new.added, new.removed), (1, 0));
        assert!(file_diff(&nested, "../escape.txt", None).is_err());
    }

    #[test]
    fn switching_branches_preserves_conflicting_local_changes() {
        let repo = Repository::new();
        fs::write(repo.0.join("file.txt"), "main\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("file.txt"), "feature\n").unwrap();
        run(&repo.0, &["commit", "-am", "feature"]).unwrap();
        checkout(&repo.0, "main", false).unwrap();
        fs::write(repo.0.join("file.txt"), "local work\n").unwrap();
        assert!(checkout(&repo.0, "feature", false).is_err());
        assert_eq!(fs::read_to_string(repo.0.join("file.txt")).unwrap(), "local work\n");
        assert!(branches(&repo.0).unwrap().iter().any(|branch| branch.name == "main" && branch.current));
    }

    #[test]
    fn creates_branch_from_current_state_keeping_changes() {
        let repo = Repository::new();
        fs::write(repo.0.join("file.txt"), "main\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        fs::write(repo.0.join("file.txt"), "local work\n").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked\n").unwrap();
        let result = create_branch(&repo.0, "work", None, true).unwrap();
        assert_eq!(result.branch, "work");
        assert_eq!(fs::read_to_string(repo.0.join("file.txt")).unwrap().trim_end(), "local work");
        assert_eq!(fs::read_to_string(repo.0.join("new.txt")).unwrap().trim_end(), "untracked");
        assert!(result.changes.iter().any(|change| change.path == "new.txt" && change.untracked));
    }

    #[test]
    fn creates_branch_from_base_and_carries_changes() {
        let repo = Repository::new();
        fs::write(repo.0.join("shared.txt"), "base\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "feature"]).unwrap();
        fs::write(repo.0.join("shared.txt"), "working\n").unwrap();
        let result = create_branch(&repo.0, "carry", Some("main"), true).unwrap();
        assert_eq!(result.branch, "carry");
        assert!(!repo.0.join("feature.txt").exists(), "new branch starts from the chosen base");
        assert_eq!(fs::read_to_string(repo.0.join("shared.txt")).unwrap().trim_end(), "working");
        let stashes = String::from_utf8_lossy(&run(&repo.0, &["stash", "list"]).unwrap()).to_string();
        assert!(stashes.trim().is_empty(), "carried changes leave no stash behind");
    }

    #[test]
    fn creates_branch_from_base_and_keeps_changes_in_stash() {
        let repo = Repository::new();
        fs::write(repo.0.join("shared.txt"), "base\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("shared.txt"), "working\n").unwrap();
        fs::write(repo.0.join("new.txt"), "untracked\n").unwrap();
        let result = create_branch(&repo.0, "clean", Some("main"), false).unwrap();
        assert_eq!(result.branch, "clean");
        assert!(result.changes.is_empty(), "new branch starts with a clean working tree");
        assert_eq!(fs::read_to_string(repo.0.join("shared.txt")).unwrap().trim_end(), "base");
        assert!(!repo.0.join("new.txt").exists());
        let stashes = String::from_utf8_lossy(&run(&repo.0, &["stash", "list"]).unwrap()).to_string();
        assert!(stashes.contains("helmcode"), "discarded changes remain recoverable in the stash");
    }

    #[test]
    fn creates_branch_from_a_remote_base() {
        let remote = Repository::new();
        fs::write(remote.0.join("base.txt"), "remote\n").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "initial"]).unwrap();
        let local = Repository::new();
        run(&local.0, &["remote", "add", "origin", remote.0.to_str().unwrap()]).unwrap();
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        let result = create_branch(&local.0, "from-remote", Some("origin/main"), true).unwrap();
        assert_eq!(result.branch, "from-remote");
        assert_eq!(fs::read_to_string(local.0.join("base.txt")).unwrap().trim_end(), "remote");
    }

    #[test]
    fn rejects_invalid_or_duplicate_branch_names() {
        let repo = Repository::new();
        fs::write(repo.0.join("file.txt"), "main\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        assert!(create_branch(&repo.0, "main", None, true).is_err());
        assert!(create_branch(&repo.0, "bad..name", None, true).is_err());
        assert!(create_branch(&repo.0, "   ", None, true).is_err());
        assert!(create_branch(&repo.0, "-dash", None, true).is_err());
    }

    fn conflicting_repository() -> Repository {
        let repo = Repository::new();
        fs::write(repo.0.join("file.txt"), "base\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("file.txt"), "feature\n").unwrap();
        run(&repo.0, &["commit", "-am", "feature"]).unwrap();
        run(&repo.0, &["switch", "main"]).unwrap();
        fs::write(repo.0.join("file.txt"), "main\n").unwrap();
        run(&repo.0, &["commit", "-am", "main"]).unwrap();
        repo
    }

    #[test]
    fn merges_local_and_remote_branches_into_the_target() {
        let repo = Repository::new();
        fs::write(repo.0.join("file.txt"), "base\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "development"]).unwrap();
        run(&repo.0, &["switch", "main"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "feature"]).unwrap();
        run(&repo.0, &["switch", "main"]).unwrap();

        let outcome = merge(&repo.0, "feature", "development").unwrap();
        assert!(outcome.conflicts.is_empty());
        assert_eq!(outcome.status.branch, "development");
        assert!(repo.0.join("feature.txt").exists());
        assert_eq!(
            String::from_utf8(run(&repo.0, &["symbolic-ref", "--short", "HEAD"]).unwrap()).unwrap().trim(),
            "development"
        );
        assert!(merge(&repo.0, "feature", "feature").is_err());
        assert!(merge(&repo.0, "missing", "main").is_err());
    }

    #[test]
    fn reports_conflicts_and_completes_or_aborts_the_merge() {
        let repo = conflicting_repository();
        let outcome = merge(&repo.0, "feature", "main").unwrap();
        assert_eq!(outcome.conflicts, vec!["file.txt".to_string()]);
        assert!(status(&repo.0).changes.iter().any(|change| change.label == "!"));
        assert!(status(&repo.0).merging);
        assert!(complete_merge(&repo.0).is_err());

        resolve_conflict(&repo.0, "file.txt", "resolved\n").unwrap();
        let completed = complete_merge(&repo.0).unwrap();
        assert!(completed.changes.is_empty());
        assert!(!completed.merging);
        let parents = String::from_utf8(run(&repo.0, &["log", "-1", "--pretty=%P"]).unwrap()).unwrap();
        assert_eq!(parents.split_whitespace().count(), 2);
        assert_eq!(fs::read_to_string(repo.0.join("file.txt")).unwrap(), "resolved\n");

        let repo = conflicting_repository();
        assert_eq!(merge(&repo.0, "feature", "main").unwrap().conflicts.len(), 1);
        abort_merge(&repo.0).unwrap();
        assert!(status(&repo.0).changes.is_empty());
        assert_eq!(fs::read_to_string(repo.0.join("file.txt")).unwrap().trim(), "main");
    }

    #[test]
    fn cherry_pick_applies_and_reports_conflicts() {
        let repo = Repository::new();
        fs::write(repo.0.join("base.txt"), "base\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "feature"]).unwrap();
        let feature = String::from_utf8(run(&repo.0, &["rev-parse", "feature"]).unwrap()).unwrap().trim().to_string();
        run(&repo.0, &["switch", "main"]).unwrap();

        let applied = cherry_pick(&repo.0, &feature).unwrap();
        assert!(applied.conflicts.is_empty());
        assert_eq!(fs::read_to_string(repo.0.join("feature.txt")).unwrap().trim(), "feature");
        assert_eq!(String::from_utf8(run(&repo.0, &["log", "-1", "--format=%s"]).unwrap()).unwrap().trim(), "feature");

        let conflicting = conflicting_repository();
        let feature = String::from_utf8(run(&conflicting.0, &["rev-parse", "feature"]).unwrap()).unwrap().trim().to_string();
        let outcome = cherry_pick(&conflicting.0, &feature).unwrap();
        assert_eq!(outcome.conflicts, vec!["file.txt".to_string()]);
        assert!(outcome.status.cherry_picking);
        assert!(complete_merge(&conflicting.0).is_err());

        resolve_conflict(&conflicting.0, "file.txt", "resolved\n").unwrap();
        let completed = complete_merge(&conflicting.0).unwrap();
        assert!(!completed.cherry_picking);
        assert_eq!(fs::read_to_string(conflicting.0.join("file.txt")).unwrap().trim(), "resolved");

        let aborted = conflicting_repository();
        let feature = String::from_utf8(run(&aborted.0, &["rev-parse", "feature"]).unwrap()).unwrap().trim().to_string();
        assert_eq!(cherry_pick(&aborted.0, &feature).unwrap().conflicts.len(), 1);
        abort_merge(&aborted.0).unwrap();
        assert!(!status(&aborted.0).cherry_picking);
        assert_eq!(fs::read_to_string(aborted.0.join("file.txt")).unwrap().trim(), "main");
    }

    #[test]
    fn takes_a_side_for_a_conflicted_file() {
        let repo = conflicting_repository();
        assert_eq!(merge(&repo.0, "feature", "main").unwrap().conflicts.len(), 1);
        take_side(&repo.0, "file.txt", "theirs").unwrap();
        assert!(!status(&repo.0).changes.iter().any(|change| change.label == "!"));
        complete_merge(&repo.0).unwrap();
        assert_eq!(fs::read_to_string(repo.0.join("file.txt")).unwrap().trim(), "feature");
    }

    #[test]
    fn remote_branch_checkout_creates_and_reuses_tracking_branch() {
        let remote = Repository::new();
        fs::write(remote.0.join("base.txt"), "base\n").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "base"]).unwrap();
        run(&remote.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(remote.0.join("feature.txt"), "feature\n").unwrap();
        run(&remote.0, &["add", "."]).unwrap();
        run(&remote.0, &["commit", "-m", "feature"]).unwrap();

        let local = Repository::new();
        run(&local.0, &["remote", "add", "origin", remote.0.to_str().unwrap()]).unwrap();
        run(&local.0, &["fetch", "--all", "--prune"]).unwrap();
        assert!(branches(&local.0).unwrap().iter().any(|branch| branch.remote && branch.name == "origin/feature"));

        checkout(&local.0, "origin/feature", true).unwrap();
        assert!(local.0.join("feature.txt").exists());
        let after = branches(&local.0).unwrap();
        assert!(after.iter().any(|branch| !branch.remote && branch.name == "feature" && branch.current));
        assert_eq!(status(&local.0).upstream.as_deref(), Some("origin/feature"));

        run(&local.0, &["switch", "--detach"]).unwrap();
        checkout(&local.0, "origin/feature", true).unwrap();
        assert!(branches(&local.0).unwrap().iter().any(|branch| branch.name == "feature" && branch.current));
        assert!(checkout(&local.0, "origin/missing", true).is_err());
    }

    #[test]
    fn revert_restores_tracked_files_and_removes_new_ones() {
        let repo = Repository::new();
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.0.join("deleted.txt"), "keep\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();

        fs::write(repo.0.join("tracked.txt"), "staged\n").unwrap();
        run(&repo.0, &["add", "tracked.txt"]).unwrap();
        fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();
        revert_file(&repo.0, "tracked.txt").unwrap();
        assert_eq!(fs::read_to_string(repo.0.join("tracked.txt")).unwrap().replace("\r\n", "\n"), "base\n");
        assert!(status(&repo.0).changes.iter().all(|change| change.path != "tracked.txt"));

        fs::remove_file(repo.0.join("deleted.txt")).unwrap();
        revert_file(&repo.0, "deleted.txt").unwrap();
        assert_eq!(fs::read_to_string(repo.0.join("deleted.txt")).unwrap().replace("\r\n", "\n"), "keep\n");

        fs::write(repo.0.join("new.txt"), "new\n").unwrap();
        revert_file(&repo.0, "new.txt").unwrap();
        assert!(!repo.0.join("new.txt").exists());

        fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
        run(&repo.0, &["add", "staged.txt"]).unwrap();
        revert_file(&repo.0, "staged.txt").unwrap();
        assert!(!repo.0.join("staged.txt").exists());
        assert!(status(&repo.0).changes.is_empty());
    }

    #[test]
    fn revert_all_restores_tracked_and_removes_untracked_changes() {
        let repo = Repository::new();
        fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.0.join("deleted.txt"), "keep\n").unwrap();
        fs::write(repo.0.join(".gitignore"), "ignored.txt\n").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();

        fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();
        fs::remove_file(repo.0.join("deleted.txt")).unwrap();
        fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
        run(&repo.0, &["add", "staged.txt"]).unwrap();
        fs::write(repo.0.join("untracked.txt"), "new\n").unwrap();
        fs::write(repo.0.join("ignored.txt"), "keep\n").unwrap();
        assert!(!status(&repo.0).changes.is_empty());

        revert_all(&repo.0).unwrap();
        assert_eq!(fs::read_to_string(repo.0.join("tracked.txt")).unwrap().replace("\r\n", "\n"), "base\n");
        assert_eq!(fs::read_to_string(repo.0.join("deleted.txt")).unwrap().replace("\r\n", "\n"), "keep\n");
        assert!(!repo.0.join("staged.txt").exists());
        assert!(!repo.0.join("untracked.txt").exists());
        assert_eq!(fs::read_to_string(repo.0.join("ignored.txt")).unwrap(), "keep\n");
        assert!(status(&repo.0).changes.is_empty());
    }

    #[test]
    fn parses_modified_untracked_and_renamed_files() {
        let raw = b" M a.txt\0?? b.txt\0R  new.txt\0old.txt\0M  dir/c.txt\0";
        let changes = parse_status_z(raw, "");
        assert_eq!(changes.len(), 4);

        let modified = changes
            .iter()
            .find(|change| change.path == "a.txt")
            .unwrap();
        assert_eq!(modified.label, "M");
        assert!(!modified.staged);

        let untracked = changes
            .iter()
            .find(|change| change.path == "b.txt")
            .unwrap();
        assert!(untracked.untracked);

        let renamed = changes
            .iter()
            .find(|change| change.path == "new.txt")
            .unwrap();
        assert_eq!(renamed.label, "R");
        assert!(renamed.staged);

        let staged = changes
            .iter()
            .find(|change| change.path == "dir/c.txt")
            .unwrap();
        assert!(staged.staged);
    }

    #[test]
    fn parses_v2_headers_changes_renames_and_conflicts() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +12 -3\0\
            1 .M N... 100644 100644 100644 abc abc sub/file with space.txt\0\
            2 R. N... 100644 100644 100644 abc abc R100 sub/new name.txt\0sub/old name.txt\0\
            u UU N... 100644 100644 100644 100644 abc abc abc sub/conflict.txt\0\
            ? sub/untracked\nname.txt\0? other/hidden.txt\0";
        let result = parse_status_v2_z(raw, "sub/");
        assert_eq!(result.branch, "main");
        assert_eq!(result.upstream.as_deref(), Some("origin/main"));
        assert_eq!((result.ahead, result.behind), (12, 3));
        assert_eq!(result.changes.len(), 4);
        assert!(result.changes.iter().any(|change| change.path == "file with space.txt" && change.label == "M" && !change.staged));
        assert!(result.changes.iter().any(|change| change.path == "new name.txt" && change.label == "R" && change.staged));
        assert!(result.changes.iter().any(|change| change.path == "conflict.txt" && change.label == "!" && !change.staged));
        assert!(result.changes.iter().any(|change| change.path == "untracked\nname.txt" && change.untracked));
        assert_eq!(parse_status_v2_z(b"# branch.head (detached)\0", "").branch, "HEAD");
    }

    #[test]
    fn v2_changes_match_the_previous_status_format() {
        let old = b" M sub/a.txt\0?? sub/b.txt\0R  sub/new.txt\0sub/old.txt\0UU sub/conflict.txt\0 M outside.txt\0";
        let new = b"1 .M N... 100644 100644 100644 abc abc sub/a.txt\0\
            ? sub/b.txt\0\
            2 R. N... 100644 100644 100644 abc abc R100 sub/new.txt\0sub/old.txt\0\
            u UU N... 100644 100644 100644 100644 abc abc abc sub/conflict.txt\0\
            1 .M N... 100644 100644 100644 abc abc outside.txt\0";
        for prefix in ["", "sub/"] {
            assert_eq!(serde_json::to_value(parse_status_v2_z(new, prefix).changes).unwrap(),
                serde_json::to_value(parse_status_z(old, prefix)).unwrap());
        }
    }

    #[test]
    fn status_handles_unborn_detached_and_nested_workspaces() {
        let repo = Repository::new();
        let unborn = status(&repo.0);
        assert!(unborn.is_repo);
        assert_eq!(unborn.branch, "main");
        assert!(unborn.upstream.is_none());
        fs::create_dir_all(repo.0.join("sub")).unwrap();
        fs::write(repo.0.join("sub/in.txt"), "in").unwrap();
        fs::write(repo.0.join("outside.txt"), "out").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "initial"]).unwrap();
        run(&repo.0, &["switch", "--detach"]).unwrap();
        fs::write(repo.0.join("sub/in.txt"), "changed").unwrap();
        fs::write(repo.0.join("outside.txt"), "changed").unwrap();
        let nested = status(&repo.0.join("sub"));
        assert_eq!(nested.branch, "HEAD");
        assert_eq!(nested.changes.len(), 1);
        assert_eq!(nested.changes[0].path, "in.txt");
        let plain = std::env::temp_dir().join(format!("helmcode-nonrepo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&plain).unwrap();
        assert!(!status(&plain).is_repo);
        fs::remove_dir_all(plain).unwrap();
    }

    #[test]
    fn strips_the_workspace_prefix() {
        let raw = b" M sub/a.txt\0 M other/b.txt\0";
        let changes = parse_status_z(raw, "sub/");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "a.txt");
    }

    #[test]
    fn keeps_paths_with_spaces() {
        let raw = b" M file with space.txt\0";
        let changes = parse_status_z(raw, "");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "file with space.txt");
    }

    #[test]
    fn identifies_conflicts_and_consumes_worktree_rename_sources() {
        let changes = parse_status_z(b"UU conflict.txt\0 R renamed.txt\0old.txt\0 M file.txt\0", "");
        assert_eq!(changes.len(), 3);
        let conflict = changes.iter().find(|change| change.path == "conflict.txt").unwrap();
        assert_eq!(conflict.label, "!");
        assert!(!conflict.staged);
        assert!(changes.iter().any(|change| change.path == "renamed.txt"));
    }

    #[test]
    fn parses_commit_parents_refs_and_truncation() {
        let separator = '\u{1f}';
        let raw = format!(
            "{separator}aaaa{separator}aaa{separator}bbbb cccc{separator}Ada{separator}ada@example.test{separator}2026-11-12T10:00:00+01:00{separator}HEAD -> main, origin/main, origin/HEAD, tag: v1{separator}feat: graph\n{separator}bbbb{separator}bbb{separator}cccc{separator}Bob{separator}bob@example.test{separator}2026-11-11T09:00:00+01:00{separator}feature{separator}fix: branch\n{separator}cccc{separator}ccc{separator}{separator}Root{separator}root@example.test{separator}2026-11-10T08:00:00+01:00{separator}{separator}initial\n"
        );
        let history = parse_log(raw.as_bytes(), 10);
        assert_eq!(history.commits.len(), 3);
        assert!(!history.truncated);
        let first = &history.commits[0];
        assert_eq!(first.subject, "feat: graph");
        assert_eq!(first.refs, vec!["HEAD -> main", "origin/main", "tag: v1"]);
        assert_eq!(first.parents, vec!["bbbb", "cccc"]);
        assert_eq!(history.commits[1].short_hash, "bbb");
        assert_eq!(history.commits[1].parents, vec!["cccc"]);
        assert!(history.commits[2].parents.is_empty());

        let limited = parse_log(raw.as_bytes(), 1);
        assert!(limited.truncated);
        assert_eq!(limited.commits.len(), 1);
    }

    #[test]
    fn history_lists_all_branches_with_graph_metadata() {
        let repo = Repository::new();
        fs::write(repo.0.join("a.txt"), "a").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "base commit"]).unwrap();
        run(&repo.0, &["switch", "-c", "feature"]).unwrap();
        fs::write(repo.0.join("b.txt"), "b").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "feature commit"]).unwrap();
        run(&repo.0, &["switch", "main"]).unwrap();
        fs::write(repo.0.join("c.txt"), "c").unwrap();
        run(&repo.0, &["add", "."]).unwrap();
        run(&repo.0, &["commit", "-m", "main commit"]).unwrap();
        run(&repo.0, &["merge", "--no-ff", "feature", "-m", "merge feature"]).unwrap();

        let history = log(&repo.0, 50).unwrap();
        assert!(!history.truncated);
        let subjects: Vec<_> = history.commits.iter().map(|commit| commit.subject.as_str()).collect();
        assert!(subjects.contains(&"base commit"));
        assert!(subjects.contains(&"feature commit"));
        assert!(subjects.contains(&"main commit"));
        assert!(subjects.contains(&"merge feature"));
        let merge = history.commits.iter().find(|commit| commit.subject == "merge feature").unwrap();
        assert_eq!(merge.parents.len(), 2);
        assert!(history.commits.iter().any(|commit| commit.refs.iter().any(|reference| reference.contains("main"))));

        let limited = log(&repo.0, 1).unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.commits.len(), 1);
    }
}
