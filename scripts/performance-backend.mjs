// Run: node scripts/performance-backend.mjs [baseline-commit]
// Requires Git and rustc. Temporary sources and executables stay under .qa/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv[2] ?? "f935f70868db44131541cf9c2fb455ac55532901";
const command = (program, args, options = {}) => execFileSync(program, args, {
  cwd: root, encoding: "utf8", windowsHide: true, stdio: "pipe", ...options,
});

function rustBlock(source, start) {
  const index = source.indexOf(start);
  if (index < 0) throw new Error(`Rust source declaration missing: ${start}`);
  const opening = source.indexOf("{", index);
  let depth = 1, end = opening + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  if (depth) throw new Error(`Unbalanced Rust source: ${start}`);
  return source.slice(index, end);
}

const current = fs.readFileSync(path.join(root, "src-tauri/src/search.rs"), "utf8");
const previous = command("git", ["show", `${baseline}:src-tauri/src/search.rs`]);
console.log(`Baseline: ${baseline}`);
console.log(`Node: ${process.version}; ${command("rustc", ["--version"]).trim()}; ${command("git", ["--version"]).trim()}`);

const qa = path.join(root, ".qa");
fs.mkdirSync(qa, { recursive: true });
const temporary = fs.mkdtempSync(path.join(qa, "performance-backend-"));
const relative = path.relative(fs.realpathSync(root), fs.realpathSync(temporary));
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("Temporary benchmark directory must stay inside the workspace");
}

try {
  const source = [
    rustBlock(current, "struct SearchQuery"),
    rustBlock(current, "impl<'a> SearchQuery<'a>"),
    rustBlock(previous, "fn find_match(line: &str"),
    String.raw`
fn main() {
    use std::hint::black_box;
    let cases = [
        ("ascii_insensitive_absent", "export const configuration = { workspaceFolder: value, terminalFontSize: 14 }; ".repeat(4), "missing-symbol", false),
        ("ascii_insensitive_present", "export const configuration = { workspaceFolder: value, terminalFontSize: 14 }; ".repeat(4), "TERMINAL", false),
        ("ascii_sensitive_absent", "export const configuration = { workspaceFolder: value, terminalFontSize: 14 }; ".repeat(4), "missing-symbol", true),
        ("unicode_insensitive", "\u{1f600} export CAF\u{c9} value; ".repeat(12), "missing-symbol", false),
    ];
    for (label, line, query, sensitive) in cases {
        let prepared = SearchQuery::new(query, sensitive);
        assert_eq!(prepared.find_match(&line), find_match(&line, query, sensitive));
        let mut old_samples = Vec::new();
        let mut new_samples = Vec::new();
        for _ in 0..5 {
            let now = std::time::Instant::now();
            for _ in 0..100_000 {
                black_box(find_match(black_box(&line), black_box(query), sensitive));
            }
            old_samples.push(now.elapsed().as_secs_f64() * 1000.);
            let now = std::time::Instant::now();
            for _ in 0..100_000 {
                black_box(prepared.find_match(black_box(&line)));
            }
            new_samples.push(now.elapsed().as_secs_f64() * 1000.);
        }
        old_samples.sort_by(f64::total_cmp);
        new_samples.sort_by(f64::total_cmp);
        println!("{label}: baseline={:.2}ms current={:.2}ms speedup={:.2}x (median of 5; 100000 lines)",
            old_samples[2], new_samples[2], old_samples[2] / new_samples[2]);
    }
}
`,
  ].join("\n");
  const sourceFile = path.join(temporary, "search-benchmark.rs");
  const executable = path.join(temporary, process.platform === "win32" ? "search-benchmark.exe" : "search-benchmark");
  fs.writeFileSync(sourceFile, source);
  command("rustc", ["--edition=2021", "-O", sourceFile, "-o", executable]);
  console.log(command(executable, []));

  const oldCommands = [
    ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--show-prefix"],
    ["symbolic-ref", "--short", "-q", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
  ];
  const currentCommands = [
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    ["rev-parse", "--show-prefix", "--git-path", "MERGE_HEAD"],
  ];
  const hasUpstream = (() => {
    try { command("git", oldCommands[4]); return true; }
    catch { return false; }
  })();
  if (!hasUpstream) oldCommands.splice(5, 1);
  const samples = { baseline: [], current: [] };
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const [label, commands] of [["baseline", oldCommands], ["current", currentCommands]]) {
      const start = performance.now();
      for (const args of commands) {
        try { command("git", args); }
        catch { /* Missing MERGE_HEAD/upstream is a normal status condition. */ }
      }
      samples[label].push(performance.now() - start);
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[2];
  console.log(`git_status_commands: baseline=${median(samples.baseline).toFixed(2)}ms current=${median(samples.current).toFixed(2)}ms (${oldCommands.length} -> ${currentCommands.length} processes; median of 5)`);
  console.log("These are matcher and Git-command microbenchmarks, not complete application latency measurements.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
