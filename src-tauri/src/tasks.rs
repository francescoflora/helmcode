use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State};

use crate::state::AppState;
use crate::pty::session::CommandPipe;

struct RunningTask {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

static RUNNING_TASKS: OnceLock<Mutex<HashMap<String, RunningTask>>> = OnceLock::new();

fn running_tasks() -> &'static Mutex<HashMap<String, RunningTask>> {
    RUNNING_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEvent {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    code: Option<i32>,
    cancelled: bool,
}

/// Run only a task discovered in the current workspace; the frontend never supplies shell code.
#[tauri::command]
pub fn task_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    run_id: String,
) -> Result<(), String> {
    if run_id.is_empty() || run_id.len() > 128 {
        return Err("Identificativo esecuzione non valido".into());
    }
    let workspace = state.workspace_root();
    let task = detect(&workspace)
        .tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| "Task non più disponibile nel workspace".to_string())?;
    let mut registry = running_tasks().lock().map_err(|e| e.to_string())?;
    if registry.contains_key(&run_id) {
        return Err("Esecuzione già avviata".into());
    }
    if registry.len() >= 4 {
        return Err("Arresta un task prima di avviarne un altro".into());
    }
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", &task.command]);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-c", &task.command]);
        command
    };
    command.current_dir(&workspace)
        .env("NO_COLOR", "1")
        .env_remove("FORCE_COLOR")
        .env("CARGO_TERM_COLOR", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("Impossibile avviare {}: {error}", task.label))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(AtomicBool::new(false));
    registry.insert(run_id.clone(), RunningTask { child: child.clone(), cancelled: cancelled.clone() });
    drop(registry);

    std::thread::spawn(move || {
        let output_stopped = Arc::new(AtomicBool::new(false));
        let out = stdout.map(|reader| pump_output(app.clone(), run_id.clone(), "stdout", reader, output_stopped.clone()));
        let err = stderr.map(|reader| pump_output(app.clone(), run_id.clone(), "stderr", reader, output_stopped.clone()));
        let code = loop {
            let status = child.lock().ok().and_then(|mut process| process.try_wait().ok());
            match status {
                Some(Some(status)) => break status.code(),
                None => break None,
                _ => std::thread::sleep(Duration::from_millis(80)),
            }
        };
        let incomplete = finish_output(out, err, &output_stopped);
        if incomplete {
            let _ = app.emit("task-event", TaskEvent {
                id: run_id.clone(), kind: "output", stream: Some("stderr"),
                text: Some("\n[lettura output interrotta: un processo discendente mantiene aperto stdout o stderr]\n".into()),
                code: None, cancelled: false,
            });
        }
        if let Ok(mut registry) = running_tasks().lock() { registry.remove(&run_id); }
        let _ = app.emit("task-event", TaskEvent {
            id: run_id, kind: "finished", stream: None, text: None,
            code, cancelled: cancelled.load(Ordering::SeqCst),
        });
    });
    Ok(())
}

fn finish_output(out: Option<std::thread::JoinHandle<()>>, err: Option<std::thread::JoinHandle<()>>, stopped: &AtomicBool) -> bool {
    let reading = || out.as_ref().is_some_and(|handle| !handle.is_finished())
        || err.as_ref().is_some_and(|handle| !handle.is_finished());
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while reading() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
    let incomplete = reading();
    stopped.store(true, Ordering::Release);
    if let Some(handle) = out { let _ = handle.join(); }
    if let Some(handle) = err { let _ = handle.join(); }
    incomplete
}

fn pump_output(
    app: tauri::AppHandle,
    id: String,
    stream: &'static str,
    reader: impl CommandPipe,
    stopped: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || stream_output(reader, &stopped, |text| {
        let _ = app.emit("task-event", TaskEvent {
            id: id.clone(), kind: "output", stream: Some(stream), text: Some(text), code: None, cancelled: false,
        });
    }))
}

fn stream_output(mut reader: impl CommandPipe, stopped: &AtomicBool, mut emit: impl FnMut(String)) {
    let mut buffer = [0_u8; 4096];
    let mut pending = Vec::new();
    while !stopped.load(Ordering::Acquire) {
        let available = match reader.available() { Ok(available) => available.min(buffer.len()), Err(_) => break };
        if available == 0 { std::thread::sleep(Duration::from_millis(10)); continue; }
        let count = match reader.read(&mut buffer[..available]) { Ok(0) | Err(_) => break, Ok(count) => count };
        pending.extend_from_slice(&buffer[..count]);
        // Hold an incomplete UTF-8 suffix for the next chunk.
        let length = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => pending.len(),
        };
        if length == 0 { continue; }
        let text = String::from_utf8_lossy(&pending[..length]).into_owned();
        pending.drain(..length);
        emit(text);
    }
    if !pending.is_empty() {
        emit(String::from_utf8_lossy(&pending).into_owned());
    }
}

#[tauri::command]
pub async fn task_stop(run_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_task(&run_id))
        .await.map_err(|error| error.to_string())?
}

fn stop_task(run_id: &str) -> Result<(), String> {
    let (child, cancelled) = {
        let registry = running_tasks().lock().map_err(|error| error.to_string())?;
        let Some(task) = registry.get(run_id) else { return Ok(()); };
        (task.child.clone(), task.cancelled.clone())
    };
    cancelled.store(true, Ordering::SeqCst);
    let mut process = child.lock().map_err(|error| error.to_string())?;
    if process.try_wait().map_err(|error| error.to_string())?.is_some() { return Ok(()); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Kill the shell and its children (npm, Cargo, dev server), without a console window.
        let status = Command::new("taskkill.exe")
            .args(["/PID", &process.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
        if status.is_ok_and(|status| status.success()) { return Ok(()); }
    }
    process.kill().map_err(|error| error.to_string())
}

pub fn stop_all() {
    let ids: Vec<String> = running_tasks().lock().map(|tasks| tasks.keys().cloned().collect()).unwrap_or_default();
    for id in ids { let _ = stop_task(&id); }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTask {
    pub id: String,
    pub label: String,
    pub command: String,
    pub group: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTasks {
    pub project_types: Vec<String>,
    pub build: Option<WorkspaceTask>,
    pub play: Option<WorkspaceTask>,
    pub tasks: Vec<WorkspaceTask>,
}

pub fn detect(workspace: &Path) -> WorkspaceTasks {
    let mut result = WorkspaceTasks::default();
    let package_json = workspace.join("package.json");
    let cargo_toml = workspace.join("Cargo.toml");
    let pom_xml = workspace.join("pom.xml");

    if package_json.is_file() {
        result.project_types.push("node".to_string());
        let runner = package_manager(workspace);
        let scripts = std::fs::read_to_string(&package_json)
            .ok()
            .map(|content| content.trim_start_matches('\u{feff}').to_string())
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .and_then(|json| json.get("scripts").cloned())
            .and_then(|scripts| scripts.as_object().cloned())
            .unwrap_or_default();

        for (name, _) in &scripts {
            let kind = if name == "build" {
                "build"
            } else if name == "dev" || name == "start" {
                "play"
            } else if name == "test" {
                "test"
            } else {
                "other"
            };
            result.tasks.push(WorkspaceTask {
                id: format!("npm:{name}"),
                label: name.clone(),
                command: script_command(runner, name),
                group: runner.to_string(),
                kind: kind.to_string(),
            });
        }

        result.build = scripts
            .contains_key("build")
            .then(|| task_by_name(&result.tasks, "build"))
            .flatten();
        result.play = scripts
            .contains_key("dev")
            .then(|| task_by_name(&result.tasks, "dev"))
            .flatten()
            .or_else(|| {
                scripts
                    .contains_key("start")
                    .then(|| task_by_name(&result.tasks, "start"))
                    .flatten()
            });
    }

    let nested_cargo = !cargo_toml.is_file() && workspace.join("src-tauri/Cargo.toml").is_file();
    if cargo_toml.is_file() || nested_cargo {
        result.project_types.push("cargo".to_string());
        let cargo_tasks = [
            ("cargo:build", "cargo build", "cargo build", "build"),
            ("cargo:run", "cargo run", "cargo run", "play"),
            ("cargo:test", "cargo test", "cargo test", "test"),
        ];
        for (id, label, command, kind) in cargo_tasks {
            let id = if nested_cargo { id.replace("cargo:", "cargo:tauri:") } else { id.to_string() };
            let command = if nested_cargo { format!("{command} --manifest-path src-tauri/Cargo.toml") } else { command.to_string() };
            result.tasks.push(WorkspaceTask {
                id,
                label: label.to_string(),
                command,
                group: "cargo".to_string(),
                kind: kind.to_string(),
            });
        }
        if result.build.is_none() {
            result.build = result.tasks.iter().find(|task| task.group == "cargo" && task.kind == "build").cloned();
        }
        if result.play.is_none() {
            result.play = result.tasks.iter().find(|task| task.group == "cargo" && task.kind == "play").cloned();
        }
    }

    if pom_xml.is_file() {
        result.project_types.push("maven".to_string());
        let mvn = maven_command(workspace);
        let pom = std::fs::read_to_string(&pom_xml)
            .unwrap_or_default()
            .to_lowercase();
        for phase in [
            "clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy",
        ] {
            result.tasks.push(WorkspaceTask {
                id: format!("maven:{phase}"),
                label: format!("maven {phase}"),
                command: format!("{mvn} {phase}"),
                group: "maven".to_string(),
                kind: "build".to_string(),
            });
        }
        let mut run_goals: Vec<&str> = Vec::new();
        for (plugin, goal) in [
            ("spring-boot-maven-plugin", "spring-boot:run"),
            ("quarkus-maven-plugin", "quarkus:dev"),
            ("javafx-maven-plugin", "javafx:run"),
            ("jetty-maven-plugin", "jetty:run"),
            ("exec-maven-plugin", "exec:java"),
        ] {
            if pom.contains(plugin) {
                run_goals.push(goal);
            }
        }
        if run_goals.is_empty() {
            run_goals.extend(["spring-boot:run", "exec:java"]);
        }
        for goal in run_goals {
            result.tasks.push(WorkspaceTask {
                id: format!("maven:{goal}"),
                label: format!("maven {goal}"),
                command: format!("{mvn} {goal}"),
                group: "maven".to_string(),
                kind: "play".to_string(),
            });
        }
        if result.build.is_none() {
            result.build = result.tasks.iter().find(|task| task.id == "maven:package").cloned();
        }
        if result.play.is_none() {
            result.play = result.tasks.iter().find(|task| task.group == "maven" && task.kind == "play").cloned();
        }
    }

    result
}

fn maven_command(workspace: &Path) -> &'static str {
    if workspace.join("mvnw.cmd").is_file() {
        "mvnw.cmd"
    } else if workspace.join("mvnw").is_file() {
        if cfg!(windows) { "mvnw" } else { "./mvnw" }
    } else {
        "mvn"
    }
}

fn task_by_name(tasks: &[WorkspaceTask], name: &str) -> Option<WorkspaceTask> {
    tasks.iter().find(|task| task.label == name).cloned()
}

fn package_manager(workspace: &Path) -> &'static str {
    if workspace.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if workspace.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

fn script_command(runner: &str, script: &str) -> String {
    match runner {
        "pnpm" => format!("pnpm run {script}"),
        "yarn" => format!("yarn {script}"),
        _ => format!("npm run {script}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{detect, finish_output, stream_output};
    use std::fs;
    use std::io::{Cursor, Read};
    use std::sync::atomic::AtomicBool;
    use crate::pty::session::CommandPipe;
    use uuid::Uuid;

    fn workspace() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("helmcode-tasks-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn detects_node_scripts_and_defaults() {
        let directory = workspace();
        fs::write(
            directory.join("package.json"),
            r#"{"scripts":{"build":"tsc","dev":"vite","test":"vitest","lint":"eslint ."}}"#,
        )
        .unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.project_types, vec!["node".to_string()]);
        assert_eq!(tasks.build.unwrap().command, "npm run build");
        assert_eq!(tasks.play.unwrap().command, "npm run dev");
        assert_eq!(tasks.tasks.len(), 4);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn detects_cargo_tasks() {
        let directory = workspace();
        fs::write(directory.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.project_types, vec!["cargo".to_string()]);
        assert_eq!(tasks.build.unwrap().command, "cargo build");
        assert_eq!(tasks.play.unwrap().command, "cargo run");
        assert!(tasks.tasks.iter().any(|task| task.command == "cargo test"));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn detects_maven_tasks_and_run_goals() {
        let directory = workspace();
        fs::write(
            directory.join("pom.xml"),
            r#"<project><build><plugins>
                <plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin>
                <plugin><artifactId>exec-maven-plugin</artifactId></plugin>
            </plugins></build></project>"#,
        )
        .unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.project_types, vec!["maven".to_string()]);
        assert_eq!(tasks.build.unwrap().command, "mvn package");
        assert_eq!(tasks.play.unwrap().command, "mvn spring-boot:run");
        assert!(tasks.tasks.iter().any(|task| task.command == "mvn clean" && task.kind == "build"));
        assert!(tasks.tasks.iter().any(|task| task.command == "mvn install" && task.kind == "build"));
        assert!(tasks.tasks.iter().any(|task| task.command == "mvn exec:java" && task.kind == "play"));
        assert_eq!(tasks.tasks.iter().filter(|task| task.kind == "build").count(), 9);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn maven_without_known_plugins_offers_common_run_goals() {
        let directory = workspace();
        fs::write(directory.join("pom.xml"), "<project></project>").unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.play.unwrap().command, "mvn spring-boot:run");
        assert!(tasks.tasks.iter().any(|task| task.command == "mvn exec:java" && task.kind == "play"));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn detects_nested_tauri_cargo_alongside_frontend() {
        let directory = workspace();
        fs::write(directory.join("package.json"), r#"{"scripts":{"build":"vite build","dev":"vite"}}"#).unwrap();
        fs::create_dir(directory.join("src-tauri")).unwrap();
        fs::write(directory.join("src-tauri/Cargo.toml"), "[package]\nname=\"desktop\"\n").unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.project_types, vec!["node", "cargo"]);
        assert_eq!(tasks.build.unwrap().command, "npm run build");
        assert_eq!(tasks.play.unwrap().command, "npm run dev");
        assert!(tasks.tasks.iter().any(|task| task.id == "cargo:tauri:build" && task.command == "cargo build --manifest-path src-tauri/Cargo.toml"));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn root_cargo_manifest_takes_precedence_over_nested_manifest() {
        let directory = workspace();
        fs::write(directory.join("Cargo.toml"), "[package]\nname=\"root\"\n").unwrap();
        fs::create_dir(directory.join("src-tauri")).unwrap();
        fs::write(directory.join("src-tauri/Cargo.toml"), "[package]\nname=\"nested\"\n").unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.tasks.len(), 3);
        assert!(tasks.tasks.iter().all(|task| !task.command.contains("--manifest-path")));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn respects_pnpm_and_keeps_cargo_as_fallback() {
        let directory = workspace();
        fs::write(
            directory.join("package.json"),
            r#"{"scripts":{"start":"vite"}}"#,
        )
        .unwrap();
        fs::write(directory.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(directory.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.play.unwrap().command, "pnpm run start");
        assert_eq!(tasks.build.unwrap().command, "cargo build");
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn handles_package_json_with_bom() {
        let directory = workspace();
        fs::write(
            directory.join("package.json"),
            "\u{feff}{\"scripts\":{\"build\":\"tsc\",\"dev\":\"vite\"}}",
        )
        .unwrap();
        let tasks = detect(&directory);
        assert_eq!(tasks.build.unwrap().command, "npm run build");
        assert_eq!(tasks.play.unwrap().command, "npm run dev");
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn returns_empty_without_project_files() {
        let directory = workspace();
        let tasks = detect(&directory);
        assert!(tasks.project_types.is_empty());
        assert!(tasks.build.is_none());
        assert!(tasks.play.is_none());
        assert!(tasks.tasks.is_empty());
        fs::remove_dir_all(directory).ok();
    }

    struct BytewisePipe(Cursor<Vec<u8>>);

    impl Read for BytewisePipe {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let length = bytes.len().min(1);
            self.0.read(&mut bytes[..length])
        }
    }

    #[cfg(windows)]
    impl CommandPipe for BytewisePipe {
        fn available(&self) -> std::io::Result<usize> {
            if self.0.position() < self.0.get_ref().len() as u64 { Ok(1) }
            else { Err(std::io::ErrorKind::BrokenPipe.into()) }
        }
    }

    #[test]
    fn task_streams_preserve_utf8_when_every_character_is_split_between_reads() {
        for expected in ["stdout: più codice 😀\n", "stderr: errore è qui 🦀\n"] {
            let mut chunks = Vec::new();
            stream_output(BytewisePipe(Cursor::new(expected.as_bytes().to_vec())), &AtomicBool::new(false), |text| chunks.push(text));
            assert_eq!(chunks.concat(), expected);
        }
    }

    #[test]
    #[cfg(windows)]
    fn task_output_finishes_when_a_detached_child_inherits_both_streams() {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pty::session::tests::inherited_pipe_fixture", "--nocapture"])
            .env("HELMCODE_CAPTURE_FIXTURE", "1").creation_flags(0x08000000)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let output = Arc::new(Mutex::new(String::new()));
        let error = Arc::new(Mutex::new(String::new()));
        let out = { let stopped = stopped.clone(); let output = output.clone();
            std::thread::spawn(move || stream_output(stdout, &stopped, |text| output.lock().unwrap().push_str(&text))) };
        let err = { let stopped = stopped.clone(); let error = error.clone();
            std::thread::spawn(move || stream_output(stderr, &stopped, |text| error.lock().unwrap().push_str(&text))) };
        let status = child.wait().unwrap();
        let started = Instant::now();
        let incomplete = finish_output(Some(out), Some(err), &stopped);
        let elapsed = started.elapsed();
        let output = output.lock().unwrap().clone();
        let pid = output.lines().find_map(|line| line.split_once("FIXTURE_CHILD_PID=")?.1.trim().parse::<u32>().ok());
        if let Some(pid) = pid {
            let _ = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        assert!(status.success());
        assert!(pid.is_some(), "fixture did not create the background process: {output}");
        assert!(output.contains("PARENT_EXITED"));
        assert!(error.lock().unwrap().contains("FIXTURE_STDERR 😀"));
        assert!(incomplete, "fixture must keep its inherited pipes open");
        assert!(elapsed < Duration::from_secs(10), "task readers blocked for {elapsed:?}");
    }
}
