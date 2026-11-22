import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/window.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadWindowLib(options = {}) {
  const stubs = {
    "@tauri-apps/api/dpi": { LogicalSize: class {
      constructor(width, height) { this.width = width; this.height = height; }
    } },
    "@tauri-apps/api/window": {
      getCurrentWindow: () => options.appWindow ?? {},
      currentMonitor: options.currentMonitor ?? (async () => null),
    },
    "@tauri-apps/api/webviewWindow": { getCurrentWebviewWindow: () => options.webview ?? {} },
    react: { useEffect: () => {}, useState: () => [false, () => {}] },
    "./tauri": { isTauri: () => options.native ?? false },
    "./storage": { readStored: () => options.stored ?? null, writeStored: () => {} },
  };
  const windowLib = {};
  new Function("require", "exports", "window", "requestAnimationFrame", "cancelAnimationFrame", "console", compiled)(
    (id) => stubs[id], windowLib,
    { screen: options.screen ?? { availWidth: 1920, availHeight: 1080 } },
    options.requestFrame, options.cancelFrame, { warn: () => {} },
  );
  return windowLib;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeWindow() {
  const calls = [];
  const actualResizes = [];
  let size = { width: 760, height: 500 };
  let minimum = { width: 720, height: 460 };
  const resize = (next) => {
    const target = {
      width: Math.max(minimum.width, next.width),
      height: Math.max(minimum.height, next.height),
    };
    if (target.width !== size.width || target.height !== size.height) actualResizes.push(target);
    size = target;
  };
  return {
    calls,
    actualResizes,
    appWindow: {
      isMaximized: async () => false,
      unmaximize: async () => { calls.push(["unmaximize"]); },
      setMinSize: async (next) => {
        calls.push(["minimum", next ? { ...next } : null]);
        minimum = next ?? { width: 0, height: 0 };
        resize(size);
      },
      setSize: async (next) => { calls.push(["size", { ...next }]); resize(next); },
      center: async () => { calls.push(["center"]); },
    },
  };
}

const windowLib = loadWindowLib();

test("invalid or missing workspace size falls back to the default", () => {
  assert.deepEqual(windowLib.normalizeWindowSize(null), windowLib.APP_WINDOW_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: "wide", height: NaN }), windowLib.APP_WINDOW_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: Infinity, height: 900 }), { width: 1280, height: 900 });
});

test("workspace size is clamped to the minimum and rounded", () => {
  assert.deepEqual(windowLib.normalizeWindowSize({ width: 900, height: 600 }), windowLib.APP_MIN_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: 1600.4, height: 900.6 }), { width: 1600, height: 901 });
});

test("screen changes resize directly to each target without an intermediate minimum size", async () => {
  const fixture = fakeWindow();
  const lib = loadWindowLib({ native: true, appWindow: fixture.appWindow });
  await lib.applyAppWindowSize();
  await lib.applyStartWindowSize();
  assert.deepEqual(fixture.actualResizes, [lib.APP_WINDOW_SIZE, lib.START_WINDOW_SIZE]);
  assert.deepEqual(fixture.calls.at(-2), ["minimum", lib.START_MIN_SIZE]);
});

test("overlapping screen changes finish in request order", async () => {
  const fixture = fakeWindow();
  const entered = deferred();
  const released = deferred();
  const setSize = fixture.appWindow.setSize;
  fixture.appWindow.setSize = async (size) => {
    await setSize(size);
    if (size.width === 1280) { entered.resolve(); await released.promise; }
  };
  const lib = loadWindowLib({ native: true, appWindow: fixture.appWindow });
  const workspace = lib.applyAppWindowSize();
  const projects = lib.applyStartWindowSize();
  await entered.promise;
  assert.deepEqual(fixture.calls, [["minimum", null], ["size", lib.APP_WINDOW_SIZE]]);
  released.resolve();
  await Promise.all([workspace, projects]);
  assert.deepEqual(fixture.actualResizes, [lib.APP_WINDOW_SIZE, lib.START_WINDOW_SIZE]);
  assert.deepEqual(fixture.calls.slice(2, 4), [["minimum", lib.APP_MIN_SIZE], ["center"]]);
  assert.deepEqual(fixture.calls.at(-2), ["minimum", lib.START_MIN_SIZE]);
});

test("saved dimensions and minimums fit the current monitor work area at its scale", async () => {
  const fixture = fakeWindow();
  const lib = loadWindowLib({
    native: true,
    appWindow: fixture.appWindow,
    stored: { width: 1e300, height: 1e300 },
    currentMonitor: async () => ({
      scaleFactor: 1.5,
      workArea: { size: { width: 1536, height: 900 } },
    }),
  });
  await lib.applyAppWindowSize();
  assert.deepEqual(fixture.actualResizes, [{ width: 1024, height: 600 }]);
  assert.deepEqual(fixture.calls.at(-2), ["minimum", { width: 1024, height: 600 }]);
});

test("screen bounds provide a fallback when native monitor lookup fails", async () => {
  const fixture = fakeWindow();
  const lib = loadWindowLib({
    native: true, appWindow: fixture.appWindow,
    screen: { availWidth: 960, availHeight: 640 },
    currentMonitor: async () => { throw new Error("No monitor"); },
  });
  await lib.applyAppWindowSize();
  assert.deepEqual(fixture.actualResizes, [{ width: 960, height: 640 }]);
  assert.deepEqual(fixture.calls.at(-2), ["minimum", { width: 960, height: 640 }]);
});

test("a failed resize does not block the next screen change", async () => {
  const fixture = fakeWindow();
  const setSize = fixture.appWindow.setSize;
  fixture.appWindow.setSize = async (size) => {
    if (size.width === 1280) throw new Error("Resize failed");
    await setSize(size);
  };
  const lib = loadWindowLib({ native: true, appWindow: fixture.appWindow });
  await lib.applyAppWindowSize();
  await lib.applyStartWindowSize();
  assert.deepEqual(fixture.calls.at(-2), ["minimum", lib.START_MIN_SIZE]);
  assert.deepEqual(fixture.calls.at(-1), ["center"]);
});

function frameScheduler() {
  let id = 0;
  const callbacks = new Map();
  return {
    requestFrame: (callback) => { callbacks.set(++id, callback); return id; },
    cancelFrame: (frame) => callbacks.delete(frame),
    flush: () => {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach((callback) => callback(0));
    },
  };
}

test("resize scheduling leaves a paint opportunity before calling native code", () => {
  const frames = frameScheduler();
  const lib = loadWindowLib(frames);
  let resized = false;
  lib.scheduleAfterPaint(() => { resized = true; });
  assert.equal(resized, false);
  frames.flush();
  assert.equal(resized, false);
  frames.flush();
  assert.equal(resized, true);
});

test("unmounting or changing screens cancels either pending animation frame", () => {
  for (const cancelAfterFirstFrame of [false, true]) {
    const frames = frameScheduler();
    const lib = loadWindowLib(frames);
    let resized = false;
    const cancel = lib.scheduleAfterPaint(() => { resized = true; });
    if (cancelAfterFirstFrame) frames.flush();
    cancel();
    frames.flush();
    frames.flush();
    assert.equal(resized, false);
  }
});

test("show and resize wait for the latest pending native theme and canvas", async () => {
  const fixture = fakeWindow();
  const entered = deferred();
  const released = deferred();
  const events = [];
  fixture.appWindow.setTheme = async (theme) => {
    events.push(`theme:${theme}`);
    if (theme === "light") { entered.resolve(); await released.promise; }
  };
  fixture.appWindow.show = async () => { events.push("show"); };
  const setSize = fixture.appWindow.setSize;
  fixture.appWindow.setSize = async (size) => { events.push("resize"); await setSize(size); };
  const lib = loadWindowLib({
    native: true, appWindow: fixture.appWindow,
    webview: { setBackgroundColor: async (color) => { events.push(`canvas:${color}`); } },
  });
  const light = lib.setNativeTheme("light");
  const shown = lib.showWindow();
  const resized = lib.applyAppWindowSize();
  await entered.promise;
  const dark = lib.setNativeTheme("dark");
  assert.deepEqual(events, ["theme:light"]);
  released.resolve();
  await Promise.all([light, dark, shown, resized]);
  assert.deepEqual(events.slice(0, 4), ["theme:light", "canvas:#ffffff", "theme:dark", "canvas:#1e1e1e"]);
  assert.ok(events.indexOf("show") > events.indexOf("canvas:#1e1e1e"));
  assert.ok(events.indexOf("resize") > events.indexOf("canvas:#1e1e1e"));
});

test("unsupported native theming does not prevent the window from showing", async () => {
  let shown = false;
  const lib = loadWindowLib({
    native: true,
    appWindow: {
      setTheme: async () => { throw new Error("Theme unavailable"); },
      show: async () => { shown = true; },
    },
    webview: { setBackgroundColor: async () => { throw new Error("Canvas unavailable"); } },
  });
  await lib.setNativeTheme("light");
  await lib.showWindow();
  assert.equal(shown, true);
});
