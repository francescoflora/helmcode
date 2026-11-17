use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct Language {
    pub key: String,
    pub language_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub initialization_options: Value,
    pub settings: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    servers: Vec<ServerConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerConfig {
    language_id: String,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    filenames: Vec<String>,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    initialization_options: Value,
    #[serde(default = "empty_object")]
    settings: Value,
}

fn empty_object() -> Value {
    json!({})
}

/// A workspace override may add any stdio LSP server or replace a default.
/// The first matching custom entry wins; no tools are installed implicitly.
pub(crate) fn language_for(workspace: &Path, path: &Path) -> Result<Option<Language>> {
    let config_path = workspace.join(".helmcode/languages.json");
    match std::fs::read_to_string(&config_path) {
        Ok(text) => {
            let config: Config = serde_json::from_str(&text).with_context(|| {
                format!("Configurazione LSP non valida: {}", config_path.display())
            })?;
            if let Some(language) = configured_language(workspace, path, config)? {
                return Ok(Some(language));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Impossibile leggere .helmcode/languages.json"),
    }
    Ok(default_language(workspace, path))
}

fn configured_language(workspace: &Path, path: &Path, config: Config) -> Result<Option<Language>> {
    let filename = path.file_name().unwrap_or_default().to_string_lossy();
    let extension = path.extension().unwrap_or_default().to_string_lossy();
    let mut matched = None;
    for (index, server) in config.servers.into_iter().enumerate() {
        if server.language_id.trim().is_empty() || server.command.trim().is_empty() {
            bail!(
                "Ogni server in .helmcode/languages.json richiede languageId e command non vuoti"
            );
        }
        if server.extensions.is_empty() && server.filenames.is_empty() {
            bail!(
                "Il server {} deve specificare extensions o filenames",
                server.language_id
            );
        }
        if server
            .extensions
            .iter()
            .any(|value| value.trim_start_matches('.').is_empty())
            || server.filenames.iter().any(|value| value.is_empty())
        {
            bail!("Extensions e filenames non possono contenere valori vuoti");
        }
        let matches = server.extensions.iter().any(|value| {
            value
                .trim_start_matches('.')
                .eq_ignore_ascii_case(&extension)
        }) || server
            .filenames
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&filename));
        if matched.is_none() && matches {
            let expand =
                |value: String| value.replace("${workspaceFolder}", &workspace.to_string_lossy());
            matched = Some(Language {
                key: format!("custom:{index}:{}", server.language_id),
                language_id: server.language_id,
                command: expand(server.command),
                args: server.args.into_iter().map(expand).collect(),
                initialization_options: server.initialization_options,
                settings: server.settings,
            });
        }
    }
    Ok(matched)
}

fn default_language(workspace: &Path, path: &Path) -> Option<Language> {
    let filename = path.file_name()?.to_string_lossy().to_lowercase();
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let (key, language_id, command, args): (&str, &str, &str, &[&str]) = match extension.as_str() {
        "ts" | "mts" | "cts" => (
            "typescript",
            "typescript",
            "typescript-language-server",
            &["--stdio"],
        ),
        "tsx" => (
            "typescript",
            "typescriptreact",
            "typescript-language-server",
            &["--stdio"],
        ),
        "js" | "mjs" | "cjs" => (
            "typescript",
            "javascript",
            "typescript-language-server",
            &["--stdio"],
        ),
        "jsx" => (
            "typescript",
            "javascriptreact",
            "typescript-language-server",
            &["--stdio"],
        ),
        "rs" => ("rust", "rust", "rust-analyzer", &[]),
        "java" => ("java", "java", "jdtls", &[]),
        "py" | "pyi" | "pyw" => ("python", "python", "pyright-langserver", &["--stdio"]),
        "go" => ("go", "go", "gopls", &["serve"]),
        "c" | "h" => ("clangd", "c", "clangd", &[]),
        "cc" | "cpp" | "cxx" | "c++" | "hh" | "hpp" | "hxx" | "h++" => {
            ("clangd", "cpp", "clangd", &[])
        }
        "m" => ("clangd", "objective-c", "clangd", &[]),
        "mm" => ("clangd", "objective-cpp", "clangd", &[]),
        "cs" | "csx" => ("csharp", "csharp", "csharp-ls", &[]),
        "php" | "phtml" => ("php", "php", "intelephense", &["--stdio"]),
        "rb" | "rake" | "gemspec" => ("ruby", "ruby", "ruby-lsp", &[]),
        "html" | "htm" | "xhtml" => ("html", "html", "vscode-html-language-server", &["--stdio"]),
        "css" => ("css", "css", "vscode-css-language-server", &["--stdio"]),
        "scss" => ("css", "scss", "vscode-css-language-server", &["--stdio"]),
        "less" => ("css", "less", "vscode-css-language-server", &["--stdio"]),
        "json" if filename.starts_with("tsconfig") || filename.starts_with("jsconfig") => {
            ("json", "jsonc", "vscode-json-language-server", &["--stdio"])
        }
        "json" => ("json", "json", "vscode-json-language-server", &["--stdio"]),
        "jsonc" | "code-workspace" => {
            ("json", "jsonc", "vscode-json-language-server", &["--stdio"])
        }
        "yaml" | "yml" => ("yaml", "yaml", "yaml-language-server", &["--stdio"]),
        "vue" => ("vue", "vue", "vue-language-server", &["--stdio"]),
        "svelte" => ("svelte", "svelte", "svelteserver", &["--stdio"]),
        "lua" => ("lua", "lua", "lua-language-server", &[]),
        "dart" => (
            "dart",
            "dart",
            "dart",
            &["language-server", "--protocol=lsp"],
        ),
        "kt" | "kts" => ("kotlin", "kotlin", "kotlin-language-server", &[]),
        "sh" | "bash" | "zsh" => ("shell", "shellscript", "bash-language-server", &["start"]),
        "toml" => ("toml", "toml", "taplo", &["lsp", "stdio"]),
        "xml" | "xsd" | "xsl" | "xslt" | "svg" => ("xml", "xml", "lemminx", &[]),
        "zig" | "zon" => ("zig", "zig", "zls", &[]),
        "ex" | "exs" => ("elixir", "elixir", "elixir-ls", &[]),
        "erl" | "hrl" => ("erlang", "erlang", "erlang_ls", &[]),
        "hs" | "lhs" => (
            "haskell",
            "haskell",
            "haskell-language-server-wrapper",
            &["--lsp"],
        ),
        "ml" | "mli" => ("ocaml", "ocaml", "ocamllsp", &[]),
        "pl" | "pm" => ("perl", "perl", "perlnavigator", &["--stdio"]),
        "r" | "rmd" => ("r", "r", "R", &["--slave", "-e", "languageserver::run()"]),
        _ => match filename.as_str() {
            "gemfile" | "rakefile" => ("ruby", "ruby", "ruby-lsp", &[]),
            ".bashrc" | ".bash_profile" | ".bash_login" | ".zshrc" | ".zprofile" | ".profile" => {
                ("shell", "shellscript", "bash-language-server", &["start"])
            }
            _ => return None,
        },
    };

    let mut language = Language {
        key: key.to_owned(),
        language_id: language_id.to_owned(),
        command: command.to_owned(),
        args: args.iter().map(|value| (*value).to_owned()).collect(),
        initialization_options: Value::Null,
        settings: empty_object(),
    };
    if key == "typescript" {
        let local_cli = workspace.join("node_modules/typescript-language-server/lib/cli.mjs");
        if local_cli.is_file() {
            language.command = "node".to_owned();
            language
                .args
                .insert(0, local_cli.to_string_lossy().into_owned());
        }
    }
    if key == "java" {
        // JDT LS requires a different data directory for each project. Keep its
        // generated indexes outside the user's repository.
        let mut hasher = DefaultHasher::new();
        workspace.hash(&mut hasher);
        let data = std::env::temp_dir()
            .join("helmcode-jdtls")
            .join(format!("{:016x}", hasher.finish()));
        language.args = vec!["-data".to_owned(), data.to_string_lossy().into_owned()];
    }
    Some(language)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_languages_and_correct_start_arguments() {
        for (file, id, command) in [
            ("main.java", "java", "jdtls"),
            ("main.py", "python", "pyright-langserver"),
            ("main.rs", "rust", "rust-analyzer"),
            ("main.go", "go", "gopls"),
            ("main.cpp", "cpp", "clangd"),
            ("main.cs", "csharp", "csharp-ls"),
            ("main.tsx", "typescriptreact", "typescript-language-server"),
            ("main.CTS", "typescript", "typescript-language-server"),
            ("index.html", "html", "vscode-html-language-server"),
            ("style.scss", "scss", "vscode-css-language-server"),
            ("tsconfig.app.json", "jsonc", "vscode-json-language-server"),
            ("Gemfile", "ruby", "ruby-lsp"),
            (".zshrc", "shellscript", "bash-language-server"),
            ("config.toml", "toml", "taplo"),
        ] {
            let language = default_language(Path::new("/workspace"), Path::new(file)).unwrap();
            assert_eq!(language.language_id, id, "{file}");
            assert_eq!(language.command, command, "{file}");
        }
        assert!(
            default_language(Path::new("/workspace"), Path::new("main.rs"))
                .unwrap()
                .args
                .is_empty()
        );
        assert!(default_language(Path::new("/workspace"), Path::new("file.unknown")).is_none());
        let java_a = default_language(Path::new("/workspace-a"), Path::new("Main.java")).unwrap();
        let java_b = default_language(Path::new("/workspace-b"), Path::new("Main.java")).unwrap();
        assert_eq!(java_a.args[0], "-data");
        assert_ne!(java_a.args, java_b.args);
    }

    #[test]
    fn custom_server_overrides_and_expands_workspace_without_shell_interpolation() {
        let config: Config = serde_json::from_value(json!({"servers": [
            {"languageId":"java","extensions":[".JAVA"],"command":"${workspaceFolder}/tools/jdtls","args":["-data","${workspaceFolder}/.cache"],"initializationOptions":{"extended":true},"settings":{"java":{"x":true}}},
            {"languageId":"custom","filenames":["Specialfile"],"command":"custom-server"}
        ]})).unwrap();
        let language = configured_language(
            Path::new("/project with spaces"),
            Path::new("Main.java"),
            config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(language.command, "/project with spaces/tools/jdtls");
        assert_eq!(language.args[1], "/project with spaces/.cache");
        assert_eq!(language.initialization_options["extended"], true);
        assert_eq!(language.settings["java"]["x"], true);
        let config: Config = serde_json::from_value(json!({"servers": [
            {"languageId":"custom","filenames":["Specialfile"],"command":"custom-server"}
        ]}))
        .unwrap();
        assert_eq!(
            configured_language(Path::new("/project"), Path::new("Specialfile"), config)
                .unwrap()
                .unwrap()
                .language_id,
            "custom"
        );
    }

    #[test]
    fn invalid_custom_configuration_is_reported() {
        assert!(serde_json::from_str::<Config>("{ broken").is_err());
        assert!(serde_json::from_value::<Config>(
            json!({"servers":[{"languageId":"java","command":"jdtls","extension":["java"]}]})
        )
        .is_err());
        for server in [
            json!({"languageId":"java","extensions":["java"],"command":""}),
            json!({"languageId":"java","command":"jdtls"}),
            json!({"languageId":"java","extensions":[""],"command":"jdtls"}),
        ] {
            let config = serde_json::from_value(json!({"servers":[server]})).unwrap();
            assert!(
                configured_language(Path::new("/project"), Path::new("Main.java"), config).is_err()
            );
        }
    }

    #[test]
    fn workspace_file_is_optional_and_invalid_json_is_not_ignored() {
        let workspace =
            std::env::temp_dir().join(format!("helmcode-language-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(workspace.join(".helmcode")).unwrap();
        assert_eq!(
            language_for(&workspace, Path::new("main.py"))
                .unwrap()
                .unwrap()
                .language_id,
            "python"
        );
        std::fs::write(workspace.join(".helmcode/languages.json"), "{invalid").unwrap();
        assert!(language_for(&workspace, Path::new("main.py")).is_err());
        std::fs::write(
            workspace.join(".helmcode/languages.json"),
            r#"{"servers":[{"languageId":"other","extensions":["py"],"command":"other-server"}]}"#,
        )
        .unwrap();
        assert_eq!(
            language_for(&workspace, Path::new("main.py"))
                .unwrap()
                .unwrap()
                .command,
            "other-server"
        );
        std::fs::remove_dir_all(workspace).unwrap();
    }
}
