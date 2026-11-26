use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

const JDTLS_MILESTONES_URL: &str = "https://download.eclipse.org/jdtls/milestones/";
/// Last Eclipse JDT LS milestone whose OSGi bundles run on JDK 21..24.
/// Milestones 1.62.0+ require Java 25 (`osgi.ee=JavaSE; version=25`).
const JDTLS_JDK21_MILESTONE: &str = "1.61.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallableServer {
    pub id: String,
    pub label: String,
    pub requirement: String,
}

static ACTIVE_INSTALLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_installs() -> &'static Mutex<HashSet<String>> {
    ACTIVE_INSTALLS.get_or_init(|| Mutex::new(HashSet::new()))
}

struct InstallGuard {
    id: String,
}

impl InstallGuard {
    fn acquire(id: &str) -> Result<Self> {
        let mut set = active_installs()
            .lock()
            .map_err(|_| anyhow!("gestore installazioni bloccato"))?;
        if !set.insert(id.to_owned()) {
            bail!("Installazione già in corso per questo language server");
        }
        Ok(Self { id: id.to_owned() })
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = active_installs().lock() {
            set.remove(&self.id);
        }
    }
}

/// Returns the user-local directory where helmcode stores managed language servers.
/// Keeping servers here avoids modifying PATH, requires no admin rights, and
/// survives NSIS/MSIX/standalone updates.
pub fn managed_root() -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("helmcode").join("lsp");
    }
    #[cfg(not(windows))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join("helmcode").join("lsp");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("helmcode")
                .join("lsp");
        }
    }
    std::env::temp_dir().join("helmcode-lsp")
}

pub fn managed_bin_dirs() -> Vec<PathBuf> {
    let root = managed_root();
    vec![
        root.join("bin"),
        root.join("npm").join("node_modules").join(".bin"),
    ]
}

pub fn installable_for_key(key: &str) -> Option<InstallableServer> {
    let (id, label, requirement) = match key {
        "java" => ("java", "Eclipse JDT LS (jdtls)", "Richiede JDK 21+"),
        "typescript" => (
            "typescript",
            "TypeScript Language Server",
            "Richiede Node.js / npm",
        ),
        "python" => ("python", "Pyright", "Richiede Node.js / npm"),
        "html" | "css" | "json" => (
            "web",
            "VS Code HTML / CSS / JSON Servers",
            "Richiede Node.js / npm",
        ),
        "yaml" => ("yaml", "YAML Language Server", "Richiede Node.js / npm"),
        "vue" => ("vue", "Vue Language Server", "Richiede Node.js / npm"),
        "svelte" => ("svelte", "Svelte Language Server", "Richiede Node.js / npm"),
        "php" => ("php", "Intelephense", "Richiede Node.js / npm"),
        "shell" => ("shell", "Bash Language Server", "Richiede Node.js / npm"),
        "rust" => ("rust", "rust-analyzer", "Richiede rustup"),
        "go" => ("go", "gopls", "Richiede Go"),
        "csharp" => ("csharp", "csharp-ls", "Richiede .NET SDK"),
        _ => return None,
    };
    Some(InstallableServer {
        id: id.to_owned(),
        label: label.to_owned(),
        requirement: requirement.to_owned(),
    })
}

fn emit_progress(app: &AppHandle, server_id: &str, message: &str) {
    let _ = app.emit(
        "lsp-install-progress",
        json!({ "serverId": server_id, "message": message }),
    );
}

pub async fn install_server(app: &AppHandle, server_id: &str) -> Result<String> {
    let _guard = InstallGuard::acquire(server_id)?;
    let root = managed_root();
    std::fs::create_dir_all(root.join("bin"))
        .context("impossibile creare la cartella dei language server")?;

    match server_id {
        "java" => install_jdtls(app, &root).await,
        "typescript" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "TypeScript Language Server",
                &["typescript-language-server", "typescript"],
            )
            .await
        }
        "python" => install_npm_packages(app, server_id, &root, "Pyright", &["pyright"]).await,
        "web" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "VS Code HTML/CSS/JSON Servers",
                &["vscode-langservers-extracted"],
            )
            .await
        }
        "yaml" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "YAML Language Server",
                &["yaml-language-server"],
            )
            .await
        }
        "vue" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "Vue Language Server",
                &["@vue/language-server"],
            )
            .await
        }
        "svelte" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "Svelte Language Server",
                &["svelte-language-server"],
            )
            .await
        }
        "php" => {
            install_npm_packages(app, server_id, &root, "Intelephense", &["intelephense"]).await
        }
        "shell" => {
            install_npm_packages(
                app,
                server_id,
                &root,
                "Bash Language Server",
                &["bash-language-server"],
            )
            .await
        }
        "rust" => install_rust_analyzer(app, server_id).await,
        "go" => install_gopls(app, server_id, &root).await,
        "csharp" => install_csharp_ls(app, server_id, &root).await,
        _ => bail!("Language server non supportato per l'installazione automatica: {server_id}"),
    }
}

async fn install_jdtls(app: &AppHandle, root: &Path) -> Result<String> {
    emit_progress(app, "java", "Verifica della versione di Java…");
    let java_major = tokio::task::spawn_blocking(detect_java_major_version)
        .await
        .map_err(|error| anyhow!("verifica Java interrotta: {error}"))??;
    if java_major < 21 {
        bail!(
            "Eclipse JDT LS richiede JDK 21 o successivo (trovato Java {java_major}). Installa un JDK 21+ e riprova."
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent(concat!("helmcode/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("impossibile inizializzare il client HTTP")?;

    let milestone = if java_major >= 25 {
        emit_progress(app, "java", "Ricerca ultima versione di Eclipse JDT LS…");
        let index = client
            .get(JDTLS_MILESTONES_URL)
            .send()
            .await
            .context("impossibile contattare download.eclipse.org")?
            .error_for_status()
            .context("risposta non valida da download.eclipse.org")?
            .text()
            .await
            .context("impossibile leggere l'indice di Eclipse JDT LS")?;
        highest_milestone_version(&index)
            .unwrap_or_else(|| JDTLS_JDK21_MILESTONE.to_owned())
    } else {
        JDTLS_JDK21_MILESTONE.to_owned()
    };

    let latest_url = format!("{JDTLS_MILESTONES_URL}{milestone}/latest.txt");
    let tarball = client
        .get(&latest_url)
        .send()
        .await
        .with_context(|| format!("impossibile leggere la release {milestone} di JDT LS"))?
        .error_for_status()
        .context("manifest della release JDT LS non disponibile")?
        .text()
        .await?
        .trim()
        .to_owned();
    if tarball.is_empty() || tarball.contains(['/', '\\']) || !tarball.ends_with(".tar.gz") {
        bail!("Nome archivio JDT LS non valido: {tarball}");
    }

    let archive_url = format!("{JDTLS_MILESTONES_URL}{milestone}/{tarball}");
    emit_progress(
        app,
        "java",
        &format!("Download Eclipse JDT LS {milestone}…"),
    );
    let bytes = client
        .get(&archive_url)
        .send()
        .await
        .context("download di Eclipse JDT LS non riuscito")?
        .error_for_status()
        .context("archivio Eclipse JDT LS non disponibile")?
        .bytes()
        .await
        .context("lettura dell'archivio Eclipse JDT LS interrotta")?;

    let root = root.to_path_buf();
    let app_clone = app.clone();
    let milestone_clone = milestone.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        emit_progress(
            &app_clone,
            "java",
            &format!("Estrazione Eclipse JDT LS {milestone_clone}…"),
        );
        let stage = root.join(format!("jdtls-stage-{}", uuid::Uuid::new_v4()));
        let archive = root.join(format!("jdtls-{}.tar.gz", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&stage)?;
        std::fs::write(&archive, &bytes)?;

        let extract = hidden_command("tar")
            .args(["-xzf"])
            .arg(&archive)
            .arg("-C")
            .arg(&stage)
            .output();
        let _ = std::fs::remove_file(&archive);
        let output = match extract {
            Ok(output) => output,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&stage);
                return Err(error).context("impossibile eseguire tar per estrarre JDT LS");
            }
        };
        if !output.status.success() {
            let _ = std::fs::remove_dir_all(&stage);
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Estrazione di JDT LS non riuscita: {}", stderr.trim());
        }

        let launcher_jar = find_equinox_launcher_name(&stage).with_context(|| {
            let _ = std::fs::remove_dir_all(&stage);
            "launcher Equinox non trovato nell'archivio JDT LS"
        })?;

        let target = root.join("jdtls");
        if target.exists() {
            let _ = std::fs::remove_dir_all(&target);
        }
        std::fs::rename(&stage, &target).with_context(|| {
            let _ = std::fs::remove_dir_all(&stage);
            "impossibile completare l'installazione di JDT LS"
        })?;

        write_jdtls_launcher(&root.join("bin"), &launcher_jar, java_major)?;
        Ok(())
    })
    .await
    .map_err(|error| anyhow!("installazione JDT LS interrotta: {error}"))??;

    Ok(format!("Eclipse JDT LS {milestone} installato"))
}

fn write_jdtls_launcher(bin_dir: &Path, launcher_jar: &str, java_major: u32) -> Result<()> {
    std::fs::create_dir_all(bin_dir)?;
    let extra_jvm = if java_major >= 24 {
        "-Djdk.xml.maxGeneralEntitySizeLimit=0 -Djdk.xml.totalEntitySizeLimit=0 "
    } else {
        ""
    };
    #[cfg(windows)]
    {
        let script = format!(
            "@echo off\r\n\
             setlocal\r\n\
             set \"JAVA_EXE=java\"\r\n\
             if defined JAVA_HOME if exist \"%JAVA_HOME%\\bin\\java.exe\" set \"JAVA_EXE=%JAVA_HOME%\\bin\\java.exe\"\r\n\
             \"%JAVA_EXE%\" {extra_jvm}-Declipse.application=org.eclipse.jdt.ls.core.id1 \
             -Dosgi.bundles.defaultStartLevel=4 \
             -Declipse.product=org.eclipse.jdt.ls.core.product \
             -Dosgi.checkConfiguration=true \
             \"-Dosgi.sharedConfiguration.area=%~dp0..\\jdtls\\config_win\" \
             -Dosgi.sharedConfiguration.area.readOnly=true \
             -Dosgi.configuration.cascaded=true \
             -Xms1G \
             --add-modules=ALL-SYSTEM \
             --add-opens java.base/java.util=ALL-UNNAMED \
             --add-opens java.base/java.lang=ALL-UNNAMED \
             -jar \"%~dp0..\\jdtls\\plugins\\{launcher_jar}\" %*\r\n"
        );
        std::fs::write(bin_dir.join("jdtls.cmd"), script)
            .context("impossibile scrivere il launcher jdtls.cmd")?;
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let config_dir = if cfg!(target_os = "macos") {
            "config_mac"
        } else {
            "config_linux"
        };
        let script = format!(
            "#!/usr/bin/env sh\n\
             BASE=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"\n\
             JAVA_EXE=\"java\"\n\
             if [ -n \"$JAVA_HOME\" ] && [ -x \"$JAVA_HOME/bin/java\" ]; then JAVA_EXE=\"$JAVA_HOME/bin/java\"; fi\n\
             exec \"$JAVA_EXE\" {extra_jvm}-Declipse.application=org.eclipse.jdt.ls.core.id1 \
             -Dosgi.bundles.defaultStartLevel=4 \
             -Declipse.product=org.eclipse.jdt.ls.core.product \
             -Dosgi.checkConfiguration=true \
             \"-Dosgi.sharedConfiguration.area=$BASE/jdtls/{config_dir}\" \
             -Dosgi.sharedConfiguration.area.readOnly=true \
             -Dosgi.configuration.cascaded=true \
             -Xms1G \
             --add-modules=ALL-SYSTEM \
             --add-opens java.base/java.util=ALL-UNNAMED \
             --add-opens java.base/java.lang=ALL-UNNAMED \
             -jar \"$BASE/jdtls/plugins/{launcher_jar}\" \"$@\"\n"
        );
        let path = bin_dir.join("jdtls");
        std::fs::write(&path, script).context("impossibile scrivere il launcher jdtls")?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn find_equinox_launcher_name(jdtls_dir: &Path) -> Result<String> {
    let plugins = jdtls_dir.join("plugins");
    for entry in std::fs::read_dir(&plugins).context("cartella plugins di JDT LS mancante")? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name == "org.eclipse.equinox.launcher.jar"
            || name.starts_with("org.eclipse.equinox.launcher_"))
            && name.ends_with(".jar")
        {
            return Ok(name);
        }
    }
    bail!("org.eclipse.equinox.launcher*.jar non trovato in plugins")
}

fn detect_java_major_version() -> Result<u32> {
    let java_exe = java_executable();
    let output = hidden_command(&java_exe)
        .arg("-version")
        .output()
        .with_context(|| {
            "Java non trovato nel PATH (né in JAVA_HOME). Installa un JDK 21+ prima di installare Eclipse JDT LS."
        })?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_java_major_version(&combined)
        .with_context(|| format!("Impossibile determinare la versione di Java da: {}", combined.trim()))
}

fn java_executable() -> PathBuf {
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        let name = if cfg!(windows) { "java.exe" } else { "java" };
        let candidate = PathBuf::from(home).join("bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("java")
}

fn parse_java_major_version(output: &str) -> Option<u32> {
    let regex = Regex::new(r#"version\s+"(\d+)(?:\.(\d+))?"#).ok()?;
    let caps = regex.captures(output)?;
    let major: u32 = caps.get(1)?.as_str().parse().ok()?;
    if major == 1 {
        caps.get(2)?.as_str().parse().ok()
    } else {
        Some(major)
    }
}

fn highest_milestone_version(html: &str) -> Option<String> {
    let regex = Regex::new(r#"href=['"](?:[^'"]*/)?(\d+)\.(\d+)\.(\d+)/?['"]"#).ok()?;
    regex
        .captures_iter(html)
        .filter_map(|caps| {
            let major: u32 = caps.get(1)?.as_str().parse().ok()?;
            let minor: u32 = caps.get(2)?.as_str().parse().ok()?;
            let patch: u32 = caps.get(3)?.as_str().parse().ok()?;
            Some((major, minor, patch))
        })
        .max()
        .map(|(major, minor, patch)| format!("{major}.{minor}.{patch}"))
}

async fn install_npm_packages(
    app: &AppHandle,
    server_id: &str,
    root: &Path,
    label: &str,
    packages: &'static [&'static str],
) -> Result<String> {
    emit_progress(app, server_id, &format!("Installazione di {label} tramite npm…"));
    let prefix = root.join("npm");
    let label = label.to_owned();
    tokio::task::spawn_blocking(move || -> Result<String> {
        std::fs::create_dir_all(&prefix)?;
        let npm = resolve_tool("npm").context(
            "npm non trovato nel PATH. Installa Node.js per poter installare questo language server.",
        )?;
        let output = hidden_command(npm)
            .args(["install", "--no-audit", "--no-fund", "--prefix"])
            .arg(&prefix)
            .args(packages)
            .output()
            .context("impossibile avviare npm")?;
        if !output.status.success() {
            let detail = command_error_tail(&output);
            bail!("Installazione npm non riuscita: {detail}");
        }
        Ok(format!("{label} installato"))
    })
    .await
    .map_err(|error| anyhow!("installazione npm interrotta: {error}"))?
}

async fn install_rust_analyzer(app: &AppHandle, server_id: &str) -> Result<String> {
    emit_progress(app, server_id, "Installazione di rust-analyzer tramite rustup…");
    tokio::task::spawn_blocking(move || -> Result<String> {
        let rustup = resolve_tool("rustup")
            .context("rustup non trovato nel PATH. Installa Rust tramite rustup e riprova.")?;
        let output = hidden_command(rustup)
            .args(["component", "add", "rust-analyzer"])
            .output()
            .context("impossibile avviare rustup")?;
        if !output.status.success() {
            let detail = command_error_tail(&output);
            bail!("Installazione rust-analyzer non riuscita: {detail}");
        }
        Ok("rust-analyzer installato".to_owned())
    })
    .await
    .map_err(|error| anyhow!("installazione rust-analyzer interrotta: {error}"))?
}

async fn install_gopls(app: &AppHandle, server_id: &str, root: &Path) -> Result<String> {
    emit_progress(app, server_id, "Installazione di gopls tramite Go…");
    let bin = root.join("bin");
    tokio::task::spawn_blocking(move || -> Result<String> {
        let go = resolve_tool("go")
            .context("Go non trovato nel PATH. Installa Go e riprova.")?;
        let output = hidden_command(go)
            .args(["install", "golang.org/x/tools/gopls@latest"])
            .env("GOBIN", &bin)
            .output()
            .context("impossibile avviare go install")?;
        if !output.status.success() {
            let detail = command_error_tail(&output);
            bail!("Installazione gopls non riuscita: {detail}");
        }
        Ok("gopls installato".to_owned())
    })
    .await
    .map_err(|error| anyhow!("installazione gopls interrotta: {error}"))?
}

async fn install_csharp_ls(app: &AppHandle, server_id: &str, root: &Path) -> Result<String> {
    emit_progress(app, server_id, "Installazione di csharp-ls tramite .NET SDK…");
    let bin = root.join("bin");
    tokio::task::spawn_blocking(move || -> Result<String> {
        let dotnet = resolve_tool("dotnet")
            .context("dotnet non trovato nel PATH. Installa .NET SDK e riprova.")?;
        let subcommand = if bin.join(if cfg!(windows) { "csharp-ls.exe" } else { "csharp-ls" }).is_file() {
            "update"
        } else {
            "install"
        };
        let output = hidden_command(dotnet)
            .args(["tool", subcommand, "--tool-path"])
            .arg(&bin)
            .arg("csharp-ls")
            .output()
            .context("impossibile avviare dotnet tool")?;
        if !output.status.success() {
            let detail = command_error_tail(&output);
            bail!("Installazione csharp-ls non riuscita: {detail}");
        }
        Ok("csharp-ls installato".to_owned())
    })
    .await
    .map_err(|error| anyhow!("installazione csharp-ls interrotta: {error}"))?
}

fn resolve_tool(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = [".exe", ".cmd", ".bat", ".com", ""];
    #[cfg(not(windows))]
    let extensions = [""];
    for dir in std::env::split_paths(&paths) {
        for ext in extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn command_error_tail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    text.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_and_legacy_java_versions() {
        assert_eq!(
            parse_java_major_version("java version \"21.0.10\" 2026-01-20 LTS"),
            Some(21)
        );
        assert_eq!(
            parse_java_major_version("openjdk version \"25.0.1\" 2025-10-21"),
            Some(25)
        );
        assert_eq!(
            parse_java_major_version("java version \"1.8.0_402\""),
            Some(8)
        );
        assert_eq!(parse_java_major_version("no version here"), None);
    }

    #[test]
    fn picks_highest_semantic_milestone_from_html() {
        let html = r#"
            <a href="1.9.0/">1.9.0/</a>
            <a href="/jdtls/milestones/1.61.0/">1.61.0/</a>
            <a href="https://download.eclipse.org/jdtls/milestones/1.63.0/">1.63.0/</a>
            <a href="1.62.0">1.62.0</a>
        "#;
        assert_eq!(highest_milestone_version(html).as_deref(), Some("1.63.0"));
    }

    #[test]
    fn maps_builtin_keys_to_installable_servers_and_ignores_custom_keys() {
        assert_eq!(installable_for_key("java").unwrap().id, "java");
        assert_eq!(installable_for_key("typescript").unwrap().id, "typescript");
        assert_eq!(installable_for_key("html").unwrap().id, "web");
        assert_eq!(installable_for_key("css").unwrap().id, "web");
        assert_eq!(installable_for_key("json").unwrap().id, "web");
        assert_eq!(installable_for_key("rust").unwrap().id, "rust");
        assert!(installable_for_key("custom:0:java").is_none());
        assert!(installable_for_key("unknown").is_none());
    }

    #[test]
    fn writes_standalone_jdtls_launcher_without_python_dependency() {
        let temp = std::env::temp_dir().join(format!("helmcode-jdtls-launcher-{}", uuid::Uuid::new_v4()));
        let bin = temp.join("bin");
        write_jdtls_launcher(&bin, "org.eclipse.equinox.launcher_1.6.900.jar", 21).unwrap();
        #[cfg(windows)]
        let launcher = std::fs::read_to_string(bin.join("jdtls.cmd")).unwrap();
        #[cfg(not(windows))]
        let launcher = std::fs::read_to_string(bin.join("jdtls")).unwrap();
        assert!(launcher.contains("org.eclipse.equinox.launcher_1.6.900.jar"));
        assert!(!launcher.contains("python"));
        assert!(!launcher.contains("maxGeneralEntitySizeLimit"));

        write_jdtls_launcher(&bin, "org.eclipse.equinox.launcher_1.7.0.jar", 25).unwrap();
        #[cfg(windows)]
        let launcher25 = std::fs::read_to_string(bin.join("jdtls.cmd")).unwrap();
        #[cfg(not(windows))]
        let launcher25 = std::fs::read_to_string(bin.join("jdtls")).unwrap();
        assert!(launcher25.contains("maxGeneralEntitySizeLimit=0"));
        let _ = std::fs::remove_dir_all(temp);
    }
}
