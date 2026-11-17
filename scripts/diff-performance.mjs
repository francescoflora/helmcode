import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const root = process.cwd();
const fixture = path.join(root, ".qa/diff-performance.tsx");
await mkdir(path.dirname(fixture), { recursive: true });
await writeFile(fixture, `
import React from "react";
import { createRoot } from "react-dom/client";
import { DiffTable } from "../src/components/DiffTable";
import "../src/styles.css";
const count = 10000;
const lines = Array.from({ length: count }, (_, i) => ({ kind: "context", text: "const line_" + i + " = " + i + ";", oldLine: i + 1, newLine: i + 1 }));
lines[2].text = "const wide = '" + "x".repeat(300) + "';";
lines.splice(7500, 1, { kind: "remove", text: "const before = 7500;", oldLine: 7501, newLine: null }, { kind: "add", text: "const after = 7500;", oldLine: null, newLine: 7501 });
const root = createRoot(document.getElementById("root"));
window.__renderDiff = (file = "large.ts", key = "first") => root.render(<DiffTable lines={lines} path={file} scrollKey={key} />);
window.__started = performance.now();
window.__renderDiff();
`);
await writeFile(path.join(root, ".qa/diff-performance.html"), '<!doctype html><style>html,body{margin:0}#root{display:flex;height:500px;width:800px}</style><div id="root"></div><script type="module" src="/.qa/diff-performance.tsx"></script>');

const server = await createServer({ cacheDir: ".qa/diff-vite", server: { port: 0, strictPort: false, open: false } });
await server.listen();
const port = server.httpServer.address().port;
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${path.join(root, ".qa/diff-performance-chrome")}`, "about:blank",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome startup timeout")), 20000);
    chrome.once("error", reject);
    chrome.stderr.on("data", data => {
      output += data;
      const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timeout); resolve(found[1]); }
    });
  });
  const pages = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let serial = 0;
  const requests = new Map();
  const errors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const task = requests.get(message.id);
    if (!task) return;
    requests.delete(message.id);
    clearTimeout(task.timeout);
    if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`Debugger timeout: ${method}`)); }, 30000);
    requests.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://localhost:${port}/.qa/diff-performance.html` });
  await until("!!document.querySelector('tr[data-index] td:last-child span[class]')", "syntax highlighted diff");
  const metrics = await evaluate(`(() => { const el = document.querySelector('.diff-scroll'); return { renderMs: Math.round(performance.now() - window.__started), rows: document.querySelectorAll('tr[data-index]').length, nodes: document.querySelectorAll('*').length, height: el.scrollHeight, width: el.scrollWidth, top: el.scrollTop }; })()`);
  console.log(JSON.stringify({ fileLines: 10000, ...metrics }));
  if (!process.argv.includes("--measure-only")) {
    assert.ok(metrics.rows < 150, `Only viewport rows should mount, got ${metrics.rows}`);
    assert.ok(Math.abs(metrics.height - 10001 * 24 - 24) <= 2, `Preserve full diff height, got ${metrics.height}`);
    await until("!!document.querySelector('tr[data-index=\"7500\"]')", "first change is visible");
    await evaluate("document.querySelector('.diff-scroll').scrollTop = 230000");
    await until("!!document.querySelector('tr[data-index=\"9600\"]')", "distant scroll updates rows");
    assert.equal(await evaluate("document.querySelector('.diff-scroll').scrollWidth"), metrics.width, "Horizontal width stays stable when the longest line leaves the viewport");
    await evaluate("window.__renderDiff('large.unknown')");
    await until("!document.querySelector('tr[data-index] td:last-child span[class]')", "unknown language clears previous syntax");
    await evaluate("window.__renderDiff('large.ts', 'second')");
    await until("!!document.querySelector('tr[data-index=\"7500\"]')", "new diff key reveals first change again");
    assert.deepEqual(errors, [], "No browser exceptions");
    console.log("Diff rendering, scroll, stable width, syntax invalidation and reveal checks passed.");
  }
} finally {
  socket?.close();
  chrome.kill();
  await server.close();
}
