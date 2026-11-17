use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child as ProcessChild, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use super::buffer::RingBuffer;

const AGENT_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, serde::Serialize)]
struct PtyData<'a> {
    id: &'a str,
    data: &'a [u8],
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    _child: Box<dyn Child + Send + Sync>,
    pub buffer: Arc<Mutex<RingBuffer>>,
}

impl PtySession {
    pub fn start(
        app: &AppHandle,
        id: &str,
        workspace: &Path,
        rows: u16,
        cols: u16,
        agent: Option<&str>,
    ) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(size(rows, cols))
            .context("impossibile creare la PTY")?;

        let mut command = CommandBuilder::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile"]);
        if let Some(agent) = agent {
            let program = agent_command(agent)?;
            command.args(["-Command", &format!("{program}; exit $LASTEXITCODE")]);
        }
        command.cwd(workspace);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(command)
            .context("impossibile avviare powershell.exe")?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("impossibile leggere dalla PTY")?;
        let writer = pair
            .master
            .take_writer()
            .context("impossibile scrivere sulla PTY")?;
        let killer = child.clone_killer();
        let buffer = Arc::new(Mutex::new(RingBuffer::new(AGENT_BUFFER_BYTES)));

        {
            let app = app.clone();
            let buffer = Arc::clone(&buffer);
            let session_id = id.to_string();
            let exit_id = id.to_string();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            let bytes = &chunk[..read];
                            if let Ok(mut guard) = buffer.lock() {
                                guard.push(bytes);
                            }
                            let _ = app.emit(
                                "pty-data",
                                PtyData { id: &session_id, data: bytes },
                            );
                        }
                        Err(_) => break,
                    }
                }
                let _ = app.emit("pty-exit", serde_json::json!({ "id": exit_id }));
            });
        }

        Ok(Self {
            master: pair.master,
            writer,
            killer,
            _child: child,
            buffer,
        })
    }

    pub fn write(&mut self, data: &str) -> Result<()> {
        self.writer.write_all(data.as_bytes())?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master.resize(size(rows, cols))?;
        Ok(())
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buffer
            .lock()
            .map(|guard| guard.snapshot())
            .unwrap_or_default()
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub output: String,
}

const COMMAND_STREAM_LIMIT: usize = 256 * 1024;

struct CapturedOutput {
    head: Vec<u8>,
    tail: RingBuffer,
    limit: usize,
    bytes: usize,
}

impl CapturedOutput {
    fn new(limit: usize) -> Self {
        Self { head: Vec::new(), tail: RingBuffer::new(limit - limit / 2), limit, bytes: 0 }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.bytes = self.bytes.saturating_add(bytes.len());
        let head = bytes.len().min((self.limit / 2).saturating_sub(self.head.len()));
        self.head.extend_from_slice(&bytes[..head]);
        self.tail.push(&bytes[head..]);
    }

    fn text(&self) -> String {
        let tail = self.tail.snapshot();
        if self.bytes > self.limit {
            format!("{}\n[output troncato: conservati inizio e fine, limite {} KiB per stream]\n{}",
                strip_ansi(&String::from_utf8_lossy(&self.head)), self.limit / 1024, strip_ansi(&String::from_utf8_lossy(&tail)))
        } else {
            let mut bytes = self.head.clone();
            bytes.extend_from_slice(&tail);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }
}

pub(crate) trait CommandPipe: Read + Send + 'static {
    fn available(&self) -> std::io::Result<usize>;
}

#[cfg(windows)]
impl<R: Read + Send + std::os::windows::io::AsRawHandle + 'static> CommandPipe for R {
    fn available(&self) -> std::io::Result<usize> {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        extern "system" {
            fn PeekNamedPipe(pipe: *mut c_void, buffer: *mut c_void, size: u32,
                read: *mut u32, available: *mut u32, remaining: *mut u32) -> i32;
        }
        let mut available = 0;
        // Each pipe has exactly one reader. Check available data so read cannot
        // wait forever for a descendant that inherited stdout/stderr to close it.
        let success = unsafe { PeekNamedPipe(self.as_raw_handle(), std::ptr::null_mut(), 0,
            std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
        if success == 0 { Err(std::io::Error::last_os_error()) } else { Ok(available as usize) }
    }
}

#[cfg(not(windows))]
impl<R: Read + Send + 'static> CommandPipe for R {
    fn available(&self) -> std::io::Result<usize> { Ok(8192) }
}

fn capture_command_pipe(mut reader: impl CommandPipe, stopped: Arc<AtomicBool>) -> std::thread::JoinHandle<CapturedOutput> {
    std::thread::spawn(move || {
        let mut captured = CapturedOutput::new(COMMAND_STREAM_LIMIT);
        let mut buffer = [0; 8192];
        while !stopped.load(Ordering::Acquire) {
            let count = match reader.available() { Ok(count) => count.min(buffer.len()), Err(_) => break };
            if count == 0 { std::thread::sleep(Duration::from_millis(10)); continue; }
            match reader.read(&mut buffer[..count]) {
                Ok(0) | Err(_) => break,
                Ok(count) => captured.push(&buffer[..count]),
            }
        }
        captured
    })
}

fn terminate_command(child: &mut ProcessChild) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    if child.kill().is_ok() {
        let _ = child.wait();
    } else {
        // Do not wait forever if termination was denied or the tree already exited.
        let _ = child.try_wait();
    }
}

pub fn run_command_blocking(
    workspace: &Path,
    command: &str,
    timeout: Duration,
) -> Result<CommandOutput> {
    let mut command_process = Command::new("powershell.exe");
    command_process
        .args(["-NoLogo", "-NoProfile", "-Command", command])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command_process.creation_flags(0x0800_0000);
    }

    let mut child = command_process
        .spawn()
        .context("impossibile avviare il comando")?;

    let stdout = child
        .stdout
        .take()
        .context("stdout del comando non disponibile")?;
    let stderr = child
        .stderr
        .take()
        .context("stderr del comando non disponibile")?;
    let stopped = Arc::new(AtomicBool::new(false));
    let out_reader = capture_command_pipe(stdout, stopped.clone());
    let err_reader = capture_command_pipe(stderr, stopped.clone());

    let started = Instant::now();
    let mut status = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(current)) => {
                status = Some(current);
                break;
            }
            Ok(None) => {}
            Err(_) => { terminate_command(&mut child); break; },
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            terminate_command(&mut child);
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }

    // A completed shell may leave a background child holding its pipe handles.
    // Drain already-written output, then close our readers instead of hanging on join.
    let drain_deadline = Instant::now() + Duration::from_secs(1);
    while (!out_reader.is_finished() || !err_reader.is_finished()) && Instant::now() < drain_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let incomplete = !out_reader.is_finished() || !err_reader.is_finished();
    stopped.store(true, Ordering::Release);
    let stdout = out_reader.join().map(|output| output.text()).unwrap_or_default();
    let stderr = err_reader.join().map(|output| output.text()).unwrap_or_default();

    let mut raw = stdout;
    if !stderr.is_empty() {
        if !raw.is_empty() {
            raw.push('\n');
        }
        raw.push_str(&stderr);
    }
    let output = strip_ansi(&raw);
    let mut trimmed = output.trim_end().to_string();
    if incomplete {
        if !trimmed.is_empty() { trimmed.push('\n'); }
        trimmed.push_str("[lettura output interrotta: un processo discendente mantiene aperto stdout o stderr]");
    }
    if timed_out {
        if !trimmed.is_empty() {
            trimmed.push('\n');
        }
        trimmed.push_str(&format!(
            "[timeout dopo {}s, il comando potrebbe essere ancora in esecuzione]",
            timeout.as_secs()
        ));
    }

    Ok(CommandOutput {
        success: status
            .as_ref()
            .map(|value| value.success())
            .unwrap_or(false)
            && !timed_out,
        exit_code: status.as_ref().and_then(|value| value.code()),
        output: trimmed,
    })
}

pub fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(current) = chars.next() {
        if current == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some('(') | Some(')') => {
                    chars.next();
                }
                Some(_) | None => {}
            }
        } else if current == '\r' {
            continue;
        } else if current == '\u{8}' {
            output.pop();
        } else {
            output.push(current);
        }
    }
    output
}

fn agent_command(agent: &str) -> Result<&'static str> {
    match agent {
        "opencode" => Ok("opencode"),
        "pi" => Ok("pi"),
        "claude" => Ok("claude"),
        "agy" => Ok("agy"),
        other => bail!("agente non supportato: {other}"),
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::{agent_command, run_command_blocking, strip_ansi, CapturedOutput, PtyData, COMMAND_STREAM_LIMIT};
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn borrowed_output_retains_the_numeric_byte_array_wire_format() {
        let bytes = [0, 27, 128, 255];
        let payload = PtyData { id: "test\"id", data: &bytes };
        assert_eq!(serde_json::to_value(&payload).unwrap(), serde_json::json!({
            "id": "test\"id", "data": [0, 27, 128, 255]
        }));
    }

    #[test]
    fn maps_supported_agents_and_rejects_others() {
        assert_eq!(agent_command("opencode").unwrap(), "opencode");
        assert_eq!(agent_command("pi").unwrap(), "pi");
        assert_eq!(agent_command("claude").unwrap(), "claude");
        assert_eq!(agent_command("agy").unwrap(), "agy");
        assert!(agent_command("rm -rf /").is_err());
    }

    #[test]
    fn strips_ansi_sequences_and_carriage_returns() {
        assert_eq!(strip_ansi("\u{1b}[31mrosso\u{1b}[0m\r\n"), "rosso\n");
        assert_eq!(strip_ansi("a\u{8}b"), "b");
    }

    #[test]
    fn runs_a_short_powershell_command() {
        let result = run_command_blocking(
            Path::new("."),
            "Write-Output helmcode-check",
            // Native process startup competes with the Git integration tests on CI.
            Duration::from_secs(30),
        )
        .expect("command should run");
        println!(
            "success={} code={:?} output={:?}",
            result.success, result.exit_code, result.output
        );
        assert!(result.success, "output: {}", result.output);
        assert!(result.output.contains("helmcode-check"));
    }

    #[test]
    fn captured_output_is_bounded_and_retains_both_ends_without_splitting_small_utf8() {
        let mut capture = CapturedOutput::new(64);
        for byte in "prima 😀 dopo".as_bytes() { capture.push(&[*byte]); }
        assert_eq!(capture.text(), "prima 😀 dopo");
        capture.push(&[b'x'; 1_000_000]);
        capture.push(b"final diagnostic");
        assert_eq!(capture.head.len() + capture.tail.snapshot().len(), 64);
        assert!(capture.text().starts_with("prima 😀 dopo"));
        assert!(capture.text().ends_with("final diagnostic"));
        assert!(capture.text().contains("output troncato"));
    }

    #[test]
    fn a_large_command_reports_truncation_and_preserves_stderr_diagnostics() {
        let result = run_command_blocking(Path::new("."),
            "[Console]::Out.Write('BEGIN'); [Console]::Out.Write(('x' * 1048576)); [Console]::Out.Write('END'); [Console]::Error.Write('STDERR diagnostic')",
            Duration::from_secs(30)).unwrap();
        assert!(result.success, "{}", result.output);
        assert!(result.output.starts_with("BEGIN"));
        assert!(result.output.contains("END"));
        assert!(result.output.ends_with("STDERR diagnostic"));
        assert!(result.output.contains("output troncato"));
        assert!(result.output.len() < COMMAND_STREAM_LIMIT + 1000);
    }

    #[test]
    #[cfg(windows)]
    fn inherited_pipe_fixture() {
        if std::env::var("HELMCODE_CAPTURE_FIXTURE").as_deref() != Ok("1") { return; }
        use std::os::windows::process::CommandExt;
        let child = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000).stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit()).stderr(std::process::Stdio::inherit())
            .spawn().unwrap();
        println!("FIXTURE_CHILD_PID={}", child.id());
        println!("PARENT_EXITED");
        eprintln!("FIXTURE_STDERR 😀");
    }

    #[test]
    #[cfg(windows)]
    fn a_completed_shell_does_not_wait_for_a_background_process_to_close_its_pipes() {
        let started = std::time::Instant::now();
        let executable = std::env::current_exe().unwrap().display().to_string().replace('\'', "''");
        let command = format!("$env:HELMCODE_CAPTURE_FIXTURE='1'; & '{executable}' --exact pty::session::tests::inherited_pipe_fixture --nocapture");
        let result = run_command_blocking(Path::new("."), &command, Duration::from_secs(30)).unwrap();
        let elapsed = started.elapsed();
        // This PID comes only from the process created by this fixture.
        let pid = result.output.lines().find_map(|line| line.split_once("FIXTURE_CHILD_PID=")?.1.trim().parse::<u32>().ok());
        if let Some(pid) = pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        }
        assert!(result.success, "{}", result.output);
        assert!(pid.is_some(), "background fixture did not start: {}", result.output);
        assert!(result.output.contains("PARENT_EXITED"));
        assert!(result.output.contains("lettura output interrotta"));
        assert!(elapsed < Duration::from_secs(25), "completion blocked on descendant pipes for {elapsed:?}");
    }
}
