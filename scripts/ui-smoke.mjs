import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const syntaxFixtures = {
  'index.html': '<!doctype html>\n<html lang="it">\n<head>\n<style>\n.card { color: #9bd6bd; padding: 12px; }\n</style>\n<script>\nconst greeting = "Hello";\nconsole.log(greeting);\n</script>\n</head>\n<body>\n<main class="workspace" data-count="3">Ciao</main>\n</body>\n</html>\n',
  'style.css': '.card { color: #9bd6bd; padding: 12px; }\n',
  'app.py': 'def greet(name):\n    return "Hello" + name\n\ngreet("helmcode")\n',
  'config.yaml': 'greeting: "Hello"\nretries: 3\nactive: true\n',
  'Cargo.toml': '[package]\nname = "helmcode"\nversion = "0.1.0"\n',
  'notes.unknown': 'A plain file has no programming language.\n',
  'Main.java': 'class Main {\n  void run() {\n    pri\n    greet();\n  }\n  void greet() {}\n}\n',
  'Implementations.java': 'class Implementations {\n  void greet() {}\n  void greetAgain() {}\n}\n',
  'MoveMe.java': 'class MoveMe {}\n',
  'UsesMoveMe.java': 'class UsesMoveMe { MoveMe value; }\n',
  'chain/java/main/One.java': 'class One {}\n',
  'chain/java/main/Two.java': 'class Two {}\n',
  'scroll-fixture.txt': Array.from({ length: 80 }, (_, index) => `line ${index + 1} ${'x'.repeat(200)}`).join('\n') + '\n',
};
let delayScriptResponses = 0;
await mkdir(path.join(root, '.qa'), { recursive: true });
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  try {
    const file = path.join(root, 'dist', name === '/' ? 'index.html' : name);
    if (!file.startsWith(path.join(root, 'dist'))) throw new Error('Invalid path');
    const body = await readFile(file);
    if (path.extname(file) === '.js' && delayScriptResponses) await new Promise(resolve => setTimeout(resolve, delayScriptResponses));
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${path.join(root, '.qa/chrome-profile')}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Chrome startup timeout')), 20000);
    chrome.on('error', reject);
    chrome.stderr.on('data', data => {
      output += data;
      const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timeout); resolve(found[1]); }
    });
  });
  const debugPort = new URL(endpoint).port;
  const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome debugger connection timeout')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Chrome debugger connection failed')); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timeout); reject(new Error('Chrome debugger connection closed')); }, { once: true });
  });
  let serial = 0;
  const requests = new Map();
  const errors = [];
  let interceptedDrag = null;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = requests.get(message.id);
      if (!task) return;
      requests.delete(message.id);
      clearTimeout(task.timeout);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Input.dragIntercepted') interceptedDrag = message.params.data;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`Chrome debugger timed out: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    await screenshot('failure.png');
    const debug = await evaluate(`({ active: document.querySelector('.file-tab-select[aria-selected="true"]')?.title, message: document.querySelector('.intelligence-message')?.textContent, targets: document.querySelector('.symbol-targets')?.textContent, navigation: (window.__qaCalls || []).filter(call => call.command === 'lsp_navigate').map(call => ({ kind: call.args.kind, path: call.args.path })), terminalTab: document.querySelector('.terminal-tab.is-active')?.textContent, renameDisabled: document.querySelector('button[aria-label="Rinomina terminale"]')?.disabled, renameInput: document.querySelector('input[aria-label="Nome terminale"]')?.value })`);
    console.error(JSON.stringify({ label, errors, debug }));
    throw new Error(`Timed out: ${label}`);
  };
  const clickText = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.offsetWidth && (b.textContent.trim() === ${JSON.stringify(text)} || (b.classList.contains('mode-button') && b.querySelector('span')?.textContent.trim() === ${JSON.stringify(text)})))?.click()`);
  const confirmProjectChange = async () => {
    await until(`document.querySelector('#confirm-title')?.textContent === 'Cambia progetto'`, 'Project switch confirmation');
    await clickText('Cambia progetto');
  };
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(root, '.qa', name), Buffer.from(result.data, 'base64'));
  };

  const dragFile = async (sourcePath, targetPath, hover = false) => {
    const point = async (path) => evaluate(`(() => {
      const node = document.querySelector('.tree-row[title=' + ${JSON.stringify(JSON.stringify(path))} + ']');
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width - 8, 70), y: rect.y + rect.height / 2 };
    })()`);
    const source = await point(sourcePath);
    const target = await point(targetPath);
    await evaluate(`window.__qaDragEvents = []; for (const type of ['mousedown', 'dragstart', 'dragend', 'dragover', 'drop']) document.addEventListener(type, event => { if (type !== 'dragover' || window.__qaDragEvents.length < 20) window.__qaDragEvents.push({ type, trusted: event.isTrusted, target: event.target.closest?.('.tree-row')?.title, x: event.clientX, y: event.clientY }); }, { capture: true });`);
    interceptedDrag = null;
    await send('Input.setInterceptDrags', { enabled: true });
    try {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...source });
      await pause(100);
      for (let step = 1; step <= 12; step++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: source.x + (target.x - source.x) * step / 12, y: source.y + (target.y - source.y) * step / 12 });
        await pause(20);
      }
      for (let attempt = 0; attempt < 50 && !interceptedDrag; attempt++) await pause(20);
      if (!interceptedDrag) { await screenshot('drag-failure.png'); console.error(JSON.stringify({ source, target, drag: await evaluate(`window.__qaDragEvents`) })); }
      assert.ok(interceptedDrag, 'A real mouse gesture starts the Explorer drag');
      assert.equal(await evaluate(`window.__qaDragEvents.find(event => event.type === 'dragstart')?.trusted`), true, 'Explorer receives a trusted drag gesture');
      const data = interceptedDrag;
      await send('Input.dispatchDragEvent', { type: 'dragEnter', ...target, data });
      await send('Input.dispatchDragEvent', { type: 'dragOver', ...target, data });
      if (hover) await until(`document.querySelector('.tree-row[title=${JSON.stringify(targetPath)}]')?.getAttribute('aria-expanded') === 'true'`, 'Hover opens the destination folder');
      await send('Input.dispatchDragEvent', { type: 'drop', ...target, data });
    } finally {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...target });
      await send('Input.setInterceptDrags', { enabled: false });
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 500, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      localStorage.clear(); localStorage.setItem('helmcode.mode', '"ide"');
      if (new URLSearchParams(location.search).has('agentMode')) localStorage.setItem('helmcode.mode', '"ai"');
      if (new URLSearchParams(location.search).has('noSplash')) localStorage.setItem('helmcode.start.splash', 'false');
      if (new URLSearchParams(location.search).has('splashEnabled')) localStorage.setItem('helmcode.start.splash', 'true');
      if (new URLSearchParams(location.search).has('lightTheme')) localStorage.setItem('helmcode.appearance.theme', '"light"');
      const callbacks = new Map(), listeners = new Map(); let nextId = 0;
      window.__qaCalls = []; window.__qaUnknown = [];
      window.__qaSplashSeen = false;
      window.__qaWindowSize = { width: 760, height: 500 };
      window.__qaResizes = [];
      let workspaceFrames = 0, projectsFrames = 0, paintedScreen = null;
      const sampleScreens = () => {
        const visible = selector => !!document.querySelector(selector)?.getBoundingClientRect().width;
        if (!visible('.splash-screen')) {
          if (visible('.app-frame')) { workspaceFrames++; paintedScreen = 'workspace'; }
          if (visible('.start-screen')) { projectsFrames++; paintedScreen = 'projects'; }
        }
        requestAnimationFrame(sampleScreens);
      };
      requestAnimationFrame(sampleScreens);
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches('.splash-screen') || node.querySelector('.splash-screen'))) window.__qaSplashSeen = true;
        }
      }).observe(document, { childList: true, subtree: true });
      window.__qaEmit = (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); };
      const files = { 'README.md': '# helmcode\\nA clean workspace.\\n', 'package.json': '{"name":"helmcode"}\\n', 'src/main.ts': 'export const greeting = "Hello, helmcode";\\nconsole.log(greeting);\\n' };
      Object.assign(files, ${JSON.stringify(syntaxFixtures)});
      const changes = [{ path: 'README.md', index: ' ', worktree: 'M', label: 'M', staged: false, untracked: false }, { path: 'package.json', index: 'M', worktree: ' ', label: 'M', staged: true, untracked: false }];
      let branch = 'main';
      const createdEntries = ['chain', 'chain/java', 'chain/java/main', 'drop-target'].map(path => ({ name: path.split('/').pop(), path, isDir: true, size: 0 }));
      createdEntries.push(...Object.keys(files).filter(path => path.startsWith('chain/')).map(path => ({ name: path.split('/').pop(), path, isDir: false, size: files[path].length })));
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: callback => { const id = ++nextId; callbacks.set(id, callback); return id; },
        unregisterCallback: id => callbacks.delete(id),
        invoke: async (command, args = {}) => {
          window.__qaCalls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++nextId; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:window|current_monitor') {
            const small = new URLSearchParams(location.search).has('smallMonitor');
            const size = small ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
            return { name: 'QA monitor', scaleFactor: small ? 1.25 : 1, position: { x: 0, y: 0 }, size, workArea: { position: { x: 0, y: 0 }, size } };
          }
          if (command === 'plugin:window|set_size') {
            const value = args.value.toJSON?.() ?? args.value;
            const size = value.Logical ?? value.Physical;
            window.__qaWindowSize = { width: size.width, height: size.height };
            window.__qaResizes.push({ ...window.__qaWindowSize, cause: 'size', workspaceFrames, projectsFrames, paintedScreen,
              splash: !!document.querySelector('.splash-screen'), background: window.__qaWebviewBackground });
            return;
          }
          if (command === 'plugin:window|set_min_size' && args.value) {
            const value = args.value.toJSON?.() ?? args.value;
            const minimum = value.Logical ?? value.Physical;
            if (minimum.width > window.__qaWindowSize.width || minimum.height > window.__qaWindowSize.height) {
              window.__qaWindowSize = { width: Math.max(minimum.width, window.__qaWindowSize.width), height: Math.max(minimum.height, window.__qaWindowSize.height) };
              window.__qaResizes.push({ ...window.__qaWindowSize, cause: 'minimum' });
            }
            return;
          }
          if (command === 'plugin:window|set_background_color') { window.__qaWindowBackground = args.value; return; }
          if (command === 'plugin:webview|set_webview_background_color') { window.__qaWebviewBackground = args.value; return; }
          if (command === 'plugin:window|show') {
            window.__qaThemeAtShow = document.documentElement.dataset.theme;
            window.__qaBackgroundAtShow = { window: window.__qaWindowBackground, webview: window.__qaWebviewBackground };
            return;
          }
          if (command.startsWith('plugin:window|')) return;
          if (command.startsWith('plugin:updater|')) return null;
          if (command === 'plugin:app|version') return '0.1.0';
          if (command === 'get_workspace') return new URLSearchParams(location.search).has('start') ? '' : 'C:/Projects/helmcode';
          if (command === 'open_workspace') return args.path;
          if (command === 'pick_folder') return 'C:/Projects';
          if (command === 'create_workspace') return 'C:/Projects/' + args.name;
          if (command === 'startup_empty_requested') {
            if (new URLSearchParams(location.search).has('newWindow')) {
              await new Promise(resolve => setTimeout(resolve, 450));
              return true;
            }
            return false;
          }
          if (command === 'list_directory') return args.path === '.' ? [
            { name: 'src', path: 'src', isDir: true, size: 0 },
            { name: '.github', path: '.github', isDir: true, size: 0 },
            { name: 'public', path: 'public', isDir: true, size: 0 },
            { name: 'scripts', path: 'scripts', isDir: true, size: 0 },
            { name: 'src-tauri', path: 'src-tauri', isDir: true, size: 0 },
            { name: 'README.md', path: 'README.md', isDir: false, size: 50 },
            { name: 'package.json', path: 'package.json', isDir: false, size: 30 },
            ...createdEntries.filter(entry => !entry.path.includes('/')),
            ...Object.keys(${JSON.stringify(syntaxFixtures)}).filter(name => !name.includes('/') && Object.hasOwn(files, name)).map(name => ({ name, path: name, isDir: false, size: files[name].length }))
          ] : [...(args.path === 'src' ? [{ name: 'main.ts', path: 'src/main.ts', isDir: false, size: 80 }] : []), ...createdEntries.filter(entry => entry.path.split('/').slice(0, -1).join('/') === args.path)];
          if (command === 'create_entry') {
            const path = args.parent === '.' ? args.name : args.parent + '/' + args.name;
            if (Object.hasOwn(files, path) || createdEntries.some(entry => entry.path === path)) throw new Error('Esiste già un elemento con questo nome');
            const entry = { name: args.name, path, isDir: args.isDir, size: 0 };
            createdEntries.push(entry);
            if (!args.isDir) files[path] = '';
            return entry;
          }
          if (command === 'mutate_entries') {
            if (window.__qaMutationDelay) await new Promise(resolve => setTimeout(resolve, window.__qaMutationDelay));
            const contains = (parent, path) => path === parent || path.startsWith(parent + '/');
            const moves = [], deleted = [], replacements = [];
            for (const operation of args.operations) {
              if (operation.kind === 'move') {
                if (Object.hasOwn(files, operation.newPath) || createdEntries.some(entry => entry.path === operation.newPath)) throw new Error('La destinazione esiste già');
                const isDir = createdEntries.some(entry => entry.path === operation.path && entry.isDir);
                const snapshot = args.documents.find(document => document.path === operation.path);
                if (!isDir && snapshot && snapshot.savedText !== files[operation.path]) throw new Error('Il file è cambiato sul disco prima dello spostamento');
                moves.push({ oldPath: operation.path, newPath: operation.newPath, isDir });
                if (!isDir && operation.path.endsWith('.java') && operation.newPath.endsWith('.java')) {
                  const oldName = operation.path.split('/').pop().slice(0, -5), newName = operation.newPath.split('/').pop().slice(0, -5);
                  if (oldName !== newName) replacements.push([oldName, newName]);
                }
              } else deleted.push(operation.path);
            }
            const mapPath = path => { const move = moves.find(move => move.isDir ? contains(move.oldPath, path) : move.oldPath === path); return move ? move.newPath + path.slice(move.oldPath.length) : path; };
            const replace = text => replacements.reduce((text, [oldName, newName]) => text.split(oldName).join(newName), text);
            const documents = [];
            const snapshots = new Map(args.documents.map(document => [document.path, document]));
            for (const [path, text] of Object.entries({ ...files })) {
              delete files[path];
              if (deleted.some(parent => contains(parent, path))) continue;
              const newPath = mapPath(path), snapshot = snapshots.get(path);
              const content = replace(snapshot?.text ?? text);
              files[newPath] = snapshot && snapshot.text !== snapshot.savedText ? text : content;
              if (snapshot && (newPath !== path || content !== snapshot.text)) documents.push({ path: newPath, content, savedContent: files[newPath] });
            }
            for (let index = createdEntries.length - 1; index >= 0; index--) {
              const entry = createdEntries[index];
              if (deleted.some(parent => contains(parent, entry.path))) createdEntries.splice(index, 1);
              else { entry.path = mapPath(entry.path); entry.name = entry.path.split('/').pop(); }
            }
            for (const move of moves) if (!createdEntries.some(entry => entry.path === move.newPath)) createdEntries.push({ name: move.newPath.split('/').pop(), path: move.newPath, isDir: move.isDir, size: 0 });
            return { moves, deleted, documents, warnings: [], referencesUpdated: replacements.length > 0 };
          }
          if (command === 'read_file_text') { if (!(args.path in files)) throw new Error('File unavailable'); if (window.__qaReadFile) return window.__qaReadFile(args.path, files[args.path]); return files[args.path]; }
          if (command === 'save_file') { if (window.__qaPauseNextSave) { window.__qaPauseNextSave = false; await new Promise(resolve => { window.__qaFinishSave = resolve; }); } files[args.path] = args.content; if (args.path === 'notes.unknown' && typeof window.__qaReplaceText === 'string') window.__qaReplaceText = args.content; if (!changes.some(c => c.path === args.path)) changes.push({ path: args.path, index: ' ', worktree: 'M', label: 'M', staged: false, untracked: false }); if (!window.__qaHoldSaveEvents) setTimeout(() => window.__qaEmit('fs-changed', { paths: [args.path] }), 10); return; }
          if (command === 'git_fetch') {
            if (window.__qaHoldGitFetch) await new Promise(resolve => { window.__qaGitFetchWaits = window.__qaGitFetchWaits || []; window.__qaGitFetchWaits.push(resolve); });
            return { isRepo: true, branch, changes: changes.map(change => ({ ...change })), upstream: 'origin/' + branch, ahead: window.__qaAhead || 0, behind: window.__qaBehind || 0, merging: false };
          }
          if (command === 'git_status') {
            if (window.__qaHoldGitStatus) await new Promise(resolve => { window.__qaGitStatusWaits = window.__qaGitStatusWaits || []; window.__qaGitStatusWaits.push(resolve); });
            return { isRepo: true, branch, changes: changes.map(change => ({ ...change })), upstream: 'origin/' + branch, ahead: window.__qaAhead || 0, behind: window.__qaBehind || 0, merging: false };
          }
          if (command === 'git_branches') return [{ name: 'main', current: branch === 'main', remote: false, shortHash: 'aaaaaaa', author: 'Francesco Flora', date: '2026-11-12T10:30:00+01:00', subject: 'feat: grafo commit' }, { name: 'feature/clean-ui', current: branch === 'feature/clean-ui', remote: false, shortHash: 'bbbbbbb', author: 'Ada Lovelace', date: '2026-11-11T09:15:00+01:00', subject: 'fix: ramo feature' }, { name: 'origin/main', current: false, remote: true, shortHash: 'aaaaaaa', author: 'Francesco Flora', date: '2026-11-12T10:30:00+01:00', subject: 'feat: grafo commit' }];
          if (command === 'git_checkout') { branch = args.branch; return; }
          if (command === 'git_create_branch') {
            branch = args.name;
            if (!args.keepChanges) changes.splice(0, changes.length);
            return { isRepo: true, branch, changes: changes.map(change => ({ ...change })), upstream: 'origin/' + branch, ahead: 0, behind: 0, merging: false };
          }
          if (command === 'git_file_diff') {
            if (window.__qaLongDiff) {
              const lines = Array.from({ length: 200 }, (_, index) => index === 20
                ? { kind: 'add', text: 'added line ' + 'y'.repeat(200), oldLine: null, newLine: index + 1 }
                : { kind: 'context', text: 'line ' + (index + 1) + ' ' + 'x'.repeat(200), oldLine: index + 1, newLine: index + 1 });
              return { lines, added: 1, removed: 0, isNew: false };
            }
            return { lines: [{ kind: 'remove', text: 'export const greeting = "Hello";', oldLine: 1, newLine: null }, { kind: 'add', text: (args.content || 'Updated').split('\\n')[0], oldLine: null, newLine: 1 }], added: 1, removed: 1, isNew: false };
          }
          if (command === 'git_commit_files') return [{ path: 'src/App.tsx', oldPath: null, status: 'M' }, { path: 'src/components/GitHistory.tsx', oldPath: 'src/components/GitGraph.tsx', status: 'R' }];
          if (command === 'git_commit_file_diff') return { lines: [{ kind: 'context', text: 'const isOpen = expanded.has(entry.path);', oldLine: 327, newLine: 327 }, { kind: 'remove', text: 'const before = entry;', oldLine: 328, newLine: null }, { kind: 'add', text: 'const before = leaf;', oldLine: null, newLine: 328 }], added: 1, removed: 1, isNew: false };
          if (command === 'git_log') {
            if (window.__qaHoldGitLog) await new Promise(resolve => { window.__qaGitLogWaits = window.__qaGitLogWaits || []; window.__qaGitLogWaits.push(resolve); });
            const commit = (hash, shortHash, parents, author, email, date, subject, refs) => ({ hash, shortHash, parents, author, email, date, subject, refs });
            return {
              truncated: args.limit < 600,
              commits: [
                commit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaa', ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccccccccccc'], 'Francesco Flora', 'francesco@example.test', '2026-11-12T10:30:00+01:00', 'feat: grafo commit', ['HEAD -> main', 'origin/main', 'tag: v0.1.0']),
                commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bbbbbbb', ['cccccccccccccccccccccccccccccccccccccccc'], 'Ada Lovelace', 'ada@example.test', '2026-11-11T09:15:00+01:00', 'fix: ramo feature', ['feature/clean-ui']),
                commit('cccccccccccccccccccccccccccccccccccccccc', 'ccccccc', [], 'Grace Hopper', 'grace@example.test', '2026-11-10T08:00:00+01:00', 'chore: base', ['tag: v0.0.9']),
              ],
            };
          }
          if (command === 'task_run') { setTimeout(() => window.__qaEmit('task-event', { id: args.runId, kind: 'output', stream: 'stderr', text: 'src/main.ts(2,3): warning TS6133: Build warning fixture\\n' }), 50); setTimeout(() => window.__qaEmit('task-event', { id: args.runId, kind: 'finished', code: 0, cancelled: false }), 180); return; }
          if (command === 'task_stop') return;
          if (command === 'workspace_tasks') { const build = { id: 'npm:build', label: 'build', command: 'npm run build', group: 'npm', kind: 'build' }; const play = { id: 'npm:dev', label: 'dev', command: 'npm run dev', group: 'npm', kind: 'play' }; return { projectTypes: ['Node.js'], build, play, tasks: [build, play] }; }
          if (command === 'lsp_open_file') return;
          if (command === 'lsp_sync_file') return window.__qaMissingServer ? { language: 'Java', state: 'missing', server: 'jdtls', message: 'Installa jdtls e un JDK compatibile nel PATH.' } : { language: args.path.endsWith('.java') ? 'Java' : 'TypeScript', state: 'ready', server: 'fixture-lsp' };
          if (command === 'lsp_close_file' || command === 'lsp_save_file') return;
          if (command === 'lsp_completion') return args.path === 'Main.java' && !window.__qaMissingServer ? { isIncomplete: false, items: [{ label: 'println', kind: 2, detail: 'Java language server fixture', insertTextFormat: 2, insertText: 'System.out.println(' + '$' + '{1:message});' }] } : null;
          if (command === 'lsp_navigate') {
            if (window.__qaNavigationDelay) await new Promise(resolve => setTimeout(resolve, window.__qaNavigationDelay));
            if (window.__qaExternalTarget) return [{ path: 'C:/Libraries/External.java', line: 2, column: 3, external: true }];
            if (args.kind === 'implementation' || (args.kind === 'auto' && args.path === 'Main.java' && args.line === 5)) return [{ path: 'Implementations.java', line: 2, column: 3 }, { path: 'Implementations.java', line: 3, column: 3 }];
            if (args.kind === 'declaration') return [{ path: 'Main.java', line: 6, column: 8 }];
            return [{ path: 'Implementations.java', line: 2, column: 3 }];
          }
          if (command === 'lsp_read_target') { if (window.__qaReadDelay) await new Promise(resolve => setTimeout(resolve, window.__qaReadDelay)); return 'class External {\\n  void dependency() {}\\n}\\n'; }
          if (command === 'pty_create') {
            if (args.agent && window.__qaFailAgentStart) throw new Error('Agent startup failed');
            const output = !args.agent ? 'PS C:/Projects/helmcode> ' : window.__qaHoldAgentOutput ? '\\x1b[2J\\x1b[H\\r\\n  ' : '\\x1b[2J\\x1b[H\\r\\n  AGENT ready\\r\\n';
            setTimeout(() => window.__qaEmit('pty-data', { id: args.id, data: Array.from(new TextEncoder().encode(output)) }), 100);
            return;
          }
          if (command.startsWith('pty_')) return;
          if (window.__qaExtra) { const handled = window.__qaExtra(command, args); if (handled !== undefined) return handled; }
          window.__qaUnknown.push(command); throw new Error('Unmocked command: ' + command);
        }
      };
    })();
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await until(`document.querySelector('.brand-name')?.textContent === 'helmcode'`, 'app ready');
  await until(`!!document.querySelector('.splash-screen')`, 'Normal startup shows splash');
  assert.deepEqual(await evaluate(`(() => { const style = getComputedStyle(document.querySelector('.splash-screen')); return { filter: style.filter, backdrop: style.backdropFilter, transition: style.transitionDuration }; })()`), { filter: 'none', backdrop: 'none', transition: '0s' }, 'Normal splash has no blur or fade');
  await screenshot('splash.png');
  await until(`!document.querySelector('.splash-screen')`, 'Splash ends with a direct transition');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('.mode-button:last-child .change-badge')?.textContent.trim() === '2'`, 'Git count');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.mode-button > span:first-of-type'), span => span.textContent.trim())`), ['AGENT', 'HELM']);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.titlebar .brand-name > span'), span => span.textContent)`), ['helm', 'code']);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.titlebar .brand-helm')).color !== getComputedStyle(document.querySelector('.titlebar .brand-code')).color`), true, 'Two-color wordmark');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await pause(100);
  assert.equal(await evaluate(`(() => {
    const brand = document.querySelector('.titlebar > div:first-child').getBoundingClientRect();
    const switcher = document.querySelector('.mode-switch').getBoundingClientRect();
    const controls = document.querySelector('.titlebar > div:last-child').getBoundingClientRect();
    return brand.right <= switcher.left && switcher.right <= controls.left;
  })()`), true, 'Title bar has no overlap at minimum desktop width');
  await screenshot('helmcode-1100.png');
  const checkCaption = async selector => {
    const dimensions = await evaluate(`(() => {
      const header = document.querySelector(${JSON.stringify(selector)});
      const close = header.querySelector('.window-close');
      const h = header.getBoundingClientRect(), b = close.getBoundingClientRect();
      return { headerTop: h.top, headerBottom: h.bottom, closeTop: b.top, closeBottom: b.bottom, width: b.width, height: b.height };
    })()`);
    assert.ok(Math.abs(dimensions.closeTop - dimensions.headerTop) <= 1, 'Close hover reaches top edge');
    assert.ok(Math.abs(dimensions.closeBottom - dimensions.headerBottom) <= 1, 'Close hover reaches bottom edge');
    assert.equal(dimensions.width, 46, 'Native caption target width');
    assert.ok(dimensions.height >= 50, 'Full-height caption target');
  };
  await checkCaption('.titlebar');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.activity-button svg')).width`), '22px', 'Readable activity icons');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.tree-row')).fontSize`), '13px', 'Readable file list');
  await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
  await until(`!!document.querySelector('.project-menu')`, 'project menu');
  await evaluate(`document.querySelector('.project-menu-all').click()`);
  await until(`!!document.querySelector('.start-screen')`, 'projects screen');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 500, deviceScaleFactor: 1, mobile: false });
  await checkCaption('.start-header');
  await screenshot('projects-760.png');
  await until(`window.__qaCalls.some(c => c.command === 'git_fetch' && c.args.expectedWorkspace === 'C:/Projects/helmcode')`, 'Project startup fetches remote updates');
  const opensBeforeDirect = await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`);
  await evaluate(`document.querySelector('.recent-row button').click()`);
  await confirmProjectChange();
  await until(`!document.querySelector('.start-screen')`, 'recent opens directly from the Projects screen');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`), opensBeforeDirect + 1, 'Recent project opens in the current window');
  const fetchesBeforeReopen = await evaluate(`window.__qaCalls.filter(c => c.command === 'git_fetch').length`);
  await evaluate(`window.__qaEmit('workspace-changed', 'C:/Projects/helmcode')`);
  await until(`window.__qaCalls.filter(c => c.command === 'git_fetch').length > ${fetchesBeforeReopen}`, 'Reopening the same project fetches remote updates again');
  assert.equal(await evaluate(`!document.querySelector('.window-choice')`), true, 'No window choice on the Projects screen');
  await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
  await until(`!!document.querySelector('.project-menu')`, 'project menu after direct open');
  await evaluate(`document.querySelector('.project-menu-all').click()`);
  await until(`!!document.querySelector('.start-screen')`, 'projects screen after direct open');
  const opensBeforeFolder = await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`);
  await evaluate(`document.querySelector('.start-action-primary').click()`);
  await confirmProjectChange();
  await until(`!document.querySelector('.start-screen')`, 'folder opens directly from the Projects screen');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`), opensBeforeFolder + 1, 'Projects folder picker applies the workspace immediately');
  assert.equal(await evaluate(`!document.querySelector('.window-choice')`), true, 'No window choice for the folder picker on the Projects screen');
  await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
  await until(`!!document.querySelector('.project-menu')`, 'project menu inside the editor');
  const opensInsideEditor = await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`);
  await evaluate(`document.querySelector('.project-menu-recent').click()`);
  await until(`!!document.querySelector('.window-choice')`, 'recent asks for a window inside the editor');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`), opensInsideEditor, 'Editor waits for the window choice');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await until(`!document.querySelector('.window-choice')`, 'editor window choice closed');
  const opensBeforeEditorFolder = await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`);
  await evaluate(`document.querySelector('.workspace-picker').click()`);
  await until(`!!document.querySelector('.window-choice')`, 'folder picker asks for a window inside the editor');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'open_workspace').length`), opensBeforeEditorFolder, 'Editor folder choice waits for the window choice');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await until(`!document.querySelector('.window-choice')`, 'editor folder window choice closed');
  await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
  await until(`!!document.querySelector('.project-menu')`, 'project menu before resizing recents');
  await evaluate(`document.querySelector('.project-menu-all').click()`);
  await until(`!!document.querySelector('.start-screen')`, 'projects screen before resizing recents');
  const recentsWidth = await evaluate(`Math.round(document.querySelector('.start-recents').getBoundingClientRect().width)`);
  const dragRecents = async (deltaX) => {
    await evaluate(`(() => {
      const handle = document.querySelector('.start-resizer');
      const x = handle.getBoundingClientRect().left + 3;
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x - ${deltaX} }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    })()`);
    await pause(60);
  };
  await dragRecents(40);
  assert.equal(await evaluate(`Math.round(document.querySelector('.start-recents').getBoundingClientRect().width)`), recentsWidth + 40, 'Recent projects panel can be resized');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('helmcode.start.recents.width'))`), recentsWidth + 40, 'Recent projects width is remembered');
  await dragRecents(-40);
  assert.equal(await evaluate(`Math.round(document.querySelector('.start-recents').getBoundingClientRect().width)`), recentsWidth, 'Recent projects panel returns to its width');
  while (await evaluate(`Boolean(document.querySelector('.recent-row .recent-remove'))`)) {
    await evaluate(`document.querySelector('.recent-row .recent-remove').click()`);
    await pause(40);
  }
  await until(`!!document.querySelector('.recents-empty')`, 'empty recent projects');
  await screenshot('projects-empty-760.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 460, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(`document.querySelector('.start-main').scrollWidth <= document.querySelector('.start-main').clientWidth`), true, 'No horizontal overflow at minimum start width');
  const closePosition = await evaluate(`(() => { const b = document.querySelector('.start-header .window-close').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...closePosition });
  await pause(180);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.start-header .window-close')).backgroundColor`), 'rgb(198, 66, 79)', 'Close hover color');
  await screenshot('projects-720-close-hover.png');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 300 });
  await evaluate(`document.querySelector('.start-header button[aria-label="Impostazioni"]').click()`);
  await until(`!!document.querySelector('.modal-card')`, 'settings modal');
  assert.equal(await evaluate(`document.querySelector('.modal-card').textContent.includes('Mostra la splash screen')`), true, 'Splash preference is available');
  assert.equal(await evaluate(`(() => { const b = document.querySelector('.modal-card').getBoundingClientRect(); return b.top >= 16 && b.bottom <= innerHeight - 16; })()`), true, 'Settings fit minimum start height');
  await screenshot('settings-720.png');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await evaluate(`document.querySelector('.projects-back').click()`);
  await until(`!document.querySelector('.start-screen')`, 'return to HELM');
  await send('Emulation.setDeviceMetricsOverride', { width: 1488, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('button[title="src"]')?.click()`);
  await until(`!!document.querySelector('button[title="src/main.ts"]')`, 'expand folder');
  await evaluate(`document.querySelector('button[title="src/main.ts"]')?.click()`);
  await until(`!!document.querySelector('.cm-content')`, 'open editor');
  const firstLineBeforeTab = await evaluate(`document.querySelector('.cm-line').textContent`);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await until(`document.querySelector('.cm-line').textContent !== ${JSON.stringify(firstLineBeforeTab)}`, 'Tab indents editor line');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.cm-content')`), true, 'Tab keeps focus in editor');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
  await until(`document.querySelector('.cm-line').textContent === ${JSON.stringify(firstLineBeforeTab)}`, 'Shift Tab removes indentation');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.cm-content')`), true, 'Shift Tab keeps focus in editor');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  for (let index = 0; index < 7; index++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const midLineAfterTab = `${firstLineBeforeTab.slice(0, 7)}  ${firstLineBeforeTab.slice(7)}`;
  await until(`document.querySelector('.cm-line').textContent === ${JSON.stringify(midLineAfterTab)}`, 'Tab inserts indentation only at the cursor');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await until(`document.querySelector('.cm-line').textContent === ${JSON.stringify(firstLineBeforeTab)}`, 'Undo restores the cursor-only indentation');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  const greetingOffset = firstLineBeforeTab.indexOf("greeting");
  for (let index = 0; index < greetingOffset; index++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  }
  await until(`!!document.querySelector('.cm-selectionMatch-main') && document.querySelectorAll('.cm-selectionMatch').length >= 2`, 'Word under cursor highlights every occurrence');
  for (let index = 0; index < "greeting".length; index++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', modifiers: 8, windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', modifiers: 8, windowsVirtualKeyCode: 39 });
  }
  await until(`!!document.querySelector('.cm-selectionBackground')`, 'Selected text draws a stronger selection layer');
  assert.equal(await evaluate(`(() => {
    const selection = document.querySelector('.cm-selectionBackground');
    const occurrence = document.querySelector('.cm-selectionMatch');
    if (!selection || !occurrence) return false;
    const selectedColor = getComputedStyle(selection).backgroundColor;
    const occurrenceColor = getComputedStyle(occurrence).backgroundColor;
    return selectedColor !== 'rgba(0, 0, 0, 0)' && selectedColor !== occurrenceColor;
  })()`), true, 'Selection is more visible than other occurrences');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await screenshot('helm.png');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  const autosavesBefore = await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').length`);
  await send('Input.insertText', { text: '// local edit\n' });
  await until(`document.querySelector('.mode-button:last-child .change-badge')?.textContent.trim() === '3'`, 'commit-worthy change count');
  assert.equal(await evaluate(`document.querySelector('.activity-badge').textContent.trim()`), '3');
  await until(`window.__qaCalls.filter(call => call.command === 'save_file').length > ${autosavesBefore} && !!document.querySelector('.file-tab .change-dot.change-modified')`, 'autosave writes edits without an explicit save');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').at(-1).args.content.includes('// local edit')`), true, 'Autosave stores the latest editor text');
  await until(`!!document.querySelector('.tree-row[title="src"] .change-dot.change-modified') && !!document.querySelector('.tree-row[title="src/main.ts"] .change-dot.change-modified')`, 'Explorer marks modified files and folders');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await until(`document.querySelectorAll('.branch-picker-item').length === 3`, 'branch menu after autosave');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await evaluate(`window.__qaHoldAgentOutput = true`);
  await clickText('AGENT');
  await until(`getComputedStyle(document.querySelector('.ai-workspace')).display !== 'none'`, 'AGENT view');
  await until(`window.__qaCalls.some(c => c.command === 'pty_create') && !!document.querySelector('.terminal-session')`, 'AGENT process created');
  await pause(250);
  assert.equal(await evaluate(`document.querySelector('.terminal-session').getAttribute('aria-busy')`), 'true', 'ANSI setup and whitespace do not dismiss loading');
  assert.equal(await evaluate(`!!document.querySelector('.agent-loading')`), true, 'Loader persists while opencode has no visible output');
  await screenshot('agent-loading.png');
  await evaluate(`window.__qaEmit('pty-data', { id: 'another-session', data: Array.from(new TextEncoder().encode('Other output')) })`);
  assert.equal(await evaluate(`!!document.querySelector('.agent-loading')`), true, 'Unrelated session output does not dismiss loading');
  await clickText('HELM');
  await clickText('AGENT');
  assert.equal(await evaluate(`!!document.querySelector('.agent-loading')`), true, 'Loading survives switching away and back');
  await evaluate(`window.__qaEmit('pty-data', { id: window.__qaCalls.find(c => c.command === 'pty_create').args.id, data: Array.from(new TextEncoder().encode('AGENT ready\\r\\n')) })`);
  await until(`document.querySelector('.terminal-session')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.agent-loading')`, 'AGENT visible output ready');
  assert.equal(await evaluate(`document.querySelectorAll('.ai-workspace aside').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[title="Ridimensiona terminale"]').length`), 0);
  assert.equal(await evaluate(`(() => { const el = document.querySelector('.terminal-session .xterm-helper-textarea'); const down = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }); el.dispatchEvent(down); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true })); return down.defaultPrevented; })()`), false, 'Ctrl+V is left to the native paste handler');
  await screenshot('agent.png');
  await clickText('HELM');
  await clickText('AGENT');
  assert.equal(await evaluate(`!!document.querySelector('.agent-loading')`), false, 'Ready session does not show loading again');
  await clickText('HELM');
  await until(`document.querySelector('.cm-content')?.offsetWidth > 0 && document.querySelector('.mode-button:last-child .change-badge')?.textContent.trim() === '3'`, 'preserved editor');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  const savesBefore = await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').length`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await until(`window.__qaCalls.filter(call => call.command === 'save_file').length > ${savesBefore}`, 'save file');
  await pause(400);
  assert.equal(await evaluate(`document.querySelector('.mode-button:last-child .change-badge').textContent.trim()`), '3');
  await evaluate(`document.querySelector('.diff-toggle').click()`);
  await until(`document.querySelector('.git-diff table')?.textContent.includes('Hello')`, 'current file diff');
  await screenshot('diff.png');
  await evaluate(`document.querySelector('button[title="Chiudi differenze"]').click()`);
  await evaluate(`window.__qaLongDiff = true`);
  await evaluate(`Array.from(document.querySelectorAll('.tree-row')).find(row => row.title === 'scroll-fixture.txt').click()`);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'scroll-fixture.txt'`, 'Scroll fixture opened');
  await evaluate(`document.querySelector('.diff-toggle').click()`);
  await until(`document.querySelector('.git-diff table')?.textContent.includes('added line')`, 'Long diff ready');
  await until(`!!document.querySelector('.diff-readonly')`, 'Diff is marked read-only');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.editor-document')).display`), 'none', 'Diff hides the editor');
  assert.equal(await evaluate(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title.includes('Diff (sola lettura)')`), true, 'Active tab marks the diff as read-only');
  await evaluate(`document.querySelector('button[title="Chiudi differenze"]').click(); window.__qaLongDiff = false`);
  await evaluate(`Array.from(document.querySelectorAll('.tree-row')).find(row => row.title === 'src/main.ts').click()`);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'src/main.ts'`, 'Original file restored after scroll sync');
  await evaluate(`document.querySelector('.activity-button[aria-label^="Git e branch"]').click(); document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await until(`document.querySelectorAll('.branch-picker-item').length === 3`, 'branch list');
  await evaluate(`Array.from(document.querySelectorAll('.branch-picker-item')).find(button => button.textContent.includes('feature/clean-ui')).click()`);
  await until(`document.querySelector('.statusbar').textContent.includes('feature/clean-ui')`, 'branch checkout');
  await screenshot('git.png');
  await until(`document.querySelector('.git-history')?.textContent.includes('feat: grafo commit')`, 'Git commit graph opens by default');
  assert.equal(await evaluate(`!document.querySelector('.editor-tabs')`), true, 'Git graph hides the editor tab bar');
  assert.equal(await evaluate(`document.querySelector('.git-history')?.textContent.includes('fix: ramo feature')`), true, 'Graph includes commits from every branch');
  assert.equal(await evaluate(`document.querySelector('.git-history')?.textContent.includes('Ada Lovelace') && document.querySelector('.git-history')?.textContent.includes('bbbbbbb') && document.querySelector('.git-history')?.textContent.includes('2026')`), true, 'Graph shows author, id and date');
  assert.equal(await evaluate(`document.querySelector('.git-ref.is-head')?.textContent === 'main' && document.querySelector('.git-ref.is-tag')?.textContent === 'v0.1.0'`), true, 'Graph shows branch and tag references');
  assert.equal(await evaluate(`document.querySelectorAll('.git-history-table-header [role="columnheader"]').length === 5 && Array.from(document.querySelectorAll('.git-history-table-header [role="columnheader"]')).map(cell => cell.textContent).join('|') === 'Grafo|Descrizione|Data|Autore|Commit'`), true, 'Graph uses table columns');
  assert.equal(await evaluate(`document.querySelectorAll('.git-history-table-header .git-col-resizer').length === 5`), true, 'Graph columns expose resize handles');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.git-history-table-header [role="columnheader"]')).every(cell => cell.getBoundingClientRect().width > 0)`), true, 'Graph columns have positive widths');
  const gitWidths = await evaluate(`Array.from(document.querySelectorAll('.git-history-table-header [role="columnheader"]')).map(cell => Math.round(cell.getBoundingClientRect().width))`);
  await evaluate(`document.querySelectorAll('.git-history-table-header .git-col-resizer')[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`);
  await pause(60);
  const gitWidthsAfterResize = await evaluate(`Array.from(document.querySelectorAll('.git-history-table-header [role="columnheader"]')).map(cell => Math.round(cell.getBoundingClientRect().width))`);
  assert.equal(gitWidthsAfterResize[2], gitWidths[2] + 16, 'Resizing a Git column changes only that column');
  assert.equal(gitWidthsAfterResize[3], gitWidths[3], 'Resizing a Git column leaves the next column unchanged');
  assert.equal(gitWidthsAfterResize[1], gitWidths[1], 'Resizing a Git column pins the flexible description width');
  assert.equal(await evaluate(`(() => { const cell = document.querySelector('.git-history-graph'); const svg = cell?.querySelector('svg'); return !!svg && svg.getBoundingClientRect().width <= cell.getBoundingClientRect().width + 1; })()`), true, 'Graph fits its column');
  assert.equal(await evaluate(`document.querySelectorAll('.git-history-graph svg').length === 3 && document.querySelectorAll('.git-history-graph circle').length === 3 && document.querySelectorAll('.git-history-graph path, .git-history-graph line').length > 3`), true, 'Graph renders SVG nodes and lanes');
  assert.equal(await evaluate(`document.querySelector('.git-history-graph')?.textContent.trim() === ''`), true, 'Graph has no ASCII lane text');
  assert.equal(await evaluate(`document.querySelectorAll('.git-change-badge').length === document.querySelectorAll('.git-change').length`), true, 'Every Git change has a badge on the right');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.git-change-badge')).every(badge => ['U', 'M', 'D'].includes(badge.textContent.trim()))`), true, 'Git badges use U, M and D');
  assert.equal(await evaluate(`!!document.querySelector('.file-breadcrumb') || !!document.querySelector('.diff-toggle') || !!document.querySelector('.editor-tabs')`), false, 'Graph hides editor tab bar, breadcrumb and diff toggle');
  await screenshot('git-graph.png');
  await evaluate(`document.querySelector('.git-history-row').click()`);
  await until(`!!document.querySelector('.git-commit-files .git-commit-file') && document.querySelector('.git-commit-files').textContent.includes('src/App.tsx')`, 'Commit expands to changed files');
  assert.equal(await evaluate(`document.querySelectorAll('.git-commit-files .git-commit-file').length`), 2, 'Commit lists every changed file');
  await evaluate(`document.querySelector('.git-commit-files .git-commit-file').click()`);
  await until(`document.querySelector('.git-commit-diff')?.textContent.includes('const before = leaf;')`, 'Commit file diff opens');
  await evaluate(`document.querySelector('.git-commit-diff-header button[aria-label="Torna al grafo"]').click()`);
  await until(`!!document.querySelector('.git-history-table') && !document.querySelector('.git-commit-diff')`, 'Back from commit diff returns to graph');
  assert.equal(await evaluate(`document.querySelector('.git-commit-files')?.textContent.includes('src/App.tsx')`), true, 'Expanded commit preserved after going back');
  await evaluate(`document.querySelector('.git-history-row').click()`);
  await until(`!document.querySelector('.git-commit-files')`, 'Clicking the expanded commit collapses it');
  await evaluate(`document.querySelector('.git-history-more button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'git_log').at(-1).args.limit === 600 && !document.querySelector('.git-history-more')`, 'Graph loads additional commits');
  await evaluate(`window.__qaHoldGitFetch = true; window.__qaGitFetchWaits = []; window.__qaHoldGitLog = true; window.__qaGitLogWaits = []; document.querySelector('button[aria-label="Sincronizza repository"]').click()`);
  await until(`window.__qaGitFetchWaits.length > 0 && window.__qaGitLogWaits.length > 0`, 'Git status and graph refresh start together');
  assert.equal(await evaluate(`document.querySelector('.statusbar .status-sync svg')?.classList.contains('animate-spin-reverse') && document.querySelector('.git-history-header button[aria-label="Ricarica grafo Git"] svg')?.classList.contains('animate-spin-reverse')`), true, 'Both Git indicators spin together');
  await evaluate(`window.__qaGitFetchWaits.forEach(resolve => resolve()); window.__qaGitFetchWaits = []`);
  await pause(80);
  assert.equal(await evaluate(`document.querySelector('.statusbar .status-sync svg')?.classList.contains('animate-spin-reverse') && document.querySelector('.git-history-header button[aria-label="Ricarica grafo Git"] svg')?.classList.contains('animate-spin-reverse')`), true, 'Status indicator waits for the graph refresh');
  await evaluate(`window.__qaHoldGitFetch = false; window.__qaHoldGitLog = false; (window.__qaGitLogWaits || []).forEach(resolve => resolve()); window.__qaGitLogWaits = []`);
  await until(`!document.querySelector('.statusbar .status-sync svg')?.classList.contains('animate-spin-reverse') && !document.querySelector('.git-history-header button[aria-label="Ricarica grafo Git"] svg')?.classList.contains('animate-spin-reverse')`, 'Both Git indicators stop after both updates finish');
  await evaluate(`window.__qaHoldGitStatus = true; window.__qaGitStatusWaits = []; window.dispatchEvent(new Event('focus'))`);
  await until(`window.__qaGitStatusWaits.length > 0`, 'Background Git status refresh starts');
  assert.equal(await evaluate(`!document.querySelector('.statusbar .status-sync svg')?.classList.contains('animate-spin-reverse') && !document.querySelector('.git-history-header button[aria-label="Ricarica grafo Git"] svg')?.classList.contains('animate-spin-reverse')`), true, 'Background Git refresh leaves both indicators still');
  await evaluate(`window.__qaHoldGitStatus = false; (window.__qaGitStatusWaits || []).forEach(resolve => resolve()); window.__qaGitStatusWaits = []`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pause(150);
  assert.equal(await evaluate(`!!document.querySelector('.git-history')`), true, 'Escape leaves the Git graph open');
  assert.equal(await evaluate(`!document.querySelector('button[title="Chiudi grafo Git"]')`), true, 'Git graph has no close button');
  await evaluate(`window.__qaEmit('lsp-diagnostics', { path: 'src/main.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, severity: 2, message: 'Example warning', source: 'TypeScript' }] })`);
  await evaluate(`document.querySelector('button[title="Apri build e problemi"]').click()`);
  await until(`document.body.textContent.includes('Example warning')`, 'problem list');
  await clickText('Build');
  await until(`document.querySelector('.build-result')?.textContent.includes('Completato')`, 'streamed build');
  await evaluate(`Array.from(document.querySelectorAll('.build-view-tabs button')).find(b => b.textContent.includes('Problemi')).click()`);
  await until(`document.querySelector('.problem-row') && document.body.textContent.includes('Build warning fixture')`, 'compile warning');
  await evaluate(`Array.from(document.querySelectorAll('.problem-row')).find(b => b.textContent.includes('Build warning fixture')).click()`);
  await until(`document.querySelector('.cm-activeLine')?.textContent.includes('greeting')`, 'warning source navigation');
  await evaluate(`document.querySelector('.activity-button:first-child').click()`);
  await evaluate(`document.querySelector('button[title="Apri build e problemi"]').click()`);
  await until(`document.querySelector('.build-history select')?.textContent.includes('Completato')`, 'build retained across views');
  await screenshot('build.png');
  assert.equal(await evaluate(`!!document.querySelector('.statusbar .branch-picker-badge')`), true, 'Dirty repository keeps its attention marker');
  assert.equal(await evaluate(`!!document.querySelector('.statusbar .status-branch-badge')`), true, 'Branch icon shows the attention badge');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.tree-row[aria-current="true"]')).boxShadow`), 'none', 'Selected file has no left stroke');
  await evaluate(`window.__qaAhead = 2; window.__qaBehind = 1; document.querySelector('button[aria-label="Sincronizza repository"]').click()`);
  await until(`document.querySelector('.statusbar .status-sync')?.textContent.includes('↑2')`, 'Remote update counts appear after fetch');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.statusbar .status-sync-count'), count => count.textContent)`), ['↓1', '↑2'], 'Sync item shows incoming commits first and outgoing commits on the right');
  assert.equal(await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').textContent.trim().endsWith('*')`), true, 'Uncommitted changes keep the branch star');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'git_fetch').at(-1).args.expectedWorkspace`), 'C:/Projects/helmcode', 'Fetch targets current repository');
  await evaluate(`window.__qaAhead = 0; window.__qaBehind = 0; window.dispatchEvent(new Event('focus'))`);
  await until(`document.querySelector('button[aria-label="Sincronizza repository"]').title.includes('0 da inviare, 0 da scaricare')`, 'Remote counts sync from background status');
  await evaluate(`document.querySelector('button[aria-label="Sincronizza repository"]').click()`);
  await until(`document.querySelector('button[aria-label="Sincronizza repository"]').title.includes('0 da inviare, 0 da scaricare')`, 'Remote counts clear when up to date');
  assert.equal(await evaluate(`document.querySelector('.statusbar .status-sync').textContent.trim()`), '', 'Sync item hides counts when up to date');
  assert.equal(await evaluate(`!!document.querySelector('.statusbar .branch-picker-badge')`), true, 'Local changes keep the existing attention marker');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await until(`!!document.querySelector('.branch-picker-create')`, 'new branch action');
  await evaluate(`document.querySelector('.branch-picker-create').click()`);
  await until(`!!document.querySelector('#branch-name')`, 'new branch modal');
  let branchCreates = await evaluate(`window.__qaCalls.filter(c => c.command === 'git_create_branch').length`);
  await evaluate(`(() => { const input = document.querySelector('#branch-name'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'feature/da-base'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`Array.from(document.querySelectorAll('.window-choice-option')).find(button => button.textContent.includes('Da un branch')).click()`);
  await until(`!!document.querySelector('#branch-base')`, 'branch base picker');
  await evaluate(`(() => { const select = document.querySelector('#branch-base'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'main'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!!Array.from(document.querySelectorAll('.window-choice-option')).find(button => button.textContent.includes('Annulla le modifiche'))`, 'uncommitted change choice appears for another base');
  await evaluate(`Array.from(document.querySelectorAll('.window-choice-option')).find(button => button.textContent.includes('Annulla le modifiche')).click()`);
  await evaluate(`document.querySelector('.modal-card .accent-button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'git_create_branch').length > ${branchCreates}`, 'branch created from another base');
  assert.deepEqual(await evaluate(`window.__qaCalls.filter(c => c.command === 'git_create_branch').at(-1).args`),
    { expectedWorkspace: 'C:/Projects/helmcode', name: 'feature/da-base', base: 'main', keepChanges: false }, 'Discarding changes creates the branch from the chosen base');
  await until(`document.querySelector('.statusbar').textContent.includes('feature/da-base')`, 'new branch appears in the status bar');
  assert.equal(await evaluate(`!!document.querySelector('.branch-picker-badge')`), false, 'Discarded changes leave a clean repository');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await until(`!!document.querySelector('.branch-picker-create')`, 'new branch action after creation');
  await evaluate(`document.querySelector('.branch-picker-create').click()`);
  await until(`!!document.querySelector('#branch-name')`, 'new branch modal from current state');
  branchCreates = await evaluate(`window.__qaCalls.filter(c => c.command === 'git_create_branch').length`);
  await evaluate(`(() => { const input = document.querySelector('#branch-name'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'feature/da-ora'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.modal-card .accent-button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'git_create_branch').length > ${branchCreates}`, 'branch created from current state');
  assert.deepEqual(await evaluate(`window.__qaCalls.filter(c => c.command === 'git_create_branch').at(-1).args`),
    { expectedWorkspace: 'C:/Projects/helmcode', name: 'feature/da-ora', base: null, keepChanges: true }, 'Current state keeps files and uncommitted changes');
  await evaluate(`Array.from(document.querySelectorAll('.build-view-tabs button')).find(b => b.textContent.includes('Output')).click()`);
  await clickText('AGENT');
  await evaluate(`document.querySelector('.status-problems').click()`);
  await until(`getComputedStyle(document.querySelector('.ide-workspace')).display !== 'none' && document.querySelector('.build-view-tabs button[aria-selected="true"]')?.textContent.includes('Problemi')`, 'Combined Problems button opens HELM Problems from AGENT and Output');
  await screenshot('statusbar.png');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'pty_create').length`), 1, 'AGENT session created once');
  const screenResizes = await evaluate(`window.__qaResizes`);
  assert.ok(screenResizes.length >= 3, 'Projects and workspace transitions resize the native window');
  assert.ok(screenResizes.every(resize => resize.cause === 'size' && !resize.splash), 'No intermediate expansion or resize behind the splash');
  assert.deepEqual(screenResizes.map(resize => resize.paintedScreen), screenResizes.map((_, index) => index % 2 ? 'projects' : 'workspace'), 'Only painted screen changes resize the window');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'plugin:window|center').length`), screenResizes.length, 'Each native size change centers once');
  assert.deepEqual(await evaluate(`window.__qaUnknown`), [], 'Workspace IPC contracts covered');
  await evaluate(`document.querySelector('.activity-button:first-child').click()`);
  await until(`!!document.querySelector('.tree-row[title="index.html"] [data-file-kind]')`, 'File type icons in explorer');
  const iconSamples = await evaluate(`['index.html', 'style.css', 'app.py', 'README.md', 'package.json', 'src'].map(path => {
    const row = Array.from(document.querySelectorAll('.tree-row')).find(row => row.title === path);
    const icon = row.querySelector('[data-file-kind]');
    return { path, kind: icon.getAttribute('data-file-kind'), color: getComputedStyle(icon).color };
  })`);
  assert.ok(new Set(iconSamples.map(icon => icon.kind)).size >= 5, 'Files and folders have distinct type icons');
  assert.ok(new Set(iconSamples.map(icon => icon.color)).size >= 5, 'File and folder type palette has distinct colors');
  const openFolderShape = await evaluate(`document.querySelector('.tree-row[title="src"] [data-file-kind]').innerHTML`);
  await evaluate(`document.querySelector('.tree-row[title="src"]').click()`);
  assert.notEqual(await evaluate(`document.querySelector('.tree-row[title="src"] [data-file-kind]').innerHTML`), openFolderShape, 'Open and closed folders have different geometry');
  await evaluate(`document.querySelector('.tree-row[title="src"]').click()`);
  await screenshot('file-icons.png');

  await evaluate(`window.__qaTokenColor = token => {
    const spans = Array.from(document.querySelectorAll('.cm-content span'));
    const span = spans.find(span => span.textContent === token) ?? spans.find(span => !span.children.length && span.textContent.split(' ').includes(token));
    return span ? getComputedStyle(span).color : null;
  }`);
  const openFixture = async (name, marker) => {
    await evaluate(`Array.from(document.querySelectorAll('.tree-row')).find(row => row.title === ${JSON.stringify(name)}).click()`);
    await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === ${JSON.stringify(name)} && document.querySelector('.cm-content')?.textContent.includes(${JSON.stringify(marker)})`, `Open ${name}`);
  };
  delayScriptResponses = 350;
  await openFixture('index.html', '<!doctype html>');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.insertText', { text: '\n<!-- kept while parser loads -->' });
  await until(`!!document.querySelector('[data-language="HTML"]')`, 'HTML parser installed');
  await until(`window.__qaTokenColor('main') && window.__qaTokenColor('class') && window.__qaTokenColor('"workspace"') && window.__qaTokenColor('const') && window.__qaTokenColor('color')`, 'HTML with embedded CSS and JavaScript highlighted');
  delayScriptResponses = 0;
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent.includes('kept while parser loads')`), true, 'Lazy parser load preserves edits');
  assert.equal(await evaluate(`window.__qaTokenColor('main') !== window.__qaTokenColor('class') && window.__qaTokenColor('class') !== window.__qaTokenColor('"workspace"')`), true, 'HTML tag, attribute and string use different colors');
  assert.equal(await evaluate(`window.__qaTokenColor('const') !== window.__qaTokenColor('"Hello"')`), true, 'Embedded JavaScript keyword and string colors differ');
  assert.ok(await evaluate(`new Set(Array.from(document.querySelectorAll('.cm-content span'), span => getComputedStyle(span).color)).size >= 5`), 'HTML, CSS and JS use a real token palette');
  const treeHtmlIcon = iconSamples.find(icon => icon.path === 'index.html');
  assert.deepEqual(await evaluate(`(() => { const icon = document.querySelector('.file-tab-select[aria-selected="true"] [data-file-kind]'); return { kind: icon.getAttribute('data-file-kind'), color: getComputedStyle(icon).color }; })()`), { kind: treeHtmlIcon.kind, color: treeHtmlIcon.color }, 'Editor tabs share the explorer icon and type color');
  await screenshot('syntax-html.png');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await until(`!document.querySelector('.cm-content').textContent.includes('kept while parser loads')`, 'Undo history survives lazy parser load');
  await openFixture('app.py', 'def greet');
  await until(`!!document.querySelector('[data-language="Python"]')`, 'Python parser installed');
  await until(`Array.from(document.querySelectorAll('.cm-indent-markers')).some(line => getComputedStyle(line, '::before').backgroundImage.includes('repeating-linear-gradient'))`, 'Indentation guides render in the editor');
  await until(`window.__qaTokenColor('def') && window.__qaTokenColor('"Hello"')`, 'Python highlighted');
  assert.equal(await evaluate(`window.__qaTokenColor('def') !== window.__qaTokenColor('"Hello"')`), true, 'Python keyword and string colors differ');
  await openFixture('config.yaml', 'greeting:');
  await until(`!!document.querySelector('[data-language="YAML"]')`, 'YAML parser installed');
  await until(`new Set(Array.from(document.querySelectorAll('.cm-content span'), span => getComputedStyle(span).color)).size >= 3`, 'YAML highlighted');
  await openFixture('Cargo.toml', '[package]');
  await until(`!!document.querySelector('[data-language="TOML"]')`, 'TOML parser installed');
  await until(`new Set(Array.from(document.querySelectorAll('.cm-content span'), span => getComputedStyle(span).color)).size >= 2`, 'TOML highlighted');
  await openFixture('notes.unknown', 'A plain file');
  assert.equal(await evaluate(`!!document.querySelector('[data-language="Testo semplice"]')`), true, 'Unknown extension has no installed parser');
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent.includes('A plain file has no programming language.')`), true, 'Unknown extension remains editable plain text');
  await evaluate(`document.querySelector('.tree-row[title="src/main.ts"]').click()`);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'src/main.ts' && !!document.querySelector('[data-language="TypeScript"]')`, 'TypeScript parser restored after language switches');
  await screenshot('syntax-typescript.png');
  await until(`window.__qaTokenColor('const')`, 'TypeScript syntax restored after language switches');
  assert.equal(await evaluate(`window.__qaTokenColor('const') !== window.__qaTokenColor('"Hello, helmcode"')`), true, 'TypeScript keyword and string colors differ');
  assert.deepEqual(await evaluate(`window.__qaUnknown`), [], 'Language and icon flows use supported desktop contracts');
  const symbolPoint = (token, lineText = token) => evaluate(`(() => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find(line => line.textContent.includes(${JSON.stringify(lineText)}));
    if (!line) throw new Error('Symbol line not found');
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let text; (text = walker.nextNode());) {
      const index = text.textContent.indexOf(${JSON.stringify(token)});
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + ${token.length});
      const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error('Symbol token not found');
  })()`);
  const mouseSymbol = async (token, lineText, modifiers = 0, button = 'left') => {
    const point = await symbolPoint(token, lineText);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, modifiers, button, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, modifiers, button, clickCount: 1 });
  };
  const key = async (name, code, windowsVirtualKeyCode, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode, modifiers });
  };
  await openFixture('Main.java', 'class Main');
  await until(`document.querySelector('.intelligence-status')?.dataset.state === 'ready'`, 'Java language server status');
  await mouseSymbol('pri', 'pri');
  await key('End', 'End', 35);
  await key(' ', 'Space', 32, 2);
  await until(`Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).some(item => item.textContent.includes('println'))`, 'LSP method autocomplete');
  await evaluate(`Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).find(item => item.textContent.includes('println') && item.textContent.includes('fixture')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
  await until(`document.querySelector('.cm-content').textContent.includes('System.out.println(message);')`, 'LSP snippet inserted');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'lsp_completion').at(-1).args.text.includes('pri')`), true, 'Completion receives current unsaved text');
  await screenshot('intelligence-java.png');
  await mouseSymbol('greet', 'greet();', 2);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'Implementations.java'`, 'Ctrl click navigates to definition in another file');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'lsp_navigate').at(-1)?.args.kind`), 'auto', 'Ctrl click requests contextual navigation');
  assert.equal(await evaluate(`document.querySelector('.cm-activeLine')?.textContent.includes('void greet()')`), true, 'Definition reveals target position');
  await openFixture('Main.java', 'class Main');
  await mouseSymbol('greet', 'void greet()', 2);
  await until(`document.querySelectorAll('.symbol-targets-list button').length === 2`, 'Ctrl click on the declaration offers its implementations');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'lsp_navigate').at(-1)?.args.kind`), 'auto', 'The same Ctrl click gesture handles declarations');
  await evaluate(`document.querySelectorAll('.symbol-targets-list button')[1].click()`);
  await until(`document.querySelector('.cm-activeLine')?.textContent.includes('greetAgain')`, 'Chosen implementation reveals correct line');
  await openFixture('Main.java', 'class Main');
  await mouseSymbol('greet', 'greet();', 10);
  await until(`document.querySelectorAll('.symbol-targets-list button').length === 2`, 'Explicit implementation shortcut remains available');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'lsp_navigate').at(-1)?.args.kind`), 'implementation', 'Ctrl Shift click explicitly requests implementations');
  await key('Escape', 'Escape', 27);
  await mouseSymbol('greet', 'greet();', 0, 'right');
  await until(`document.querySelectorAll('.symbol-menu [role="menuitem"]').length === 3`, 'Symbol navigation context menu');
  await evaluate(`Array.from(document.querySelectorAll('.symbol-menu button')).find(button => button.textContent.includes('dichiarazione')).click()`);
  await until(`window.__qaCalls.filter(call => call.command === 'lsp_navigate').at(-1)?.args.kind === 'declaration' && document.querySelector('.cm-activeLine')?.textContent.includes('void greet()')`, 'Declaration command reveals method signature');
  await evaluate(`window.__qaExternalTarget = true`);
  await mouseSymbol('greet', 'greet();', 2);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'C:/Libraries/External.java' && document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false'`, 'Dependency target opens read only');
  const writesBeforeDependency = await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file' && call.args.path === 'C:/Libraries/External.java').length`);
  await key('s', 'KeyS', 83, 2);
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file' && call.args.path === 'C:/Libraries/External.java').length`), writesBeforeDependency, 'Dependency cannot be saved');
  await evaluate(`document.querySelector('button[aria-label="Chiudi External.java"]').click(); window.__qaReadDelay = 500`);
  await openFixture('Main.java', 'class Main');
  const previousTargetReads = await evaluate(`window.__qaCalls.filter(call => call.command === 'lsp_read_target').length`);
  await mouseSymbol('greet', 'greet();', 2);
  await until(`window.__qaCalls.filter(call => call.command === 'lsp_read_target').length > ${previousTargetReads}`, 'Dependency file read starts');
  await openFixture('notes.unknown', 'A plain file');
  await pause(650);
  assert.equal(await evaluate(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title`), 'notes.unknown', 'Late file read cannot steal focus from a newer tab');
  await evaluate(`window.__qaReadDelay = 0`);
  await evaluate(`window.__qaExternalTarget = false; window.__qaMissingServer = true`);
  await openFixture('Implementations.java', 'class Implementations');
  await until(`document.querySelector('.intelligence-status')?.dataset.state === 'missing'`, 'Missing server status is visible');
  await evaluate(`document.querySelector('.intelligence-status').click()`);
  await until(`document.querySelector('.intelligence-details')?.textContent.includes('jdtls')`, 'Missing Java server explains setup');
  await key('Escape', 'Escape', 27);
  await mouseSymbol('greet', 'greet()');
  await key('End', 'End', 35);
  await send('Input.insertText', { text: '\npri' });
  await key(' ', 'Space', 32, 2);
  await until(`Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).some(item => item.textContent.includes('private'))`, 'Local Java keyword completions work without a server');
  await key('Escape', 'Escape', 27);
  await evaluate(`window.__qaMissingServer = false`);
  await openFixture('Main.java', 'class Main');
  await evaluate(`window.__qaNavigationDelay = 500`);
  await mouseSymbol('greet', 'greet();', 2);
  await openFixture('notes.unknown', 'A plain file');
  await pause(650);
  assert.equal(await evaluate(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title`), 'notes.unknown', 'Late navigation cannot switch a newer tab');
  await evaluate(`window.__qaNavigationDelay = 0`);
  await evaluate(`document.querySelector('.tree-row[title="src/main.ts"]').click()`);
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'src/main.ts'`, 'Original project restored after navigation checks');
  await evaluate(`document.querySelector('.tree-row[title="src"]').focus(); document.querySelector('.sidebar-header button[aria-label="Nuova cartella"]').click()`);
  await until(`!!document.querySelector('input[aria-label="Nome nuova cartella"]')`, 'Inline new folder input');
  const enterDraft = async (label, name) => {
    await until(`!!document.querySelector('input[aria-label=${JSON.stringify(label)}]')`, 'Creation field visible');
    await evaluate(`document.querySelector('input[aria-label=${JSON.stringify(label)}]').focus()`);
    await send('Input.insertText', { text: name });
    await until(`document.querySelector('.explorer-create input')?.value === ${JSON.stringify(name)} && !document.querySelector('.explorer-create button[type="submit"]').disabled`, 'Creation input ready');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await enterDraft('Nome nuova cartella', 'nested');
  await until(`!!document.querySelector('.tree-row[title="src/nested"]') && !document.querySelector('.explorer-create')`, 'Folder created inside selected directory');
  assert.equal(await evaluate(`!!document.querySelector('.start-screen')`), false, 'New folder does not navigate to Projects');
  await evaluate(`document.querySelector('.sidebar-header button[aria-label="Nuovo file"]').click()`);
  await until(`!!document.querySelector('input[aria-label="Nome nuovo file"]')`, 'New file input');
  await enterDraft('Nome nuovo file', 'hello.ts');
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'src/nested/hello.ts'`, 'New file opens in editor');
  await evaluate(`document.querySelector('.tree-row[title="src/nested/hello.ts"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 240 }))`);
  await until(`!!document.querySelector('.explorer-context-menu')`, 'Explorer right click menu');
  await screenshot('explorer-context-menu.png');
  await evaluate(`Array.from(document.querySelectorAll('.explorer-context-menu button')).find(button => button.textContent.includes('Nuovo file')).click()`);
  await enterDraft('Nome nuovo file', 'sibling.css');
  await until(`!!document.querySelector('.tree-row[title="src/nested/sibling.css"]')`, 'Right click file creates sibling in its parent');
  await evaluate(`document.querySelector('.sidebar-header button[aria-label="Nuovo file"]').click()`);
  await enterDraft('Nome nuovo file', 'hello.ts');
  await until(`document.querySelector('.explorer-tree').textContent.includes('Esiste già')`, 'Duplicate filename shows error');
  assert.equal(await evaluate(`!!document.querySelector('.explorer-create')`), true, 'Duplicate error preserves filename input');
  await evaluate(`document.querySelector('button[aria-label="Annulla creazione"]').click()`);
  await evaluate(`document.querySelector('.explorer-tree').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 400 }))`);
  await until(`!!document.querySelector('.explorer-context-menu')`, 'Blank area context menu');
  await evaluate(`Array.from(document.querySelectorAll('.explorer-context-menu button')).find(button => button.textContent.includes('Nuova cartella')).click()`);
  await enterDraft('Nome nuova cartella', 'root-folder');
  await until(`!!document.querySelector('.tree-row[title="root-folder"]')`, 'Blank area creates folder at project root');
  await screenshot('explorer-create.png');
  await evaluate(`document.querySelector('.explorer-tree').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 150, clientY: 400 }))`);
  await until(`!!document.querySelector('.explorer-context-menu')`, 'Context menu before unusual folder name');
  await evaluate(`Array.from(document.querySelectorAll('.explorer-context-menu button')).find(button => button.textContent.includes('Nuova cartella')).click()`);
  await enterDraft('Nome nuova cartella', 'constructor');
  await until(`!!document.querySelector('.tree-row[title="constructor"]')`, 'Unusual valid folder name created');
  await evaluate(`document.querySelector('.tree-row[title="constructor"]').click()`);
  await pause(100);
  assert.equal(await evaluate(`!!document.querySelector('.tree-row[title="constructor"]')`), true, 'Unusual folder name expands safely');
  const tabBeforeChain = await evaluate(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title`);
  await evaluate(`document.querySelector('.tree-row[title="chain"]').click()`);
  await until(`document.querySelector('.tree-row[title="chain/java/main"]')?.textContent.trim() === 'chain \\\\ java \\\\ main'`, 'Single child folders compact into one row');
  assert.equal(await evaluate(`!!document.querySelector('.tree-row[title="chain/java"]')`), false, 'Intermediate chain rows are merged');
  assert.equal(await evaluate(`document.querySelectorAll('.tree-row[title="chain/java/main/One.java"], .tree-row[title="chain/java/main/Two.java"]').length`), 2, 'Chain stops at the folder with two choices');
  assert.equal(await evaluate(`!!document.querySelector('.tree-row[title="chain/java/main"][data-selected]')`), true, 'Compact row selects the branching folder');
  assert.equal(await evaluate(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title`), tabBeforeChain, 'Expanding folders does not open files');
  await openFixture('MoveMe.java', 'class MoveMe');
  await evaluate(`document.querySelector('.tree-row[title="MoveMe.java"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 240 }))`);
  await until(`!!document.querySelector('.explorer-context-menu')`, 'Context menu for rename');
  await evaluate(`Array.from(document.querySelectorAll('.explorer-context-menu button')).find(button => button.textContent.includes('Rinomina')).click()`);
  await until(`document.querySelector('input[aria-label="Nuovo nome"]')?.value === 'MoveMe.java'`, 'Rename input prefilled');
  await send('Input.insertText', { text: 'Moved' });
  await until(`document.querySelector('input[aria-label="Nuovo nome"]')?.value === 'Moved.java'`, 'Rename field ready');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(`!!document.querySelector('.tree-row[title="Moved.java"]') && !document.querySelector('.tree-row[title="MoveMe.java"]')`, 'Context menu renames files');
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'Moved.java'`, 'Renamed file keeps its tab');
  await evaluate(`document.querySelector('.tree-row[title="UsesMoveMe.java"]').click()`);
  await until(`document.querySelector('.cm-content')?.textContent.includes('Moved value')`, 'Renaming updates project references');
  await openFixture('Moved.java', 'class Moved');
  await evaluate(`window.__qaPauseNextSave = true; document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.insertText', { text: '\n// draft retained after drag' });
  await until(`typeof window.__qaFinishSave === 'function'`, 'Autosave is in flight before drag');
  const mutationsBeforeDrag = await evaluate(`window.__qaCalls.filter(call => call.command === 'mutate_entries').length`);
  await dragFile('Moved.java', 'drop-target', true);
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'mutate_entries').length`), mutationsBeforeDrag, 'Moving waits for in-flight saves before refactoring');
  await evaluate(`window.__qaFinishSave(); window.__qaFinishSave = null;`);
  await until(`!!document.querySelector('.tree-row[title="drop-target/Moved.java"]') && !document.querySelector('.tree-row[title="Moved.java"]')`, 'Drag and drop moves files into folders');
  await until(`Array.from(document.querySelectorAll('.file-tab-select')).some(tab => tab.title === 'drop-target/Moved.java')`, 'Moved file keeps its tab');
  await until(`document.querySelector('.file-tab-select[aria-selected="true"]')?.title === 'drop-target/Moved.java' && document.querySelector('.cm-content')?.textContent.includes('draft retained after drag')`, 'Drag keeps current editor content');
  await pause(650);
  assert.equal(await evaluate(`window.__TAURI_INTERNALS__.invoke('read_file_text', { path: 'Moved.java' }).then(() => false, () => true)`), true, 'Autosave does not recreate the original path after a move');
  await evaluate(`(() => {
    const source = document.querySelector('.tree-row[title="chain/java/main"]');
    const target = document.querySelector('.tree-row[title="drop-target"]');
    const data = new DataTransfer();
    for (const [type, node] of [['dragstart', source], ['dragover', target], ['drop', target], ['dragend', source]]) {
      node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  })()`);
  await until(`!!document.querySelector('.tree-row[title="drop-target/main/One.java"]') && !document.querySelector('.tree-row[title="chain/java/main"]')`, 'Drag and drop moves compact folders with their descendants');
  await screenshot('explorer-file-operations.png');
  await evaluate(`document.querySelector('.tree-row[title="drop-target/Moved.java"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 240 }))`);
  await until(`!!document.querySelector('.explorer-context-menu')`, 'Context menu for delete');
  await evaluate(`Array.from(document.querySelectorAll('.explorer-context-menu button')).find(button => button.textContent.includes('Cancella')).click()`);
  await until(`document.querySelector('#confirm-title')?.textContent === 'Elimina elementi'`, 'Delete confirmation');
  await clickText('Elimina');
  await until(`!document.querySelector('.tree-row[title="drop-target/Moved.java"]')`, 'Context menu deletes files');
  await until(`!Array.from(document.querySelectorAll('.file-tab-select')).some(tab => tab.title === 'drop-target/Moved.java')`, 'Deleted file closes its tab');
  await clickText('AGENT');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await until(`document.querySelector('.terminal-panel:not([hidden])') && document.querySelectorAll('.terminal-tab').length === 1 && window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 1`, 'First shell terminal opens');
  const firstShell = await evaluate(`window.__qaCalls.find(c => c.command === 'pty_create' && !c.args.agent).args.id`);
  await evaluate(`window.__qaFirstTerminal = document.querySelector('.terminal-panel .xterm')`);
  await evaluate(`document.querySelector('button[aria-label="Nuovo terminale"]').click()`);
  await until(`document.querySelectorAll('.terminal-tab').length === 2 && window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 2`, 'Independent second shell terminal');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '~', code: 'Backquote', modifiers: 10, windowsVirtualKeyCode: 192 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '~', code: 'Backquote', modifiers: 10, windowsVirtualKeyCode: 192 });
  await until(`document.querySelectorAll('.terminal-tab').length === 3 && window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 3`, 'Keyboard creates a third terminal');
  await pause(150);
  await evaluate(`document.querySelector('button[aria-label="Rinomina terminale"]').click()`);
  await until(`(() => { const input = document.querySelector('input[aria-label="Nome terminale"]'); if (!input) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Server dev'); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value === 'Server dev'; })()`, 'Terminal rename field');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(`document.querySelector('.terminal-tab.is-active').textContent.includes('Server dev')`, 'Terminal rename');
  await evaluate(`document.querySelector('.terminal-tab-select[title="PowerShell 1"]').click()`);
  await until(`document.querySelector('.terminal-pane:not([hidden])').dataset.sessionId === ${JSON.stringify(firstShell)}`, 'Select existing terminal');
  assert.equal(await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .xterm') === window.__qaFirstTerminal`), true, 'Terminal buffer element preserved across tab switches');
  await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus()`);
  await send('Input.insertText', { text: 'echo terminal-one' });
  await until(`window.__qaCalls.some(c => c.command === 'pty_write' && c.args.id === ${JSON.stringify(firstShell)} && c.args.data.includes('terminal-one'))`, 'Input reaches selected shell');
  await evaluate(`document.querySelector('button[aria-label="Nascondi terminali"]').click()`);
  assert.equal(await evaluate(`window.__qaCalls.some(c => c.command === 'pty_close' && c.args.id === ${JSON.stringify(firstShell)})`), false, 'Hiding panel preserves sessions');
  await clickText('AGENT');
  await clickText('HELM');
  await evaluate(`document.querySelector('button[aria-label="Terminali"]').click()`);
  await until(`document.querySelector('.terminal-panel')?.hidden === false`, 'Existing terminal panel is visible');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length`), 3, 'No shell restarts on panel or mode changes');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await until(`document.querySelector('.terminal-panel')?.hidden === true`, 'Ctrl+Shift+T hides an open terminal');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'T', code: 'KeyT', modifiers: 10, windowsVirtualKeyCode: 84 });
  await until(`document.querySelector('.terminal-panel')?.hidden === false && document.activeElement?.classList.contains('xterm-helper-textarea')`, 'Ctrl+Shift+T reopens and focuses the existing terminal');
  const shellToClose = await evaluate(`document.querySelector('.terminal-pane:not([hidden])').dataset.sessionId`);
  await evaluate(`document.querySelector('button[aria-label="Chiudi terminale attivo"]').click()`);
  await until(`document.querySelectorAll('.terminal-tab').length === 2 && window.__qaCalls.some(c => c.command === 'pty_close' && c.args.id === ${JSON.stringify(shellToClose)})`, 'Closing terminal releases its PTY');
  const exitedShell = await evaluate(`document.querySelector('.terminal-pane:not([hidden])').dataset.sessionId`);
  await evaluate(`window.__qaEmit('pty-exit', { id: ${JSON.stringify(exitedShell)} })`);
  await until(`!!document.querySelector('.terminal-pane:not([hidden]) .terminal-exit-notice')`, 'Exited terminal can be restarted');
  await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .terminal-exit-notice button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 4`, 'Restart creates fresh PTY');
  await pause(250);
  await screenshot('terminals.png');
  assert.equal(await evaluate(`(() => { const panel = document.querySelector('.terminal-panel').getBoundingClientRect(); const bar = document.querySelector('.statusbar').getBoundingClientRect(); return panel.bottom <= bar.top + 1; })()`), true, 'Terminal panel stays above the status bar');
  assert.equal(await evaluate(`(() => { const screen = document.querySelector('.terminal-pane:not([hidden]) .xterm-screen')?.getBoundingClientRect(); const host = document.querySelector('.terminal-pane:not([hidden]) .terminal-session > div')?.getBoundingClientRect(); return !!screen && !!host && screen.bottom <= host.bottom + 1; })()`), true, 'Terminal rows fit inside the visible host');
  const terminalHeight = await evaluate(`document.querySelector('.terminal-panel').getBoundingClientRect().height`);
  await evaluate(`document.querySelector('[aria-label="Ridimensiona terminali"]').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await until(`document.querySelector('.terminal-panel').getBoundingClientRect().height > ${terminalHeight}`, 'Terminal panel resizes using keyboard');
  assert.equal(await evaluate(`(() => { const panel = document.querySelector('.terminal-panel').getBoundingClientRect(); const bar = document.querySelector('.statusbar').getBoundingClientRect(); return panel.bottom <= bar.top + 1; })()`), true, 'Resized terminal stays above the status bar');
  await evaluate(`Array.from(document.querySelectorAll('.terminal-tab-close')).forEach(button => button.click())`);
  await until(`!!document.querySelector('.terminal-empty')`, 'Closing all terminals shows empty state');
  await evaluate(`document.querySelector('button[aria-label="Nascondi terminali"]').click(); document.querySelector('button[aria-label="Terminali"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 0, 'Empty panel does not reopen unwanted shell');
  await evaluate(`document.querySelector('button[aria-label="Nuovo terminale"]').click()`);
  await until(`document.querySelectorAll('.terminal-tab').length === 1`, 'New terminal after closing all');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'pty_create' && c.args.agent).length`), 1, 'Shell terminals do not recreate AGENT');
  await until(`window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 5`, 'Fresh shell started');
  const oldShells = await evaluate(`window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).map(c => c.args.id)`);
  await evaluate(`window.__qaEmit('workspace-changed', 'C:/Projects/another-project')`);
  await until(`window.__qaCalls.filter(c => c.command === 'pty_create' && !c.args.agent).length === 6`, 'New project gets its own terminal');
  assert.equal(await evaluate(`${JSON.stringify(oldShells)}.every(id => window.__qaCalls.some(c => c.command === 'pty_close' && c.args.id === id))`), true, 'Switching projects closes previous shell sessions');
  for (const query of ['?start', '?start&noSplash', '?start&splashEnabled', '?start&newWindow', '?start&newWindow&splashEnabled']) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });
    await until(`!!document.querySelector('.start-screen') && !document.querySelector('.splash-screen')`, 'projects startup ready');
    await pause(200);
    assert.equal(await evaluate(`window.__qaSplashSeen`), !query.includes('noSplash') && !query.includes('newWindow'), 'Only normal startup shows splash and respects the preference');
    assert.deepEqual(await evaluate(`window.__qaCalls.filter(c => ['plugin:window|set_size', 'plugin:window|set_min_size', 'plugin:window|center', 'plugin:window|set_position', 'plugin:window|unmaximize'].includes(c.command))`), [], `Projects startup preserves native window position and size (${query})`);
    if (query.includes('newWindow')) {
      assert.equal(await evaluate(`window.__qaSplashSeen`), false, 'Menu window never mounts the splash, including while launch intent is pending');
      assert.equal(await evaluate(`window.__qaCalls.some(c => c.command === 'open_workspace')`), false, 'Menu window stays on Projects');
      assert.equal(await evaluate(`localStorage.getItem('helmcode.start.splash')`), query.includes('splashEnabled') ? 'true' : null, 'Menu windows preserve normal startup splash preference');
    }
  }
  const openCreateModal = async (name) => {
    await evaluate(`document.querySelector('.start-main .start-action-secondary').click()`);
    await until(`!!document.querySelector('#project-name')`, 'new project modal');
    await evaluate(`Array.from(document.querySelectorAll('.modal-card button')).find(button => button.textContent.includes('Scegli')).click()`);
    await until(`document.querySelector('#project-parent')?.value === 'C:/Projects'`, 'project parent selected');
    await evaluate(`(() => { const input = document.querySelector('#project-name'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(name)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`document.querySelector('.modal-card .accent-button')?.disabled === false`, 'new project ready');
  };
  await openCreateModal('progetto-diretto');
  let createdProjects = await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').length`);
  await evaluate(`document.querySelector('.modal-card .accent-button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'create_workspace').length > ${createdProjects}`, 'project created directly');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').at(-1).args.open`), true, 'Creation on the Projects screen opens in the current window');
  assert.equal(await evaluate(`!document.querySelector('.window-choice')`), true, 'No window choice when creating on the Projects screen');
  await openCreateModal('progetto-scelta');
  createdProjects = await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').length`);
  await evaluate(`document.querySelector('.modal-card .accent-button').click()`);
  await until(`window.__qaCalls.filter(c => c.command === 'create_workspace').length > ${createdProjects}`, 'second project created directly from Projects');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').at(-1).args.open`), true, 'Projects screen creates the project here');
  assert.equal(await evaluate(`!document.querySelector('.window-choice')`), true, 'No window choice when creating on the Projects screen again');
  await evaluate(`window.__qaEmit('workspace-changed', 'C:/Projects/progetto-scelta')`);
  await until(`!document.querySelector('.start-screen') && !!document.querySelector('.titlebar')`, 'editor after project change');
  await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
  await until(`!!document.querySelector('.project-menu')`, 'project menu inside the editor');
  await evaluate(`Array.from(document.querySelectorAll('.project-menu-item')).find(button => button.textContent.includes('Nuovo progetto vuoto')).click()`);
  await until(`!!document.querySelector('#project-name')`, 'editor new project modal');
  await evaluate(`Array.from(document.querySelectorAll('.modal-card button')).find(button => button.textContent.includes('Scegli')).click()`);
  await until(`document.querySelector('#project-parent')?.value === 'C:/Projects'`, 'editor project parent selected');
  await evaluate(`(() => { const input = document.querySelector('#project-name'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'progetto-editor'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelector('.modal-card .accent-button')?.disabled === false`, 'editor new project ready');
  createdProjects = await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').length`);
  await evaluate(`document.querySelector('.modal-card .accent-button').click()`);
  await until(`!!document.querySelector('.window-choice')`, 'creation asks for a window inside the editor');
  assert.equal(await evaluate(`window.__qaCalls.filter(c => c.command === 'create_workspace').length`), createdProjects, 'Editor creation waits for the window choice');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await until(`!document.querySelector('.window-choice')`, 'editor creation window choice closed');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?noSplash` });
  await until(`!!document.querySelector('.mode-button')`, 'workspace for startup errors');
  await evaluate(`window.__qaFailAgentStart = true`);
  await clickText('AGENT');
  await until(`!!document.querySelector('.ai-restart') && !document.querySelector('.agent-loading')`, 'Startup error dismisses loader and offers retry');
  await evaluate(`window.__qaFailAgentStart = false; window.__qaHoldAgentOutput = true`);
  await clickText('Riavvia AGENT');
  await until(`window.__qaCalls.filter(c => c.command === 'pty_create').length === 2 && document.querySelector('.terminal-session')?.getAttribute('aria-busy') === 'true'`, 'Restart shows loader for new session');
  await evaluate(`window.__qaEmit('pty-exit', { id: window.__qaCalls.filter(c => c.command === 'pty_create').at(-1).args.id })`);
  await until(`!!document.querySelector('.ai-restart') && !document.querySelector('.agent-loading')`, 'Early exit dismisses loader');
  // Exercise the actual settings controls, editor, diff and terminal renderers in both palettes.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?noSplash&lightTheme` });
  await until(`!!document.querySelector('.mode-button') && document.documentElement.dataset.theme === 'light'`, 'Saved light theme applied at startup');
  assert.equal(await evaluate(`window.__qaThemeAtShow`), 'light', 'Light theme is applied before showing the native window');
  await evaluate(`document.querySelector('.tree-row[title="src"]').click()`);
  await until(`!!document.querySelector('.tree-row[title="src/main.ts"]')`, 'Theme fixture folder');
  await evaluate(`document.querySelector('.tree-row[title="src/main.ts"]').click()`);
  await until(`!!document.querySelector('.cm-content')`, 'Theme fixture editor');
  await evaluate(`window.__qaRefreshReads = []; window.__qaReadFile = (path, text) => path === 'src/main.ts' ? new Promise(resolve => window.__qaRefreshReads.push(resolve)) : Promise.resolve(text); window.__qaEmit('fs-changed', { workspace: 'C:/Projects/old-workspace', paths: ['src/main.ts'] });`);
  await pause(100);
  assert.equal(await evaluate(`window.__qaRefreshReads.length`), 0, 'Late watcher events from another workspace are ignored');
  await evaluate(`window.__qaEmit('fs-changed', { workspace: 'C:/Projects/helmcode', paths: Array(100).fill('src/main.ts') });`);
  await until(`window.__qaRefreshReads.length === 1`, 'One active read for repeated file paths');
  await evaluate(`for (let i = 0; i < 100; i++) window.__qaEmit('fs-changed', { workspace: 'C:/Projects/helmcode', paths: ['src/main.ts'] }); window.__qaRefreshReads[0]('export const obsoleteRefresh = true;');`);
  await until(`window.__qaRefreshReads.length === 2`, 'Repeated events coalesce to one fresh follow-up');
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent.includes('obsoleteRefresh')`), false, 'Superseded disk response cannot replace the editor');
  await evaluate(`window.__qaRefreshReads[1]('export const latestRefresh = true;');`);
  await until(`document.querySelector('.cm-content').textContent.includes('latestRefresh')`, 'Latest disk snapshot reaches the clean editor');
  assert.equal(await evaluate(`window.__qaRefreshReads.length`), 2, 'One hundred triggers cause only two reads');
  await evaluate(`delete window.__qaReadFile; window.__qaEmit('fs-changed', { workspace: 'C:/Projects/helmcode', paths: ['src/main.ts'] });`);
  await until(`document.querySelector('.cm-content').textContent.includes('greeting')`, 'Original fixture restored');
  await evaluate(`window.__qaHoldSaveEvents = true; window.__qaOldRead = null; window.__qaReadFile = (path, text) => path === 'src/main.ts' ? new Promise(resolve => { window.__qaOldRead = resolve; }) : Promise.resolve(text); window.__qaEmit('fs-changed', { workspace: 'C:/Projects/helmcode', paths: ['src/main.ts'] });`);
  await until(`!!window.__qaOldRead`, 'Disk read pending before a clean save');
  const cleanSaves = await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').length`);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
  await until(`window.__qaCalls.filter(call => call.command === 'save_file').length > ${cleanSaves}`, 'Clean snapshot saved while old read waits');
  await pause(100);
  await evaluate(`window.__qaOldRead('export const obsoleteAfterSave = true;'); delete window.__qaReadFile; delete window.__qaHoldSaveEvents;`);
  await pause(100);
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent.includes('greeting') && !document.querySelector('.cm-content').textContent.includes('obsoleteAfterSave')`), true, 'Even an unchanged save invalidates older disk reads before watcher notification');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.insertText', { text: '// theme stays live\n' });
  await until(`document.querySelector('.cm-content').textContent.includes('theme stays live')`, 'Unsaved theme fixture');
  await evaluate(`document.querySelector('button[aria-label="Terminali"]').click()`);
  await until(`!!document.querySelector('.terminal-pane .xterm') && window.__qaCalls.some(call => call.command === 'pty_create')`, 'Theme fixture terminal');
  await evaluate(`window.__qaEditorNode = document.querySelector('.cm-content'); window.__qaTerminalNode = document.querySelector('.terminal-pane .xterm'); window.__qaThemePtyCount = window.__qaCalls.filter(call => call.command === 'pty_create').length; window.__qaEmit('pty-data', { id: document.querySelector('.terminal-pane').dataset.sessionId, data: Array.from(new TextEncoder().encode('Terminale pronto per il progetto\\r\\n')) });`);
  const openAppearance = async () => {
    await evaluate(`document.querySelector('.titlebar button[aria-label="Impostazioni"]').click()`);
    await until(`!!document.querySelector('.appearance-options')`, 'Appearance settings');
  };
  const chooseTheme = async (theme) => {
    await evaluate(`document.querySelector('[data-theme-option="${theme}"]').click()`);
    await until(`document.querySelector('[data-theme-option="${theme}"]').getAttribute('aria-pressed') === 'true'`, 'Theme selection updates');
  };
  await openAppearance();
  await chooseTheme('dark');
  await until(`document.documentElement.dataset.theme === 'dark'`, 'Live dark theme');
  await screenshot('appearance-dark-settings.png');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await screenshot('appearance-dark-editor.png');
  await openAppearance();
  await chooseTheme('light');
  await until(`document.documentElement.dataset.theme === 'light'`, 'Live light theme');
  assert.equal(await evaluate(`localStorage.getItem('helmcode.appearance.theme')`), '"light"', 'Selected appearance is stored');
  await screenshot('appearance-light-settings.png');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cm-content') === window.__qaEditorNode && document.querySelector('.cm-content').textContent.includes('theme stays live')`), true, 'Theme switching preserves the editor and unsaved content');
  assert.equal(await evaluate(`document.querySelector('.terminal-pane .xterm') === window.__qaTerminalNode && window.__qaCalls.filter(call => call.command === 'pty_create').length === window.__qaThemePtyCount`), true, 'Theme switching preserves terminal nodes and PTY sessions');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.cm-editor')).backgroundColor`), 'rgb(255, 255, 255)', 'CodeMirror uses the light canvas');
  await screenshot('appearance-light-editor.png');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click()`);
  await until(`!!document.querySelector('.branch-picker-item')`, 'Light branch menu');
  await screenshot('appearance-light-branch.png');
  await evaluate(`document.querySelector('.statusbar .branch-picker-trigger').click(); document.querySelector('.diff-toggle').click()`);
  await until(`!!document.querySelector('.git-diff tr[data-index]')`, 'Light diff');
  await screenshot('appearance-light-diff.png');
  await openAppearance();
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await chooseTheme('system');
  await until(`document.documentElement.dataset.theme === 'dark'`, 'System follows dark OS preference');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await until(`document.documentElement.dataset.theme === 'light'`, 'System follows live OS appearance changes');
  await chooseTheme('light');
  await evaluate(`document.querySelector('.modal-card button[aria-label="Chiudi"]').click()`);
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?start&noSplash&lightTheme` });
  await until(`!!document.querySelector('.start-screen') && document.documentElement.dataset.theme === 'light'`, 'Light Projects screen');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 500, deviceScaleFactor: 1, mobile: false });
  await screenshot('appearance-light-projects.png');
  await evaluate(`document.querySelector('.start-header button[aria-label="Impostazioni"]').click()`);
  await until(`!!document.querySelector('.appearance-options')`, 'Compact light appearance settings');
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('.modal-card').getBoundingClientRect(); return rect.top >= 16 && rect.bottom <= innerHeight - 16; })()`), true, 'Appearance settings fit a compact window with scrolling');
  await screenshot('appearance-light-compact-settings.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?noSplash` });
  await until(`!!document.querySelector('.activity-button')`, 'Search replacement workspace');
  await evaluate(`window.__qaReplaceText = 'needle needle';
    window.__TAURI_INTERNALS__.invoke('save_file', { path: 'notes.unknown', content: window.__qaReplaceText });
    window.__qaExtra = (command, args) => {
      if (command === 'search_files') return [];
      if (command === 'search_text') {
        if (args.options.useRegex && args.query === '[') throw new Error('Espressione regolare non valida');
        const text = args.documents.find(doc => doc.path === 'notes.unknown')?.text ?? window.__qaReplaceText;
        const results = []; let from = 0;
        while (args.query && from <= text.length) {
          const index = text.indexOf(args.query, from); if (index < 0) break;
          results.push({ path: 'notes.unknown', line: 1, column: index + 1, prefix: text.slice(0, index), matched: args.query, suffix: text.slice(index + args.query.length), replacement: args.replacement });
          from = index + args.query.length;
        }
        return results;
      }
      if (command === 'replace_text') {
        if (window.__qaFailReplace) return Promise.reject(new Error('Il file è cambiato sul disco: ricaricalo prima di sostituire.'));
        const req = args.request;
        const before = args.documents.find(doc => doc.path === 'notes.unknown')?.text ?? window.__qaReplaceText;
        const index = req.match ? req.match.column - 1 : before.indexOf(req.query);
        const count = req.match ? 1 : before.split(req.query).length - 1;
        window.__qaReplaceText = req.match ? before.slice(0, index) + req.replacement + before.slice(index + req.query.length) : before.split(req.query).join(req.replacement);
        return window.__TAURI_INTERNALS__.invoke('save_file', { path: 'notes.unknown', content: window.__qaReplaceText }).then(() => ({ count, documents: [{ path: 'notes.unknown', content: window.__qaReplaceText, savedContent: window.__qaReplaceText }] }));
      }
    };`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'R', code: 'KeyR', modifiers: 10, windowsVirtualKeyCode: 82 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'R', code: 'KeyR', modifiers: 10, windowsVirtualKeyCode: 82 });
  await until(`!!document.querySelector('input[aria-label="Sostituisci con"]') && document.activeElement?.getAttribute('aria-label') === 'Cerca nel progetto'`, 'Ctrl Shift R expands replacement and focuses search');
  const fillSearch = async (label, value) => evaluate(`(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fillSearch('Cerca nel progetto', 'needle');
  await fillSearch('Sostituisci con', 'thread');
  await until(`document.querySelectorAll('.search-result-row').length === 2 && !document.querySelector('button[aria-label="Sostituisci tutto"]').disabled`, 'Replacement results ready');
  assert.equal(await evaluate(`document.querySelector('.search-match-added').textContent`), 'thread', 'Replacement preview');
  const filenameScans = await evaluate(`window.__qaCalls.filter(call => call.command === 'search_files').length`);
  await fillSearch('Sostituisci con', 'thread-preview');
  await until(`document.querySelector('.search-match-added')?.textContent === 'thread-preview' && document.querySelector('button[aria-label="Sostituisci tutto"]')?.disabled === false`, 'Changed replacement preview ready');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'search_files').length`), filenameScans, 'Changing replacement does not rescan filenames');
  await fillSearch('Sostituisci con', 'thread');
  await until(`document.querySelector('.search-match-added')?.textContent === 'thread' && document.querySelector('button[aria-label="Sostituisci tutto"]')?.disabled === false`, 'Original replacement preview restored');
  const contentScans = await evaluate(`window.__qaCalls.filter(call => call.command === 'search_text').length`);
  await evaluate(`document.querySelector('.search-result-row > button:first-child').click()`);
  await until(`document.querySelector('.cm-content')?.textContent === 'needle needle'`, 'Open search match in editor');
  await until(`document.querySelector('.search-replace-one')?.disabled === false`, 'Replacement ready after opening editor');
  await pause(350);
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'search_text').length`), contentScans, 'Opening a clean result does not rescan project contents');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'search_files').length`), filenameScans, 'Opening a clean result does not rescan filenames');
  await screenshot('search-replace.png');
  await evaluate(`window.__qaReplacementEditor = document.querySelector('.cm-content'); void 0`);
  await evaluate(`document.querySelector('.search-replace-one').click()`);
  await until(`document.querySelector('.cm-content')?.textContent === 'thread needle' && document.querySelectorAll('.search-result-row').length === 1`, 'Single replacement refreshes editor and results');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'replace_text').at(-1).args.request.match.column`), 1, 'Single occurrence scope');
  assert.equal(await evaluate(`document.querySelector('.cm-content') === window.__qaReplacementEditor`), true, 'Replacement preserves the editor instance');
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await until(`document.querySelector('.cm-content')?.textContent === 'needle needle'`, 'Ctrl Z undoes a search replacement');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 });
  await until(`document.querySelector('.cm-content')?.textContent === 'thread needle'`, 'Ctrl Y redoes a search replacement');
  await until(`document.querySelector('button[aria-label="Sostituisci nel file notes.unknown"]')?.disabled === false`, 'File replacement ready');
  await evaluate(`document.querySelector('button[aria-label="Sostituisci nel file notes.unknown"]').click()`);
  await until(`document.querySelector('.cm-content')?.textContent === 'thread thread' && document.querySelectorAll('.search-result-row').length === 0`, 'File replacement refreshes editor');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'replace_text').at(-1).args.request.path`), 'notes.unknown', 'File replacement scope');
  await fillSearch('Cerca nel progetto', 'thread');
  await fillSearch('Sostituisci con', 'done');
  await until(`!document.querySelector('button[aria-label="Sostituisci tutto"]').disabled`, 'Global replacement ready');
  await evaluate(`document.querySelector('input[aria-label="Sostituisci con"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  await until(`document.querySelector('.cm-content')?.textContent === 'done done'`, 'Ctrl Enter replaces all');
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'replace_text').at(-1).args.request.path ?? null`), null, 'Global replacement scope');
  await evaluate(`document.querySelector('button[aria-label="Usa espressione regolare"]').click()`);
  await fillSearch('Cerca nel progetto', '[');
  await until(`document.querySelector('.sidebar-content:not([hidden])').textContent.includes('Espressione regolare non valida')`, 'Invalid regex is reported');
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Sostituisci tutto"]').disabled`), true, 'Invalid regex cannot replace');
  await evaluate(`document.querySelector('button[aria-label="Mostra sostituisci"]').click()`);
  assert.equal(await evaluate(`document.querySelector('input[aria-label="Sostituisci con"]') === null`), true, 'Replacement can be collapsed');
  await evaluate(`document.querySelector('button[aria-label="Usa espressione regolare"]').click()`);
  await fillSearch('Cerca nel progetto', 'done');
  await until(`document.querySelectorAll('.search-result-row').length === 2`, 'Literal results restored');
  await evaluate(`document.querySelector('.activity-button[aria-label="File"]').click()`);
  const hiddenScans = await evaluate(`window.__qaCalls.filter(call => call.command === 'search_text' || call.command === 'search_files').length`);
  await fillSearch('Cerca nel progetto', 'thread');
  await evaluate(`window.__qaEmit('fs-changed', { workspace: 'C:/Projects/helmcode', paths: ['notes.unknown'] })`);
  await pause(600);
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'search_text' || call.command === 'search_files').length`), hiddenScans, 'Hidden search does not scan the project after query or disk changes');
  await evaluate(`document.querySelector('.activity-button[aria-label="Cerca"]').click()`);
  await until(`document.querySelector('.sidebar-content:not([hidden])').textContent.includes('Nessun risultato.')`, 'Reopening search refreshes current query');
  await evaluate(`document.querySelector('button[aria-label="Mostra sostituisci"]').click(); window.__qaFailReplace = true;
    window.__qaOriginalSetTimeout = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => window.__qaOriginalSetTimeout(fn, delay === 500 ? 5000 : delay, ...args);`);
  await fillSearch('Cerca nel progetto', 'done');
  await until(`document.querySelector('.search-replace-one')?.disabled === false`, 'Ready to test replacement conflict');
  const savesBeforeConflict = await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').length`);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
  await send('Input.insertText', { text: ' unsaved' });
  await until(`document.querySelector('.search-replace-one')?.disabled === false && document.querySelector('.cm-content')?.textContent === 'done done unsaved'`, 'Dirty buffer preview ready');
  await evaluate(`document.querySelector('button[aria-label="Sostituisci tutto"]').click()`);
  await until(`document.querySelector('.sidebar-content:not([hidden])').textContent.includes('Sostituzione non completata')`, 'Disk conflict reported');
  await pause(700);
  assert.equal(await evaluate(`window.__qaCalls.filter(call => call.command === 'save_file').length`), savesBeforeConflict, 'Failed replacement never saves stale dirty buffers');
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent`), 'done done unsaved', 'Conflict preserves unsaved local text');
  await evaluate(`window.setTimeout = window.__qaOriginalSetTimeout; window.__qaFailReplace = false;`);
  for (const query of ['?start&noSplash', '?start&noSplash&lightTheme', '?start&noSplash&agentMode', '?start&noSplash&agentMode&lightTheme', '?start&noSplash&smallMonitor']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 500, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });
    await until(`!!document.querySelector('.start-screen') && window.__qaThemeAtShow !== undefined`, 'Projects ready before opening workspace');
    const background = query.includes('lightTheme') ? '#ffffff' : '#1e1e1e';
    assert.deepEqual(await evaluate(`window.__qaBackgroundAtShow`), { window: background, webview: background }, 'Native window and WebView match the theme before show');
    await clickText('Apri progetto');
    await until(`window.__qaCalls.some(call => call.command === 'open_workspace')`, 'Folder selected');
    await evaluate(`window.__qaEmit('workspace-changed', 'C:/Projects')`);
    await until(`window.__qaCalls.some(call => call.command === 'plugin:window|center')`, 'Workspace resize completed');
    const resizes = await evaluate(`window.__qaResizes`);
    assert.equal(resizes.length, 1, 'Expanding performs a single size change');
    assert.equal(resizes[0].cause, 'size', 'Minimum constraints never cause an intermediate expansion');
    assert.ok(resizes[0].workspaceFrames >= 1, 'Workspace has a painted frame before resizing');
    assert.equal(resizes[0].paintedScreen, 'workspace');
    assert.equal(resizes[0].splash, false);
    assert.equal(resizes[0].background, background);
    assert.deepEqual({ width: resizes[0].width, height: resizes[0].height }, query.includes('smallMonitor') ? { width: 1024, height: 576 } : { width: 1280, height: 800 });
    await evaluate(`document.querySelector('.project-switcher-toggle').click()`);
    await until(`!!document.querySelector('.project-menu-all')`, 'Project menu before returning to Projects');
    await evaluate(`document.querySelector('.project-menu-all').click()`);
    await until(`window.__qaCalls.filter(call => call.command === 'plugin:window|center').length === 2`, 'Return to Projects resized');
    const restored = await evaluate(`window.__qaResizes`);
    assert.equal(restored.length, 2);
    assert.equal(restored[1].cause, 'size');
    assert.equal(restored[1].paintedScreen, 'projects', 'Projects has a painted frame before shrinking');
    assert.deepEqual({ width: restored[1].width, height: restored[1].height }, { width: 760, height: 500 });
  }
  const result = { errors, unknownCommands: await evaluate(`window.__qaUnknown`), checks: ['helmcode two-color wordmark', 'AGENT and HELM mode labels', 'title bar at 1100px', 'full-height close target on both screens', 'close hover color', '22px activity icons and 13px file list', 'projects at 760px and 720px without horizontal overflow', 'settings fit 460px window height', 'open files', 'edit and save', 'deduplicated modified count', 'shared Git badge', 'AGENT session and HELM editor preserved', 'no nested terminal panels', 'current file Git diff', 'branch checkout', 'streamed build', 'compile warnings and source navigation', 'build results retained across views', 'Projects startup preserves window position with and without splash', 'window centers only on screen changes'] };
  result.checks.push('AGENT loading waits for visible terminal output, ignores ANSI setup and unrelated sessions', 'AGENT loading survives view switches without restarting a ready session', 'AGENT startup errors and early exits dismiss loading, retry starts a new loader');
  result.checks.push('Diff shows only the read-only diff (editor hidden) and the active tab and header mark it as read-only');
  result.checks.push('normal startup shows splash without blur or fade and respects the saved preference', 'menu windows open Projects without ever mounting splash, including with delayed startup flags');
  result.checks.push('light theme applies before first native window show', 'dark, light and live System appearance controls persist selections', 'theme switches preserve editor content and live PTY sessions', 'light editor, diff, branch menu and Projects render coherently', 'appearance settings fit compact windows');
  result.checks.push('workspace and Projects paint before native resize in HELM and AGENT, dark and light', 'native resize has no intermediate minimum-size expansion', 'window and WebView backgrounds match the theme before show and resize', 'saved window dimensions and minimums fit small HiDPI monitor work areas');
  result.checks.push('late watcher events from old workspaces cannot reload current files', 'file event bursts run only one read at a time and superseded responses cannot replace editor content');
  result.checks.push('saving an unchanged file invalidates older disk reads even before the save watcher event arrives');
  result.checks.push('file and folder type icons share colors with editor tabs', 'open and closed folder glyphs differ', 'HTML tags, attributes, strings and embedded CSS/JavaScript have syntax colors', 'Python, YAML and TOML syntax colors', 'lazy parser preserves edits and undo history', 'language switching restores TypeScript and unknown files remain plain text');
  result.checks.push('selected file has no left stroke', 'repository fetch updates upstream counts while preserving the local attention marker', 'combined Problems button opens HELM Problems from AGENT and Output');
  result.checks.push('multiple shell terminals with rename, keyboard creation and selected-session input', 'shell sessions survive panel, tab and mode changes', 'terminal close, exit, restart and empty state preserve AGENT');
  result.checks.push('recent projects panel resizes and remembers its width');
  result.checks.push('recent and created projects open directly from the Projects screen', 'recent and created projects ask for the window choice inside the editor');
  result.checks.push('Ctrl+Shift+T opens HELM terminals and focuses existing session', 'Explorer toolbar creates folders and files in selection context', 'right click creation and root context', 'duplicate creation error preserves draft');
  result.checks.push('single child folders compact into one row and stop at the first folder with two choices without opening files', 'context menu rename updates project references and open tabs', 'drag and drop moves files and folders with their descendants', 'context menu delete removes entries and closes their tabs');
  result.checks.push('trusted Explorer drag opens hovered folders and retains unsaved content', 'moves wait for active saves and never recreate the old path');
  result.checks.push('autosave writes editor changes to disk without an explicit save', 'new branch from current state or from a chosen base, carrying or stashing uncommitted changes');
  result.checks.push('Git graph opens by default from the Git section', 'Git graph hides the editor tab bar', 'Git graph shows every branch with messages, ids, authors, dates and tag references', 'Git graph renders SVG lanes and nodes, loads more commits, hides editor chrome and stays open with Escape');
  result.checks.push('clicking a commit expands its changed files and a file shows the unified commit diff, with back preserving the expansion');
  result.checks.push('Tab indents and Shift Tab unindents while retaining editor focus');
  result.checks.push('replacement previews and clean file opens reuse filename searches', 'hidden search suppresses project scans and refreshes when reopened');
  result.checks.push('search replacement preserves editor instance and supports undo and redo', 'rejected replacement preserves dirty buffers without an automatic disk write');
  result.checks.push('Java LSP completions insert snippets from unsaved text', 'Ctrl click chooses definitions on usages and implementations on declarations', 'multiple implementations, explicit navigation shortcuts and declaration context menu', 'dependency files open read only', 'missing language server explains setup and keeps local keyword completions', 'late navigation results preserve newly selected file');
  await writeFile(path.join(root, '.qa/results.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], 'Browser runtime exceptions');
  assert.deepEqual(result.unknownCommands, [], 'All desktop IPC contracts covered');
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close(); chrome.kill(); server.close();
}
