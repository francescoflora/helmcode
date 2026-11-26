import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { history, undoDepth } from "@codemirror/commands";
import { highlightTree } from "@lezer/highlight";

// Exercise the actual parsers and shared theme without a desktop WebView.
async function importSource(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(["'])(@(?:codemirror|lezer)\/[^"']+)\1/g,
    (_match, _quote, name) => JSON.stringify(import.meta.resolve(name)));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { detectIndentUnit, getLanguageDescription, languageName } = await importSource("../src/lib/languages.ts");
const { helmcodeHighlight } = await importSource("../src/theme.ts");

async function highlighted(path, doc) {
  const description = getLanguageDescription(path);
  assert.ok(description, `${path} resolves a language`);
  const support = await description.load();
  const state = EditorState.create({ doc, extensions: [support] });
  const tree = ensureSyntaxTree(state, doc.length, 1000);
  assert.ok(tree, `${path} has a complete syntax tree`);
  const segments = [];
  highlightTree(tree, helmcodeHighlight, (from, to, style) => {
    segments.push({ text: doc.slice(from, to), style });
  });
  return { state, tree, segments };
}

test("recognizes language filenames, Windows paths and upper-case extensions", () => {
  const examples = {
    "index.HTML": "HTML", "app.CSS": "CSS", "theme.scss": "SCSS", "app.jsx": "JSX",
    "app.tsx": "TSX", "app.mts": "TypeScript", "script.cjs": "JavaScript",
    "C:\\project\\main.PY": "Python", "Cargo.toml": "TOML", "lib.rs": "Rust",
    "workflow.yaml": "YAML", "config.json": "JSON", "README.md": "Markdown",
    "Dockerfile.prod": "Dockerfile", "Containerfile": "Dockerfile", ".env.local": "Shell",
    ".zshrc": "Shell", ".editorconfig": "Properties files", "script.ps1": "PowerShell",
    "app.cs": "C#", "app.java": "Java", "app.go": "Go", "query.sql": "SQL",
    "jdt://contents/java.base/java.lang/String.class?=app/jrt-fs.jar": "Java",
  };
  for (const [path, expected] of Object.entries(examples)) assert.equal(languageName(path), expected, path);
  for (const name of ["tsconfig.json", "tsconfig.app.json", "settings.jsonc", "config.json5", ".eslintrc"]) {
    assert.equal(languageName(name), "JSON con commenti");
  }
  assert.equal(getLanguageDescription("notes.txt"), null);
  assert.equal(getLanguageDescription("unknown.zzz"), null);
});

test("detects the file indent unit so editors and guides match real nesting", () => {
  const rust = "pub struct AppState {\n    pub workspace: RwLock<PathBuf>,\n}\n";
  const typescript = "const app = {\n  mount() {\n    return 1;\n  },\n};\n";
  const tabbed = "fn main() {\n\tlet value = 1;\n}\n";
  assert.equal(detectIndentUnit(rust), "    ");
  assert.equal(detectIndentUnit(typescript), "  ");
  assert.equal(detectIndentUnit(tabbed), "\t");
  assert.equal(detectIndentUnit(""), "  ");
  assert.equal(detectIndentUnit("single line"), "  ");
});

test("HTML distinguishes tags, attributes and values, including CSS and JS inside it", async () => {
  const doc = '<main class="app">Hello</main><style>.app { color: red; width: 20px; }</style><script>const message = "hello"; console.log(message)</script>';
  const { segments } = await highlighted("index.html", doc);
  const styleFor = (text) => segments.find((segment) => segment.text === text)?.style;
  assert.ok(styleFor("main"), "HTML tag gets a style");
  assert.ok(styleFor("class"), "HTML attribute gets a style");
  assert.ok(styleFor('"app"'), "HTML value gets a style");
  assert.notEqual(styleFor("main"), styleFor("class"));
  assert.notEqual(styleFor("class"), styleFor('"app"'));
  assert.ok(styleFor("color"), "embedded CSS property gets a style");
  assert.ok(styleFor("const"), "embedded JS keyword gets a style");
  assert.notEqual(styleFor("const"), styleFor('"hello"'));
});

test("common programming and configuration files receive multiple semantic styles", async () => {
  const fixtures = {
    "main.py": 'def greet(name):\n    return "Hello " + name # comment\n',
    "style.scss": '$spacing: 12px;\n.card { padding: $spacing; color: red; }',
    "Cargo.toml": '[package]\nname = "demo"\nversion = "1.0"\n',
    "workflow.yaml": 'name: demo\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
    "settings.jsonc": '{\n // Editor setting\n "enabled": true,\n "count": 42,\n}',
    "App.tsx": 'const App = (name: string) => <main className="app">{name}</main>;',
    "main.rs": 'fn main() { let greeting = "hello"; println!("{}", greeting); }',
  };
  for (const [path, doc] of Object.entries(fixtures)) {
    const { segments } = await highlighted(path, doc);
    assert.ok(new Set(segments.map((segment) => segment.style)).size >= 2, `${path} has differentiated tokens`);
  }
});

test("Markdown styles prose and loads the language inside fenced code blocks", async () => {
  const { segments } = await highlighted("README.md", '# Title\n\n**Bold** and `code`\n\n```js\nconst message = "hello";\n```\n');
  // Markdown may schedule a nested parser load when first encountering a fence.
  await getLanguageDescription("sample.js").load();
  const loaded = await highlighted("README.md", '# Title\n\n**Bold** and `code`\n\n```js\nconst message = "hello";\n```\n');
  assert.ok(segments.length > 0);
  assert.ok(loaded.segments.some((segment) => segment.text === "const"));
});

test("installing a parser preserves edits, selection and undo history", async () => {
  const parser = new Compartment();
  let state = EditorState.create({ doc: '<main>initial</main>', extensions: [history(), parser.of([])] });
  state = state.update({
    changes: { from: 6, to: 13, insert: "edited" }, selection: { anchor: 9 },
    annotations: Transaction.userEvent.of("input"),
  }).state;
  const before = state.doc.toString();
  const selection = state.selection.main;
  assert.equal(undoDepth(state), 1);
  state = state.update({ effects: parser.reconfigure(await getLanguageDescription("index.html").load()) }).state;
  assert.equal(state.doc.toString(), before);
  assert.equal(state.selection.main.anchor, selection.anchor);
  assert.equal(undoDepth(state), 1);
  assert.ok(ensureSyntaxTree(state, state.doc.length, 1000));
});
