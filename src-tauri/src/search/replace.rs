use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use super::{SearchMatch, SearchQuery, MAX_FILE_BYTES, PREVIEW_AFTER, PREVIEW_BEFORE};
use crate::fs_util::{self, is_skipped_dir};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub preserve_case: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocument {
    pub path: String,
    pub text: String,
    pub saved_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLocation {
    line: u32,
    column: u32,
    matched: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub query: String,
    pub replacement: String,
    #[serde(flatten)]
    pub options: SearchOptions,
    pub path: Option<String>,
    pub r#match: Option<MatchLocation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedDocument {
    pub path: String,
    pub content: String,
    pub saved_content: String,
}

#[derive(Debug, Serialize)]
pub struct ReplaceResult {
    pub count: usize,
    pub documents: Vec<ReplacedDocument>,
}

struct Matcher<'a> {
    literal: SearchQuery<'a>,
    regex: Option<Regex>,
    options: &'a SearchOptions,
}

struct Hit {
    start: usize,
    end: usize,
    line: u32,
    column: u32,
    replacement: String,
    line_start: usize,
    line_end: usize,
}

impl<'a> Matcher<'a> {
    fn new(query: &'a str, options: &'a SearchOptions) -> Result<Self> {
        if query.is_empty() {
            bail!("La query di ricerca è vuota");
        }
        let regex = if options.use_regex {
            Some(
                RegexBuilder::new(query)
                    .case_insensitive(!options.case_sensitive)
                    .build()
                    .context("Espressione regolare non valida")?,
            )
        } else {
            None
        };
        Ok(Self {
            literal: SearchQuery::new(query, options.case_sensitive),
            regex,
            options,
        })
    }

    fn hits(&self, text: &str, replacement: &str, limit: usize) -> Vec<Hit> {
        let mut hits = Vec::new();
        if limit == 0 {
            return hits;
        }
        let mut offset = 0;
        for (index, segment) in text.split_inclusive('\n').enumerate() {
            let line = segment.strip_suffix('\n').unwrap_or(segment);
            let line = line.strip_suffix('\r').unwrap_or(line);
            // Advance through the original line once. Editor positions use UTF-16 units.
            let mut previous_start = 0;
            let mut column = 1;
            let mut make_hit = |start: usize, end: usize, value: String| {
                if self.options.whole_word && !whole_word(line, start, end) {
                    return None;
                }
                column += line[previous_start..start].encode_utf16().count();
                previous_start = start;
                Some(Hit {
                    start: offset + start,
                    end: offset + end,
                    line: (index + 1) as u32,
                    column: column as u32,
                    replacement: if self.options.preserve_case {
                        preserve_case(&line[start..end], &value)
                    } else {
                        value
                    },
                    line_start: offset,
                    line_end: offset + line.len(),
                })
            };
            if let Some(regex) = &self.regex {
                for captures in regex.captures_iter(line) {
                    let found = captures.get(0).expect("regex match");
                    let mut value = String::new();
                    captures.expand(replacement, &mut value);
                    if let Some(hit) = make_hit(found.start(), found.end(), value) {
                        hits.push(hit);
                    }
                    if hits.len() >= limit {
                        break;
                    }
                }
            } else if self.options.case_sensitive {
                for (start, matched) in line.match_indices(self.literal.text) {
                    if let Some(hit) =
                        make_hit(start, start + matched.len(), replacement.to_owned())
                    {
                        hits.push(hit);
                    }
                    if hits.len() >= limit {
                        break;
                    }
                }
            } else if line.is_ascii() && self.literal.text.is_ascii() {
                let needle = self.literal.text.as_bytes();
                let mut next_start = 0;
                for (start, candidate) in line.as_bytes().windows(needle.len()).enumerate() {
                    if start < next_start || !candidate.eq_ignore_ascii_case(needle) {
                        continue;
                    }
                    let end = start + needle.len();
                    next_start = end;
                    if let Some(hit) = make_hit(start, end, replacement.to_owned()) {
                        hits.push(hit);
                    }
                    if hits.len() >= limit {
                        break;
                    }
                }
            } else {
                // Fold each candidate in the source line without rebuilding the remaining
                // character vector after every match (which was quadratic for dense hits).
                let chars: Vec<_> = line.char_indices().collect();
                let mut next_start = 0;
                for (index, candidate) in chars.windows(self.literal.char_count).enumerate() {
                    let start = candidate[0].0;
                    if start < next_start
                        || !candidate.iter().zip(&self.literal.folded).all(
                            |((_, actual), expected)| {
                                actual.to_lowercase().eq(expected.iter().copied())
                            },
                        )
                    {
                        continue;
                    }
                    let end = chars
                        .get(index + self.literal.char_count)
                        .map_or(line.len(), |(byte, _)| *byte);
                    next_start = end;
                    if let Some(hit) = make_hit(start, end, replacement.to_owned()) {
                        hits.push(hit);
                    }
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
            if hits.len() >= limit {
                break;
            }
            offset += segment.len();
        }
        hits
    }
}

fn word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}
fn whole_word(line: &str, start: usize, end: usize) -> bool {
    !line[..start].chars().next_back().is_some_and(word)
        && !line[end..].chars().next().is_some_and(word)
}

fn preserve_case(source: &str, replacement: &str) -> String {
    let letters: Vec<char> = source.chars().filter(|ch| ch.is_alphabetic()).collect();
    if letters.is_empty() {
        return replacement.to_owned();
    }
    if letters.iter().all(|ch| ch.is_uppercase()) {
        return replacement.to_uppercase();
    }
    if letters.iter().all(|ch| ch.is_lowercase()) {
        return replacement.to_lowercase();
    }
    if letters[0].is_uppercase() && letters[1..].iter().all(|ch| ch.is_lowercase()) {
        let mut chars = replacement.chars();
        return chars.next().map_or_else(String::new, |first| {
            first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
        });
    }
    replacement.to_owned()
}

struct FilePaths {
    stack: Vec<PathBuf>,
}

impl FilePaths {
    fn new(root: &Path) -> Self {
        Self {
            stack: vec![root.to_path_buf()],
        }
    }

    fn scoped(root: &Path, path: &str) -> Result<Self> {
        let absolute = fs_util::resolve_workspace_path(root, path)?;
        let relative = absolute.strip_prefix(root)?;
        let mut probe = root.to_path_buf();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            probe.push(name);
            let metadata = std::fs::symlink_metadata(&probe)
                .with_context(|| format!("File non disponibile: {path}"))?;
            if metadata.file_type().is_symlink() {
                bail!("Sostituzione non consentita sui collegamenti simbolici: {path}");
            }
            if metadata.is_dir() && is_skipped_dir(&name.to_string_lossy()) {
                return Ok(Self { stack: Vec::new() });
            }
        }
        if !probe.is_file() {
            bail!("Seleziona un file da modificare: {path}");
        }
        Ok(Self { stack: vec![probe] })
    }
}

impl Iterator for FilePaths {
    type Item = PathBuf;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(path) = self.stack.pop() {
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_file() {
                return Some(path);
            }
            if !metadata.is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(path) else {
                continue;
            };
            let mut children = Vec::new();
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_symlink()
                    || (kind.is_dir() && is_skipped_dir(&entry.file_name().to_string_lossy()))
                {
                    continue;
                }
                if kind.is_file() || kind.is_dir() {
                    children.push(entry.path());
                }
            }
            children.sort();
            self.stack.extend(children.into_iter().rev());
        }
        None
    }
}

fn preview_before(text: &str) -> String {
    let mut chars: Vec<_> = text.chars().rev().take(PREVIEW_BEFORE + 1).collect();
    let truncated = chars.len() > PREVIEW_BEFORE;
    chars.truncate(PREVIEW_BEFORE);
    chars.reverse();
    let mut preview = if truncated {
        "…".to_owned()
    } else {
        String::new()
    };
    preview.extend(chars);
    preview
}

fn preview_after(text: &str) -> String {
    let mut chars = text.chars();
    let mut preview: String = chars.by_ref().take(PREVIEW_AFTER).collect();
    if chars.next().is_some() {
        preview.push('…');
    }
    preview
}

fn apply_hits(text: &str, hits: &[Hit]) -> String {
    let mut content = String::with_capacity(text.len());
    let mut previous_end = 0;
    for hit in hits {
        content.push_str(&text[previous_end..hit.start]);
        content.push_str(&hit.replacement);
        previous_end = hit.end;
    }
    content.push_str(&text[previous_end..]);
    content
}

fn read_text(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn search_with_options(
    root: &Path,
    query: &str,
    options: &SearchOptions,
    documents: &[SearchDocument],
    replacement: Option<&str>,
    limit: usize,
) -> Result<Vec<SearchMatch>> {
    let matcher = Matcher::new(query, options)?;
    let root = dunce::canonicalize(root)?;
    let documents: HashMap<_, _> = documents
        .iter()
        .map(|doc| (doc.path.as_str(), doc))
        .collect();
    let mut results = Vec::new();
    let limit = limit.max(1);
    for absolute in FilePaths::new(&root) {
        let path = absolute
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        let Some(disk) = read_text(&absolute) else {
            continue;
        };
        let text = documents
            .get(path.as_str())
            .map_or(disk.as_str(), |doc| doc.text.as_str());
        for hit in matcher.hits(
            text,
            replacement.unwrap_or_default(),
            limit.saturating_sub(results.len()),
        ) {
            let prefix = preview_before(&text[hit.line_start..hit.start]);
            let suffix = preview_after(&text[hit.end..hit.line_end]);
            results.push(SearchMatch {
                path: path.clone(),
                line: hit.line,
                column: hit.column,
                prefix,
                matched: text[hit.start..hit.end].to_owned(),
                suffix,
                replacement: replacement.map(|_| hit.replacement),
            });
        }
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

pub fn replace(
    root: &Path,
    request: &ReplaceRequest,
    documents: &[SearchDocument],
) -> Result<ReplaceResult> {
    let matcher = Matcher::new(&request.query, &request.options)?;
    let root = dunce::canonicalize(root)?;
    if request.r#match.is_some() && request.path.is_none() {
        bail!("Seleziona il file da modificare");
    }
    let paths = match &request.path {
        Some(path) => FilePaths::scoped(&root, path)?,
        None => FilePaths::new(&root),
    };
    let documents: HashMap<_, _> = documents
        .iter()
        .map(|doc| (doc.path.as_str(), doc))
        .collect();
    let mut plan = Vec::new();
    let mut count = 0;
    for absolute in paths {
        let path = absolute
            .strip_prefix(&root)?
            .to_string_lossy()
            .replace('\\', "/");
        let Some(disk) = read_text(&absolute) else {
            continue;
        };
        let document = documents.get(path.as_str()).copied();
        let text = document.map_or(disk.as_str(), |doc| doc.text.as_str());
        let mut hits = matcher.hits(text, &request.replacement, usize::MAX);
        if let Some(location) = &request.r#match {
            hits.retain(|hit| {
                hit.line == location.line
                    && hit.column == location.column
                    && text[hit.start..hit.end] == location.matched
            });
            if hits.is_empty() {
                bail!("Il risultato è cambiato: ripeti la ricerca");
            }
        }
        if hits.is_empty() {
            continue;
        }
        if document.is_some_and(|doc| doc.saved_text != disk) {
            bail!("Il file è cambiato sul disco: {path}. Ricaricalo prima di sostituire.");
        }
        count += hits.len();
        let content = apply_hits(text, &hits);
        // Dirty editor buffers remain dirty. Closed/clean files are saved to disk.
        let dirty = document.is_some_and(|doc| doc.text != doc.saved_text);
        plan.push((
            absolute,
            disk,
            ReplacedDocument {
                path,
                saved_content: if dirty {
                    document.unwrap().saved_text.clone()
                } else {
                    content.clone()
                },
                content,
            },
            dirty,
        ));
    }
    if request.r#match.is_some() && plan.is_empty() {
        bail!("Il risultato non è più disponibile: ripeti la ricerca");
    }
    // Preflight every file before the first write, then check again immediately before writing.
    for (absolute, disk, _, _) in &plan {
        if std::fs::read_to_string(absolute)? != *disk {
            bail!(
                "Un file è cambiato durante la sostituzione: {}",
                absolute.display()
            );
        }
    }
    let mut written: Vec<usize> = Vec::new();
    for (index, (absolute, disk, document, dirty)) in plan.iter().enumerate() {
        if *dirty {
            continue;
        }
        let write = (|| -> Result<()> {
            if std::fs::read_to_string(absolute)? != *disk {
                bail!("Il file è cambiato: {}", document.path);
            }
            fs_util::atomic_write(absolute, document.content.as_bytes())
        })();
        if let Err(error) = write {
            let mut failures = Vec::new();
            for previous in written.into_iter().rev() {
                let (path, original, changed, _) = &plan[previous];
                if std::fs::read_to_string(path).ok().as_deref() == Some(changed.content.as_str()) {
                    if let Err(failure) = fs_util::atomic_write(path, original.as_bytes()) {
                        failures.push(failure.to_string());
                    }
                } else {
                    failures.push(format!("Modifica concorrente in {}", path.display()));
                }
            }
            bail!(
                "Sostituzione annullata: {error:#}{}",
                if failures.is_empty() {
                    String::new()
                } else {
                    format!(". Ripristino incompleto: {}", failures.join("; "))
                }
            );
        }
        written.push(index);
    }
    Ok(ReplaceResult {
        count,
        documents: plan
            .into_iter()
            .map(|(_, _, document, _)| document)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new(files: &[(&str, &str)]) -> Self {
            let root =
                std::env::temp_dir().join(format!("helmcode-replace-{}", uuid::Uuid::new_v4()));
            for (path, content) in files {
                let absolute = root.join(path);
                fs::create_dir_all(absolute.parent().unwrap()).unwrap();
                fs::write(absolute, content).unwrap();
            }
            Self(root)
        }
        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.0.join(path)).unwrap()
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn request(query: &str, replacement: &str) -> ReplaceRequest {
        ReplaceRequest {
            query: query.into(),
            replacement: replacement.into(),
            options: SearchOptions::default(),
            path: None,
            r#match: None,
        }
    }

    #[test]
    fn replaces_every_occurrence_beyond_preview_limits_and_skips_generated_and_binary_files() {
        let workspace = Workspace::new(&[
            ("src/a.txt", &"foo foo\r\n".repeat(150)),
            ("src/b.txt", "FOO"),
            ("node_modules/a", "foo"),
            ("binary", "foo\0foo"),
        ]);
        let req = request("foo", "bar");
        let preview = search_with_options(
            &workspace.0,
            &req.query,
            &req.options,
            &[],
            Some(&req.replacement),
            200,
        )
        .unwrap();
        assert_eq!(preview.len(), 200);
        assert_eq!(preview[0].column, 1);
        assert_eq!(preview[1].column, 5);
        assert_eq!(preview[199].replacement.as_deref(), Some("bar"));
        let result = replace(&workspace.0, &req, &[]).unwrap();
        assert_eq!(result.count, 301);
        assert_eq!(result.documents.len(), 2);
        assert_eq!(workspace.read("src/a.txt"), "bar bar\r\n".repeat(150));
        assert_eq!(workspace.read("node_modules/a"), "foo");
        assert_eq!(workspace.read("binary"), "foo\0foo");
    }

    #[test]
    fn replaces_a_single_match_then_an_entire_file_without_touching_other_files() {
        let workspace = Workspace::new(&[("a", "foo foo\nfoo"), ("b", "foo")]);
        let mut req = request("foo", "");
        req.path = Some("a".into());
        req.r#match = Some(MatchLocation {
            line: 1,
            column: 5,
            matched: "foo".into(),
        });
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 1);
        assert_eq!(workspace.read("a"), "foo \nfoo");
        assert!(replace(&workspace.0, &req, &[]).is_err());
        req.r#match = None;
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 2);
        assert_eq!(workspace.read("b"), "foo");
    }

    #[test]
    fn supports_whole_words_case_sensitive_search_and_unicode() {
        let workspace = Workspace::new(&[("a", "😀CAFÉ café cafeteria café_suffix\r\n")]);
        let mut req = request("café", "$1");
        req.options.whole_word = true;
        req.options.case_sensitive = true;
        let preview =
            search_with_options(&workspace.0, &req.query, &req.options, &[], None, 200).unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].column, 8);
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 1);
        assert_eq!(workspace.read("a"), "😀CAFÉ $1 cafeteria café_suffix\r\n");
    }

    #[test]
    fn regex_capture_preview_equals_replacement_and_invalid_patterns_do_not_write() {
        let workspace = Workspace::new(&[("a", "foo12 foo34")]);
        let mut req = request(r"foo(\d+)", "bar${1}$$");
        req.options.use_regex = true;
        let preview = search_with_options(
            &workspace.0,
            &req.query,
            &req.options,
            &[],
            Some(&req.replacement),
            200,
        )
        .unwrap();
        assert_eq!(preview[0].replacement.as_deref(), Some("bar12$"));
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 2);
        assert_eq!(workspace.read("a"), "bar12$ bar34$");
        req.query = "[".into();
        assert!(replace(&workspace.0, &req, &[]).is_err());
        assert_eq!(workspace.read("a"), "bar12$ bar34$");
    }

    #[test]
    fn preserves_upper_lower_and_title_case() {
        let workspace = Workspace::new(&[("a", "FOO Foo foo fOo")]);
        let mut req = request("foo", "word");
        req.options.preserve_case = true;
        replace(&workspace.0, &req, &[]).unwrap();
        assert_eq!(workspace.read("a"), "WORD Word word word");
    }

    #[test]
    fn searches_and_replaces_dirty_buffers_without_writing_over_unsaved_edits() {
        let workspace = Workspace::new(&[("a", "saved"), ("b", "foo")]);
        let docs = vec![SearchDocument {
            path: "a".into(),
            text: "unsaved foo foo".into(),
            saved_text: "saved".into(),
        }];
        let req = request("foo", "bar");
        assert_eq!(
            search_with_options(&workspace.0, "foo", &req.options, &docs, None, 200)
                .unwrap()
                .len(),
            3
        );
        let result = replace(&workspace.0, &req, &docs).unwrap();
        assert_eq!(result.count, 3);
        assert_eq!(result.documents[0].content, "unsaved bar bar");
        assert_eq!(result.documents[0].saved_content, "saved");
        assert_eq!(workspace.read("a"), "saved");
        assert_eq!(workspace.read("b"), "bar");
    }

    #[test]
    fn stale_open_documents_abort_before_any_file_is_written() {
        let workspace = Workspace::new(&[("a", "foo"), ("z", "foo external")]);
        let docs = vec![SearchDocument {
            path: "z".into(),
            text: "foo edit".into(),
            saved_text: "foo".into(),
        }];
        assert!(replace(&workspace.0, &request("foo", "bar"), &docs).is_err());
        assert_eq!(workspace.read("a"), "foo");
        assert_eq!(workspace.read("z"), "foo external");
    }

    #[test]
    fn literal_spaces_and_zero_width_regex_are_supported() {
        let workspace = Workspace::new(&[("a", " a \r\nb")]);
        assert_eq!(
            replace(&workspace.0, &request(" ", "_"), &[])
                .unwrap()
                .count,
            2
        );
        let mut req = request("^", ">");
        req.options.use_regex = true;
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 2);
        assert_eq!(workspace.read("a"), ">_a_\r\n>b");
    }

    #[test]
    fn rejects_empty_queries_and_paths_outside_the_workspace() {
        let workspace = Workspace::new(&[("a", "foo")]);
        assert!(replace(&workspace.0, &request("", "bar"), &[]).is_err());
        let mut req = request("foo", "bar");
        req.path = Some("../outside".into());
        assert!(replace(&workspace.0, &req, &[]).is_err());
        assert_eq!(workspace.read("a"), "foo");
    }

    #[test]
    fn scoped_replacements_keep_directory_exclusions_and_accept_normalized_paths() {
        let workspace = Workspace::new(&[
            ("src/a", "foo"),
            ("other/a", "foo"),
            ("node_modules/a", "foo"),
        ]);
        let mut req = request("foo", "bar");
        req.path = Some("./src/a".into());
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 1);
        assert_eq!(workspace.read("src/a"), "bar");
        assert_eq!(workspace.read("other/a"), "foo");
        req.path = Some("node_modules/a".into());
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 0);
        assert_eq!(workspace.read("node_modules/a"), "foo");
    }

    #[test]
    fn dense_unicode_matches_keep_utf16_positions_and_apply_length_changing_replacements() {
        let text = format!("😀{}", "é".repeat(20_000));
        let workspace = Workspace::new(&[("a", &text)]);
        let req = request("É", "xy");
        let hits = Matcher::new(&req.query, &req.options).unwrap().hits(
            &text,
            &req.replacement,
            usize::MAX,
        );
        assert_eq!(hits.len(), 20_000);
        assert_eq!(hits[0].column, 3);
        assert_eq!(hits.last().unwrap().column, 20_002);
        assert_eq!(replace(&workspace.0, &req, &[]).unwrap().count, 20_000);
        assert_eq!(workspace.read("a"), format!("😀{}", "xy".repeat(20_000)));
    }

    #[test]
    fn long_unicode_lines_have_bounded_previews() {
        let workspace = Workspace::new(&[(
            "a",
            &format!("{}needle{}", "é".repeat(10_000), "😀".repeat(10_000)),
        )]);
        let matches = search_with_options(
            &workspace.0,
            "needle",
            &SearchOptions::default(),
            &[],
            None,
            200,
        )
        .unwrap();
        assert_eq!(
            matches[0].prefix,
            format!("…{}", "é".repeat(PREVIEW_BEFORE))
        );
        assert_eq!(
            matches[0].suffix,
            format!("{}…", "😀".repeat(PREVIEW_AFTER))
        );
        assert_eq!(matches[0].column, 10_001);
    }

    #[test]
    fn literal_searches_do_not_skip_adjacent_non_overlapping_matches() {
        for (text, query, replacement, expected) in [
            ("aaaaa", "aa", "x", "xxa"),
            ("ééééé", "ÉÉ", "x", "xxé"),
            ("AAAAA", "AA", "long", "longlongA"),
        ] {
            for sensitive in [false, true] {
                let mut options = SearchOptions::default();
                options.case_sensitive = sensitive;
                let matcher = Matcher::new(query, &options).unwrap();
                let hits = matcher.hits(text, replacement, usize::MAX);
                let expected = if sensitive && !text.contains(query) {
                    text
                } else {
                    expected
                };
                assert_eq!(apply_hits(text, &hits), expected);
            }
        }
    }
}
