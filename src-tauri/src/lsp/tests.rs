//! Exercise the actual stdio transport against a deliberately small LSP peer.
//! Node is already required to develop and build helmcode.
use super::*;

const FAKE_SERVER: &str = r#"
let buffer = Buffer.alloc(0);
let initializeId;
let initializeReplied = false;
let configResult;
const events = [];
const protocolErrors = [];
const replies = [];
const documents = new Map();
let navigationOverrides = {};
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`));
  process.stdout.write(body);
}
function offsetAt(text, position) {
  let offset = 0;
  const endings = /\r\n|\r|\n/g;
  for (let line = 0; line < position.line; line++) {
    const match = endings.exec(text);
    if (!match) throw new Error('Invalid line in incremental edit');
    offset = match.index + match[0].length;
  }
  return offset + position.character;
}
function handle(message) {
  events.push(message);
  const { id, method, params } = message;
  if (method === 'initialize') {
    initializeId = id;
    send({ id: 'server-settings', method: 'workspace/configuration', params: { items: [{ section: 'test' }] } });
    return;
  }
  if (id === 'server-settings') {
    configResult = message.result;
    setTimeout(() => {
      initializeReplied = true;
      send({ id: initializeId, result: { capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        completionProvider: { triggerCharacters: ['.'] },
        definitionProvider: true, declarationProvider: true, implementationProvider: true,
        documentSymbolProvider: true
      } } });
    }, 25);
    return;
  }
  if (method === 'initialized' && !initializeReplied) protocolErrors.push('initialized before initialize response');
  if (method === 'textDocument/didOpen') documents.set(params.textDocument.uri, params.textDocument.text);
  if (method === 'textDocument/didChange') {
    let text = documents.get(params.textDocument.uri);
    for (const change of params.contentChanges) {
      text = change.range
        ? text.slice(0, offsetAt(text, change.range.start)) + change.text + text.slice(offsetAt(text, change.range.end))
        : change.text;
    }
    documents.set(params.textDocument.uri, text);
  }
  if (method === 'textDocument/didClose') documents.delete(params.textDocument.uri);
  if (method === 'textDocument/completion') {
    send({ id, result: [{ label: documents.get(params.textDocument.uri), detail: JSON.stringify(params.position) }] });
  }
  if (method === 'test/setNavigation') {
    navigationOverrides = params;
    send({ id, result: null });
    return;
  }
  if (method?.startsWith('textDocument/')) {
    const operation = method.substring('textDocument/'.length);
    if (Object.hasOwn(navigationOverrides, operation)) {
      const value = navigationOverrides[operation];
      send({ id, ...(value?.error ? { error: value.error } : { result: value }) });
      return;
    }
  }
  if (method === 'textDocument/documentSymbol') send({ id, result: [] });
  if (method === 'textDocument/definition') send({ id, result: null });
  if (method === 'textDocument/declaration') send({ id, result: {
    uri: params.textDocument.uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }
  } });
  if (method === 'textDocument/implementation') send({ id, result: [1, 2].map(line => ({
    targetUri: params.textDocument.uri,
    targetRange: { start: { line, character: 0 }, end: { line, character: 12 } },
    targetSelectionRange: { start: { line, character: 6 }, end: { line, character: 12 } }
  })) });
  if (method === 'java/classFileContents') {
    send({ id, result: `// decompiled ${params.uri}\npublic final class String {}` });
    return;
  }
  if (method === 'test/inspect') send({ id, result: { events, protocolErrors, replies, configResult } });
  if (method === 'test/echo') setTimeout(() => {
    replies.push(params.value);
    send({ id, result: params.value });
  }, params.delayMs);
  if (method === 'test/exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString());
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = boundary + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString());
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
"#;

fn fake_client() -> (Arc<LspClient>, Language) {
    let mut command = Command::new("node");
    command.arg("-e").arg(FAKE_SERVER);
    let language = Language {
        key: "fake".into(),
        language_id: "fake".into(),
        command: "node".into(),
        args: vec![],
        initialization_options: Value::Null,
        settings: json!({"test":{"enabled":true}}),
    };
    let client = spawn_test_client(command, std::env::temp_dir(), language.settings.clone());
    (client, language)
}

pub(super) fn spawn_test_client(mut command: Command, workspace: PathBuf, settings: Value) -> Arc<LspClient> {
    command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .expect("Node.js is required for helmcode tests");
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let registrations: Registrations = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let client = Arc::new(LspClient {
        stdin: stdin.clone(),
        child: Mutex::new(child),
        pending: pending.clone(),
        registrations: registrations.clone(),
        retired_paths: Mutex::new(HashSet::new()),
        next_id: AtomicU64::new(1),
        alive: alive.clone(),
        initialization: Mutex::new(None),
        documents: Mutex::new(HashMap::new()),
        targets: Mutex::new(HashSet::new()),
        virtual_targets: Mutex::new(HashSet::new()),
        workspace: workspace.clone(),
        created_at: Instant::now(),
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(message)) = read_message(&mut reader) {
            if std::env::var_os("HELMCODE_LSP_TEST_TRACE").is_some() {
                eprintln!("LSP test server: {message}");
            }
            route_message(
                &message,
                &pending,
                &stdin,
                &workspace,
                &settings,
                &registrations,
                |_| {},
            );
        }
        alive.store(false, Ordering::SeqCst);
        fail_pending(&pending, "fake language server closed");
    });
    client
}

fn inspect(client: &LspClient) -> Value {
    client
        .request("test/inspect", json!({}), Duration::from_secs(3))
        .unwrap()
}

#[test]
fn stdio_waits_for_initialization_and_answers_server_requests() {
    let (client, language) = fake_client();
    client.initialize(&language).unwrap();
    // Reusing a client must never send a second initialize request.
    client.initialize(&language).unwrap();
    let inspection = inspect(&client);
    assert_eq!(inspection["protocolErrors"], json!([]));
    assert_eq!(inspection["configResult"], json!([{"enabled":true}]));
    let events = inspection["events"].as_array().unwrap();
    let initializations: Vec<_> = events
        .iter()
        .filter(|message| message["method"] == "initialize")
        .collect();
    assert_eq!(initializations.len(), 1);
    assert_eq!(
        initializations[0].pointer("/params/capabilities/general/positionEncodings"),
        Some(&json!(["utf-16"]))
    );
    assert!(events
        .iter()
        .any(|message| message["method"] == "initialized"));
    assert!(events.iter().any(|message| {
        message["method"] == "workspace/didChangeConfiguration"
            && message["params"]["settings"] == language.settings
    }));
}

#[test]
fn stdio_correlates_responses_that_arrive_out_of_order() {
    let (client, language) = fake_client();
    client.initialize(&language).unwrap();
    let slow_client = client.clone();
    let slow = std::thread::spawn(move || {
        slow_client.request(
            "test/echo",
            json!({"value":"slow","delayMs":100}),
            Duration::from_secs(3),
        )
    });
    let fast = client
        .request(
            "test/echo",
            json!({"value":"fast","delayMs":0}),
            Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!(fast, "fast");
    assert_eq!(slow.join().unwrap().unwrap(), "slow");
    assert_eq!(inspect(&client)["replies"], json!(["fast", "slow"]));
    assert!(client.pending.lock().unwrap().is_empty());
}

#[test]
fn stdio_uses_unsaved_buffers_utf16_changes_and_document_lifecycle() {
    let (client, language) = fake_client();
    let path = client.workspace.join("helmcode-fake-unsaved.java");
    let document = DocumentClient {
        client: client.clone(),
        language,
        path: path.clone(),
    };
    document.sync("first\r\n🦀x").unwrap();
    document.sync("unsavedValue").unwrap();
    let completion = document.complete("unsavedValue", 0, 12, Some(".")).unwrap();
    assert_eq!(completion[0]["label"], "unsavedValue");
    assert_eq!(
        serde_json::from_str::<Value>(completion[0]["detail"].as_str().unwrap()).unwrap(),
        json!({"line":0,"character":12})
    );
    document.save("unsavedValue").unwrap();
    client.close(&path).unwrap();
    document.sync("reopened").unwrap();
    let inspection = inspect(&client);
    let events = inspection["events"].as_array().unwrap();
    let changes: Vec<_> = events
        .iter()
        .filter(|message| message["method"] == "textDocument/didChange")
        .collect();
    assert_eq!(
        changes.len(),
        1,
        "unchanged buffers must not increase the document version"
    );
    assert_eq!(changes[0]["params"]["textDocument"]["version"], 2);
    assert_eq!(
        changes[0].pointer("/params/contentChanges/0/range/end"),
        Some(&json!({"line":1,"character":3}))
    );
    assert_eq!(
        changes[0].pointer("/params/contentChanges/0/text"),
        Some(&json!("unsavedValue"))
    );
    assert!(events
        .iter()
        .any(|message| message["method"] == "textDocument/didSave"
            && message["params"]["text"] == "unsavedValue"));
    assert_eq!(
        events
            .iter()
            .filter(|message| message["method"] == "textDocument/didClose")
            .count(),
        1
    );
    let opens: Vec<_> = events
        .iter()
        .filter(|message| message["method"] == "textDocument/didOpen")
        .collect();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1]["params"]["textDocument"]["version"], 1);
    let completion_event = events
        .iter()
        .find(|message| message["method"] == "textDocument/completion")
        .unwrap();
    assert_eq!(
        completion_event["params"]["context"],
        json!({"triggerKind":2,"triggerCharacter":"."})
    );
}

#[test]
fn stdio_incremental_changes_reconstruct_unicode_and_line_endings() {
    let (client, language) = fake_client();
    let document = DocumentClient {
        client: client.clone(),
        language,
        path: client.workspace.join("helmcode-incremental.txt"),
    };
    let samples = [
        "", "first", "", "é suffix", "ê suffix", "n© suffix", "😀 alpha\r\nunchanged\r\nomega",
        "😀 alphab\r\nunchanged\r\nomega", "a\r\nb", "a\nb", "a\rb", "a\r\nb", "a\rb", "",
    ];
    for text in samples {
        document.sync(text).unwrap();
        let result = document.complete(text, 0, 0, None).unwrap();
        assert_eq!(result[0]["label"], text);
    }
    let changes = inspect(&client);
    let change = changes["events"].as_array().unwrap().iter().find(|message| {
        message["method"] == "textDocument/didChange"
            && message.pointer("/params/contentChanges/0/text") == Some(&json!("b"))
    }).expect("single-character edit should only transmit the inserted character");
    assert_eq!(change.pointer("/params/contentChanges/0/range"), Some(&json!({
        "start": {"line":0,"character":8}, "end": {"line":0,"character":8}
    })));
}

#[test]
fn incremental_edit_payload_stays_small_in_a_large_document() {
    let before = format!("{}\r\nlet value = 1;\r\n{}", "unchanged\r\n".repeat(20_000), "tail\r\n".repeat(20_000));
    let after = before.replacen("value = 1", "value = 12", 1);
    let change = incremental_change(&before, &after);
    assert_eq!(change["text"], "2");
    assert_eq!(change["range"], json!({
        "start": {"line":20_001,"character":13}, "end": {"line":20_001,"character":13}
    }));
    assert!(serde_json::to_vec(&change).unwrap().len() < 150);
    assert!(after.len() > 300_000);
}

#[test]
fn stdio_cancels_timed_out_requests_and_fails_pending_requests_on_exit() {
    let (client, language) = fake_client();
    client.initialize(&language).unwrap();
    let error = client
        .request("test/ignore", json!({}), Duration::from_millis(30))
        .unwrap_err();
    assert!(error.to_string().contains("Tempo di attesa scaduto"));
    assert!(client.pending.lock().unwrap().is_empty());
    let inspection = inspect(&client);
    assert!(inspection["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["method"] == "$/cancelRequest"));
    let error = client
        .request("test/exit", json!({}), Duration::from_secs(3))
        .unwrap_err();
    assert!(error.to_string().contains("fake language server closed"));
    assert!(!client.alive.load(Ordering::SeqCst));
    assert!(client.pending.lock().unwrap().is_empty());
    assert!(client.begin_request("test/echo", json!({})).is_err());
    assert!(client.pending.lock().unwrap().is_empty());
}

#[test]
fn shutdown_cannot_leave_concurrently_registered_requests_waiting() {
    let (client, _) = fake_client();
    // Hold registration at the pending-map lock, then reproduce the reader's
    // EOF sequence. next_id proves the requester has reached this point; the
    // previous code checked alive before that counter and inserted after EOF.
    let mut pending = client.pending.lock().unwrap();
    let next_id = client.next_id.load(Ordering::SeqCst);
    let requester = client.clone();
    let request = std::thread::spawn(move || requester.begin_request("test/ignore", json!({})));
    let deadline = Instant::now() + Duration::from_secs(5);
    while client.next_id.load(Ordering::SeqCst) == next_id {
        if Instant::now() >= deadline {
            drop(pending);
            panic!("request thread did not reach registration");
        }
        std::thread::yield_now();
    }
    client.alive.store(false, Ordering::SeqCst);
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err("transport closed".into()));
    }
    drop(pending);
    assert!(request.join().unwrap().is_err());
    assert!(client.pending.lock().unwrap().is_empty());
}

#[test]
fn stdio_navigates_to_declarations_and_multiple_implementations() {
    let (client, language) = fake_client();
    let path = client.workspace.join("helmcode-fake-symbol.java");
    let document = DocumentClient {
        client: client.clone(),
        language,
        path,
    };
    let declarations = document
        .navigate("unsaved declaration", 0, 3, "definition")
        .unwrap();
    assert_eq!(declarations.len(), 1);
    assert_eq!(declarations[0].path, "helmcode-fake-symbol.java");
    assert_eq!((declarations[0].line, declarations[0].column), (3, 5));
    let implementations = document
        .navigate("unsaved implementation", 1, 6, "implementation")
        .unwrap();
    assert_eq!(implementations.len(), 2);
    assert_eq!((implementations[0].line, implementations[0].column), (2, 7));
    assert_eq!((implementations[1].line, implementations[1].column), (3, 7));
    let inspection = inspect(&client);
    let events = inspection["events"].as_array().unwrap();
    let navigation_methods: Vec<_> = events
        .iter()
        .filter_map(|message| {
            let method = message["method"].as_str()?;
            [
                "textDocument/definition",
                "textDocument/declaration",
                "textDocument/implementation",
            ]
            .contains(&method)
            .then_some(method)
        })
        .collect();
    assert_eq!(
        navigation_methods,
        vec![
            "textDocument/definition",
            "textDocument/declaration",
            "textDocument/implementation"
        ]
    );
    assert_eq!(client.targets.lock().unwrap().len(), 1);
}

fn navigation_fixture() -> (Arc<LspClient>, DocumentClient) {
    let (client, language) = fake_client();
    client.initialize(&language).unwrap();
    let document = DocumentClient {
        client: client.clone(),
        language,
        path: client.workspace.join("helmcode-auto-navigation.java"),
    };
    (client, document)
}

fn set_navigation(client: &LspClient, responses: Value) {
    client
        .request("test/setNavigation", responses, Duration::from_secs(3))
        .unwrap();
}

fn test_location(path: &Path, line: u32, start: u32, end: u32) -> Value {
    json!({"uri":file_uri(path).unwrap(),"range":{"start":{"line":line,"character":start},"end":{"line":line,"character":end}}})
}

fn test_link(path: &Path, line: u32, start: u32, end: u32) -> Value {
    json!({"targetUri":file_uri(path).unwrap(),"targetRange":{"start":{"line":line,"character":0},"end":{"line":line+2,"character":0}},"targetSelectionRange":{"start":{"line":line,"character":start},"end":{"line":line,"character":end}}})
}

#[test]
fn auto_on_middle_of_declaration_identifier_returns_distinct_implementations() {
    let (client, document) = navigation_fixture();
    let self_link = test_link(&document.path, 1, 2, 8);
    let implementation = test_link(&document.path, 4, 2, 8);
    let other_path = document.path.with_file_name("another-implementation.java");
    set_navigation(
        &client,
        json!({
            "definition":[self_link.clone()],
            "declaration":self_link.clone(),
            "implementation":[self_link,implementation.clone(),implementation,test_location(&other_path,0,0,6)]
        }),
    );
    let targets = document.navigate("interface Contract {\n  action(value: string): void;\n}\nclass Concrete {\n  action(value: string) {}\n}\n",1,5,"auto").unwrap();
    assert_eq!(
        targets.len(),
        2,
        "self targets and duplicates must be removed: {targets:?}"
    );
    assert!(targets
        .iter()
        .any(|target| target.path == "helmcode-auto-navigation.java"
            && target.line == 5
            && target.column == 3));
    assert!(targets
        .iter()
        .any(|target| target.path == "another-implementation.java"));
    assert!(!targets
        .iter()
        .any(|target| target.line == 2 && target.path == "helmcode-auto-navigation.java"));
}

#[test]
fn auto_on_reference_goes_to_its_declaration_without_requesting_implementations() {
    let (client, document) = navigation_fixture();
    set_navigation(
        &client,
        json!({"definition":test_location(&document.path,0,6,13),"implementation":[test_location(&document.path,9,6,13)]}),
    );
    let targets = document
        .navigate(
            "class Greeter {}\nconst instance = new Greeter();",
            1,
            23,
            "auto",
        )
        .unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!((targets[0].line, targets[0].column), (1, 7));
    assert!(!inspect(&client)["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["method"] == "textDocument/implementation"));
}

fn broad_class_navigation(document: &DocumentClient) -> Value {
    let range = json!({"start":{"line":0,"character":0},"end":{"line":4,"character":1}});
    json!({
        "definition":{"uri":file_uri(&document.path).unwrap(),"range":range.clone()},
        "implementation":[test_location(&document.path,5,6,13)],
        "documentSymbol":[{"name":"Greeter","kind":5,"range":range,"selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":13}},"children":[]}]
    })
}

#[test]
fn auto_does_not_confuse_a_reference_inside_a_broad_class_range_with_its_declaration() {
    let (client, document) = navigation_fixture();
    set_navigation(&client, broad_class_navigation(&document));
    let targets = document.navigate("class Greeter {\n  method() {\n    const type: Greeter = new Greeter();\n  }\n}\nclass Derived {}",2,19,"auto").unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(
        targets[0].line, 1,
        "a body reference must reach the class declaration"
    );
    assert!(!inspect(&client)["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["method"] == "textDocument/implementation"));
}

#[test]
fn auto_resolves_a_broad_class_header_using_the_document_symbol_selection() {
    let (client, document) = navigation_fixture();
    set_navigation(&client, broad_class_navigation(&document));
    let targets = document.navigate("class Greeter {\n  method() {\n    const type: Greeter = new Greeter();\n  }\n}\nclass Derived {}",0,9,"auto").unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!((targets[0].line, targets[0].column), (6, 7));
    assert!(inspect(&client)["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["method"] == "textDocument/documentSymbol"));
}

#[test]
fn auto_resolves_a_method_signature_from_hierarchical_document_symbols() {
    let (client, document) = navigation_fixture();
    let method_range = json!({"start":{"line":1,"character":2},"end":{"line":3,"character":3}});
    set_navigation(
        &client,
        json!({
            "definition":{"uri":file_uri(&document.path).unwrap(),"range":method_range.clone()},
            "implementation":[test_location(&document.path,8,2,8)],
            "documentSymbol":[{"name":"Contract","kind":5,"range":{"start":{"line":0,"character":0},"end":{"line":4,"character":1}},"selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":14}},"children":[{"name":"action","kind":6,"range":method_range,"selectionRange":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}}]}]
        }),
    );
    let targets = document.navigate("class Contract {\n  action() {\n    run();\n  }\n}\n\n\nclass Derived {\n  action() {}\n}",1,5,"auto").unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!((targets[0].line, targets[0].column), (9, 3));
}

#[test]
fn auto_handles_unsupported_methods_and_never_returns_a_noop_jump() {
    let (client, document) = navigation_fixture();
    let unsupported = json!({"error":{"code":-32601,"message":"Method not supported"}});
    let self_location = test_location(&document.path, 0, 6, 13);
    set_navigation(
        &client,
        json!({"definition":unsupported.clone(),"declaration":self_location,"implementation":unsupported}),
    );
    let targets = document.navigate("class Greeter {}", 0, 9, "auto").unwrap();
    assert!(
        targets.is_empty(),
        "an unavailable implementation must not jump back to the same declaration"
    );
    let alternate = document.path.with_file_name("interface.java");
    set_navigation(
        &client,
        json!({"definition":test_location(&document.path,0,6,13),"implementation":null,"declaration":test_location(&alternate,2,4,11)}),
    );
    let targets = document.navigate("class Greeter {}", 0, 9, "auto").unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].path, "interface.java");
}

#[test]
fn auto_falls_back_to_implementation_when_definition_and_declaration_are_unsupported() {
    let (client, document) = navigation_fixture();
    let unsupported = json!({"error":{"code":-32601,"message":"Method not supported"}});
    let implementation_path = document.path.with_file_name("concrete.java");
    set_navigation(
        &client,
        json!({"definition":unsupported.clone(),"declaration":unsupported,"implementation":[test_location(&implementation_path,4,2,8)]}),
    );
    let targets = document
        .navigate("interface Contract { action(); }", 0, 24, "auto")
        .unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].path, "concrete.java");
    assert_eq!((targets[0].line, targets[0].column), (5, 3));
}

#[test]
fn auto_navigates_to_jdt_virtual_class_files_and_reads_contents() {
    let (client, document) = navigation_fixture();
    let jdt_uri = "jdt://contents/java.base/java.lang/String.class?=app/jrt-fs.jar";
    set_navigation(
        &client,
        json!({"definition":{"uri":jdt_uri,"range":{"start":{"line":42,"character":18},"end":{"line":42,"character":24}}}}),
    );
    let targets = document.navigate("String value;", 0, 3, "auto").unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].path, jdt_uri);
    assert_eq!((targets[0].line, targets[0].column), (43, 19));
    assert!(targets[0].external);
    assert!(client.virtual_targets.lock().unwrap().contains(jdt_uri));
    let mut manager = LspManager::new();
    manager.clients.insert("java:test".into(), client.clone());
    let contents = manager.virtual_target(jdt_uri).unwrap().read(jdt_uri).unwrap();
    assert!(contents.contains("public final class String"));
    assert!(manager
        .virtual_target("jdt://contents/java.base/java.lang/Unauthorized.class")
        .is_err());
}

#[test]
fn auto_preserves_the_error_for_virtual_only_destinations() {
    let (client, document) = navigation_fixture();
    set_navigation(
        &client,
        json!({"definition":{"uri":"zip://archive/java.lang/String.class","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}}}}),
    );
    let error = document
        .navigate("String value;", 0, 3, "auto")
        .unwrap_err();
    assert!(
        error.to_string().contains("virtuale"),
        "virtual destination errors should reach the editor: {error:#}"
    );
}

#[test]
fn auto_recursive_method_reference_goes_to_the_signature_inside_a_broad_method_range() {
    let (client, document) = navigation_fixture();
    let method_range = json!({"start":{"line":1,"character":2},"end":{"line":3,"character":3}});
    set_navigation(
        &client,
        json!({
            "definition":{"uri":file_uri(&document.path).unwrap(),"range":method_range.clone()},
            "implementation":[test_location(&document.path,8,2,8)],
            "documentSymbol":[{"name":"Counter","kind":5,"range":{"start":{"line":0,"character":0},"end":{"line":4,"character":1}},"selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":13}},"children":[{"name":"action","kind":6,"range":method_range,"selectionRange":{"start":{"line":1,"character":2},"end":{"line":1,"character":8}}}]}]
        }),
    );
    let targets = document
        .navigate(
            "class Counter {\n  action() {\n    this.action();\n  }\n}",
            2,
            12,
            "auto",
        )
        .unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(
        targets[0].line, 2,
        "recursive calls must reach the method signature"
    );
    assert!(!inspect(&client)["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["method"] == "textDocument/implementation"));
}

#[test]
fn concurrent_completions_each_use_their_own_unsaved_snapshot() {
    let (client, language) = fake_client();
    client.initialize(&language).unwrap();
    let path = client.workspace.join("helmcode-concurrent-snapshot.java");
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let workers: Vec<_> = (0..16)
        .map(|worker| {
            let client = client.clone();
            let language = language.clone();
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let document = DocumentClient {
                    client,
                    language,
                    path,
                };
                barrier.wait();
                for request in 0..12 {
                    let snapshot = format!("worker_{worker}_snapshot_{request}");
                    let completion = document
                        .complete(&snapshot, 0, snapshot.len() as u32, None)
                        .unwrap();
                    assert_eq!(
                        completion[0]["label"], snapshot,
                        "a concurrent sync replaced this request's unsaved buffer"
                    );
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert!(client.pending.lock().unwrap().is_empty());
}

struct TestWorkspace(PathBuf);

impl TestWorkspace {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("helmcode-lsp-typescript-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(dunce::canonicalize(path).unwrap())
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn installed_typescript_server_completes_and_navigates_unsaved_project_files() {
    let cli_relative = "node_modules/typescript-language-server/lib/cli.mjs";
    let test_source = Path::new(env!("CARGO_MANIFEST_DIR")).join(file!());
    let repository = [
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf(),
        std::env::current_dir().unwrap(),
    ]
    .into_iter()
    .chain(test_source.ancestors().map(Path::to_path_buf))
    .find(|path| path.join(cli_relative).is_file())
    .expect("Run npm install before the language-server integration tests");
    let workspace = TestWorkspace::new();
    std::fs::write(workspace.0.join("tsconfig.json"), r#"{"compilerOptions":{"strict":true,"target":"ES2022","module":"commonjs"},"include":["*.ts"]}"#).unwrap();
    let definitions_path = workspace.0.join("definitions.ts");
    let main_path = workspace.0.join("main.ts");
    std::fs::write(
        &definitions_path,
        "export class Greeter { diskMethod() {} }\n",
    )
    .unwrap();
    std::fs::write(&main_path, "export const diskOnly = 1;\n").unwrap();
    let language = Language {
        key: "typescript".into(),
        language_id: "typescript".into(),
        command: "node".into(),
        args: vec![],
        initialization_options: json!({"tsserver":{"path":dunce::canonicalize(repository.join("node_modules/typescript/lib/tsserver.js")).unwrap()}}),
        settings: json!({}),
    };
    let mut command = Command::new("node");
    command.arg(repository.join(cli_relative)).arg("--stdio");
    let client = spawn_test_client(command, workspace.0.clone(), language.settings.clone());
    let definitions = DocumentClient {
        client: client.clone(),
        language: language.clone(),
        path: definitions_path.clone(),
    };
    let definitions_text =
        "export class Greeter {\n  greetUnsaved(name: string): string { return name; }\n}\nexport interface GreeterContract {\n  greetUnsaved(name: string): string;\n}\nexport class ContractGreeter implements GreeterContract {\n  greetUnsaved(name: string): string { return name; }\n}\n";
    definitions.sync(definitions_text).unwrap();
    let main = DocumentClient {
        client: client.clone(),
        language,
        path: main_path.clone(),
    };
    let completion_text =
        "import { Greeter } from './definitions';\nconst greeter = new Greeter();\ngreeter.";
    // A cold project initially serves syntax-only completions while tsserver
    // loads its semantic project. Concurrent filesystem/process integration
    // tests can delay that startup on Windows, so allow a bounded warm-up.
    // Keep checking the exact unsaved method: an empty or disk-only response
    // must still fail rather than being accepted as a ready server.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(30);
    let mut attempts = 0;
    let completion = loop {
        attempts += 1;
        let completion = main.complete(completion_text, 2, 8, Some(".")).unwrap();
        let ready = completion
            .as_array()
            .or_else(|| completion.get("items").and_then(Value::as_array))
            .is_some_and(|items| items.iter().any(|item| item["label"] == "greetUnsaved"));
        if ready || Instant::now() >= deadline {
            break completion;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let items = completion
        .as_array()
        .or_else(|| completion.get("items").and_then(Value::as_array))
        .expect("TypeScript should return member completions");
    assert!(
        items.iter().any(|item| item["label"] == "greetUnsaved"),
        "completion must use the imported class's unsaved buffer after {attempts} attempts in {:?} (server alive: {}): {completion}",
        started.elapsed(),
        client.alive.load(Ordering::SeqCst)
    );
    assert!(!items.iter().any(|item| item["label"] == "diskMethod"));
    let navigation_text = format!("{completion_text}greetUnsaved('helmcode');\n");
    let targets = main.navigate(&navigation_text, 2, 11, "auto").unwrap();
    assert!(
        targets.iter().any(|target| target.path == "definitions.ts"
            && target.line == 2
            && target.column == 3),
        "definition should reach the unsaved method declaration: {:?}",
        targets
    );
    let implementations = definitions
        .navigate(definitions_text, 4, 7, "auto")
        .unwrap();
    assert!(
        implementations
            .iter()
            .any(|target| target.path == "definitions.ts"
                && target.line == 8
                && target.column == 3),
        "clicking an interface method should reach its implementation: {implementations:?}"
    );
    assert!(
        !implementations
            .iter()
            .any(|target| target.path == "definitions.ts" && target.line == 5),
        "auto navigation must not jump back to the interface signature"
    );
    assert_eq!(
        std::fs::read_to_string(&main_path).unwrap(),
        "export const diskOnly = 1;\n"
    );
    assert_eq!(
        std::fs::read_to_string(&definitions_path).unwrap(),
        "export class Greeter { diskMethod() {} }\n"
    );
}
