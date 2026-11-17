use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::fs_util::is_skipped_dir;

mod replace;
pub use replace::{replace, search_with_options, ReplaceRequest, ReplaceResult, SearchDocument, SearchOptions};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const PREVIEW_BEFORE: usize = 60;
const PREVIEW_AFTER: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub prefix: String,
    pub matched: String,
    pub suffix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
}

pub fn search_files(root: &Path, query: &str, limit: usize) -> Result<Vec<FileMatch>> {
    let query = query.trim();
    if query.is_empty() {
        bail!("la query di ricerca è vuota");
    }
    let root = dunce::canonicalize(root)
        .with_context(|| format!("workspace non valido: {}", root.display()))?;
    let limit = limit.max(1);
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    let mut stack = vec![root.clone()];

    while let Some(directory) = stack.pop() {
        if results.len() >= limit {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
        entries.sort_by_cached_key(|entry| entry.file_name());
        let mut subdirectories = Vec::new();

        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if !is_skipped_dir(&name) {
                    subdirectories.push(entry.path());
                }
            } else if file_type.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative.to_lowercase().contains(&needle) {
                    results.push(FileMatch { path: relative });
                }
            }
        }

        for directory in subdirectories.into_iter().rev() {
            stack.push(directory);
        }
    }

    // ponytail: simple substring ranking; switch to fuzzy scoring if large repos feel noisy.
    results.sort_by_cached_key(|item| {
        let name = item.path.rsplit('/').next().unwrap_or(&item.path).to_lowercase();
        (!name.contains(&needle), item.path.len(), item.path.clone())
    });
    results.truncate(limit);
    Ok(results)
}

#[cfg(test)]
pub fn search(root: &Path, query: &str, case_sensitive: bool, limit: usize) -> Result<Vec<SearchMatch>> {
    search_with_options(root, query, &SearchOptions { case_sensitive, ..Default::default() }, &[], None, limit)
}

struct SearchQuery<'a> {
    text: &'a str,
    char_count: usize,
    folded: Vec<Vec<char>>,
    case_sensitive: bool,
}

impl<'a> SearchQuery<'a> {
    fn new(text: &'a str, case_sensitive: bool) -> Self {
        Self {
            text,
            char_count: text.chars().count(),
            folded: if case_sensitive { Vec::new() } else {
                text.chars().map(|ch| ch.to_lowercase().collect()).collect()
            },
            case_sensitive,
        }
    }

    // This single-match entry point is also extracted by the standalone benchmark.
    #[cfg_attr(not(test), allow(dead_code))]
    fn find_match(&self, line: &str) -> Option<(usize, usize)> {
        if self.text.is_empty() { return None; }
        if self.case_sensitive {
            let byte = line.find(self.text)?;
            return Some((line[..byte].chars().count(), self.char_count));
        }
        // Source files are usually ASCII. Avoid allocating and folding every line.
        // Non-ASCII text still uses per-character Unicode folding so expansions
        // such as I-with-dot keep their original character boundaries.
        if self.text.is_ascii() && line.is_ascii() {
            return line.as_bytes().windows(self.text.len())
                .position(|candidate| candidate.eq_ignore_ascii_case(self.text.as_bytes()))
                .map(|start| (start, self.char_count));
        }
        let haystack: Vec<char> = line.chars().collect();
        haystack.windows(self.char_count)
            .position(|candidate| candidate.iter().zip(&self.folded)
                .all(|(actual, expected)| actual.to_lowercase().eq(expected.iter().copied())))
            .map(|start| (start, self.char_count))
    }
}

#[cfg(test)]
mod tests {
    use super::{search, search_files, SearchQuery};
    use std::fs;
    use uuid::Uuid;

    fn workspace() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("helmcode-search-{}", Uuid::new_v4()));
        fs::create_dir_all(directory.join("src")).unwrap();
        fs::create_dir_all(directory.join("node_modules")).unwrap();
        fs::write(directory.join("src/a.txt"), "Hello World\nhello again\n").unwrap();
        fs::write(directory.join("src/App.tsx"), "export const App = 1;\n").unwrap();
        fs::write(directory.join("src/app.test.ts"), "test('app', () => {});\n").unwrap();
        fs::write(directory.join("node_modules/hidden.txt"), "hello hidden\n").unwrap();
        fs::write(directory.join("node_modules/app.txt"), "app hidden\n").unwrap();
        directory
    }

    #[test]
    fn finds_matches_and_skips_dependencies() {
        let workspace = workspace();
        let matches = search(&workspace, "hello", false, 200).unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].path, "src/a.txt");
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[1].line, 2);
        assert!(matches
            .iter()
            .all(|item| !item.path.contains("node_modules")));
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn respects_case_sensitivity() {
        let workspace = workspace();
        let matches = search(&workspace, "Hello", true, 200).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 1);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn respects_the_result_limit() {
        let workspace = workspace();
        let matches = search(&workspace, "hello", false, 1).unwrap();
        assert_eq!(matches.len(), 1);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn finds_files_by_name_and_skips_dependencies() {
        let workspace = workspace();
        let files = search_files(&workspace, "APP", 200).unwrap();
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["src/App.tsx", "src/app.test.ts"]);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn matches_files_by_relative_path() {
        let workspace = workspace();
        let files = search_files(&workspace, "src/a", 200).unwrap();
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a.txt", "src/App.tsx", "src/app.test.ts"]);
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn limits_file_results_and_rejects_empty_queries() {
        let workspace = workspace();
        assert_eq!(search_files(&workspace, ".txt", 1).unwrap().len(), 1);
        assert!(search_files(&workspace, "  ", 10).is_err());
        fs::remove_dir_all(workspace).ok();
    }

    #[test]
    fn matching_preserves_unicode_character_boundaries_and_columns() {
        for (line, query, sensitive, expected) in [
            ("plain text", "TEXT", false, Some((6, 4))),
            ("plain text", "TEXT", true, None),
            ("a", "longer", false, None),
            ("", "a", false, None),
            ("a", "", false, None),
            ("\u{1f600}caf\u{e9}", "caf\u{e9}", true, Some((1, 4))),
            ("\u{1f600}CAF\u{c9}", "caf\u{e9}", false, Some((1, 4))),
            ("pre \u{212a}elvin", "kelvin", false, Some((4, 6))),
            ("\u{130}X", "\u{130}x", false, Some((0, 2))),
            ("\u{130}X", "i\u{307}x", false, None),
            ("Stra\u{df}e", "strasse", false, None),
        ] {
            assert_eq!(SearchQuery::new(query, sensitive).find_match(line), expected,
                "line={line:?}, query={query:?}, sensitive={sensitive}");
        }
    }

    #[test]
    fn unicode_matches_keep_original_text_and_preview() {
        let workspace = workspace();
        fs::write(workspace.join("src/unicode.txt"), "\u{1f600}CAF\u{c9} after\n").unwrap();
        let matches = search(&workspace, "caf\u{e9}", false, 200).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].column, 3);
        assert_eq!(matches[0].prefix, "\u{1f600}");
        assert_eq!(matches[0].matched, "CAF\u{c9}");
        assert_eq!(matches[0].suffix, " after");
        fs::remove_dir_all(workspace).ok();
    }
}
