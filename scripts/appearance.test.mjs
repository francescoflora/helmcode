import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function environment(initial = {}, systemDark = true) {
  const store = new Map(Object.entries(initial));
  const listeners = new Map();
  const mediaListeners = new Set();
  const root = { dataset: {}, style: {} };
  const meta = { content: "", setAttribute(_name, value) { this.content = value; } };
  const scheme = {
    matches: systemDark,
    addEventListener(_name, callback) { mediaListeners.add(callback); },
    removeEventListener(_name, callback) { mediaListeners.delete(callback); },
  };
  const localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const window = {
    localStorage,
    matchMedia: () => scheme,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) ?? []) callback(event); },
  };
  const context = vm.createContext({ window, document: { documentElement: root, querySelector: () => meta }, localStorage, matchMedia: window.matchMedia, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  const modules = new Map();
  const load = (name) => {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    modules.set(name, exports);
    vm.runInContext(`(function(require, exports) { ${compiled}\n })`, context)((dependency) => load(dependency.replace(/^\.\//, "")), exports);
    return exports;
  };
  return { store, root, meta, window, context, load, setSystem(dark) { scheme.matches = dark; for (const callback of mediaListeners) callback(); } };
}

test("theme defaults preserve dark and invalid stored values cannot apply an unknown theme", () => {
  const env = environment({ "helmcode.appearance.theme": '"invalid"' }, false);
  const appearance = env.load("appearance");
  assert.equal(appearance.readThemePreference(), "dark");
  assert.equal(appearance.applyTheme(), "dark");
  assert.equal(env.root.dataset.theme, "dark");
  assert.equal(appearance.resolveTheme("light", true), "light");
  assert.equal(appearance.resolveTheme("system", false), "light");
  assert.equal(appearance.resolveTheme("system", true), "dark");
  env.store.set("helmcode.appearance.theme", "invalid JSON");
  assert.equal(appearance.readThemePreference(), "dark");
});

test("theme preferences round-trip through settings and reset to the established dark default", () => {
  const env = environment();
  const prefs = env.load("prefs");
  prefs.savePref("theme", "light");
  assert.equal(env.store.get("helmcode.appearance.theme"), '"light"');
  assert.equal(prefs.loadPrefs().theme, "light");
  prefs.savePref("theme", "system");
  assert.equal(prefs.loadPrefs().theme, "system");
  assert.equal(prefs.resetPrefs().theme, "dark");
  assert.equal(prefs.loadPrefs().theme, "dark");
});

test("live subscribers see the applied palette and cleanup stops notifications", () => {
  const env = environment();
  const appearance = env.load("appearance");
  const seen = [];
  const unsubscribe = appearance.subscribeTheme((theme) => seen.push([theme, env.root.dataset.theme, env.root.style.colorScheme]));
  appearance.applyTheme("light");
  assert.deepEqual(seen, [["light", "light", "light"]]);
  assert.equal(env.meta.content, "#ffffff");
  unsubscribe();
  appearance.applyTheme("dark");
  assert.equal(seen.length, 1);
});

test("System follows OS changes while explicit themes stay fixed and storage updates sync windows", () => {
  const env = environment({ "helmcode.appearance.theme": '"system"' }, false);
  const appearance = env.load("appearance");
  const stop = appearance.startAppearance();
  assert.equal(env.root.dataset.theme, "light");
  env.setSystem(true);
  assert.equal(env.root.dataset.theme, "dark");
  env.store.set("helmcode.appearance.theme", '"light"');
  env.window.dispatchEvent({ type: "storage", key: "helmcode.appearance.theme" });
  assert.equal(env.root.dataset.theme, "light");
  env.setSystem(true);
  assert.equal(env.root.dataset.theme, "light");
  env.store.delete("helmcode.appearance.theme");
  env.window.dispatchEvent({ type: "storage", key: null });
  assert.equal(env.root.dataset.theme, "dark");
  stop();
  env.store.set("helmcode.appearance.theme", '"light"');
  env.window.dispatchEvent({ type: "storage", key: "helmcode.appearance.theme" });
  assert.equal(env.root.dataset.theme, "dark");
});

test("HTML bootstrap applies a saved light or system theme before the React module runs", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(bootstrap, "theme bootstrap must be inline before application startup");
  assert.ok(html.indexOf(bootstrap) < html.indexOf('type="module"'));
  for (const preference of ["light", "system"]) {
    const env = environment({ "helmcode.appearance.theme": JSON.stringify(preference) }, false);
    vm.runInContext(bootstrap, env.context);
    assert.equal(env.root.dataset.theme, "light");
    assert.equal(env.root.style.colorScheme, "light");
  }
});

test("appearance remains usable when saving browser preferences is unavailable", () => {
  const env = environment({}, true);
  env.window.localStorage.setItem = () => { throw new Error("storage disabled"); };
  const appearance = env.load("appearance");
  const prefs = env.load("prefs");
  const seen = [];
  appearance.startAppearance();
  appearance.subscribeTheme((theme, preference) => seen.push([theme, preference]));
  prefs.savePref("theme", "system");
  appearance.applyTheme("system");
  env.setSystem(false);
  assert.deepEqual(seen, [["dark", "system"], ["light", "system"]]);
});
