import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undoDepth } from "@codemirror/commands";

async function importSource(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(["'])(@(?:codemirror|lezer)\/[^"']+)\1/g,
    (_match, _quote, name) => JSON.stringify(import.meta.resolve(name)));
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const { helmcodeTheme } = await importSource("../src/theme.ts");
const { getTerminalTheme } = await importSource("../src/terminalTheme.ts");

test("editor color mode can change without replacing unsaved text, selection or undo history", () => {
  const mode = new Compartment();
  let state = EditorState.create({ doc: "const value = 1;", extensions: [history(), helmcodeTheme, mode.of(EditorView.darkTheme.of(true))] });
  state = state.update({ changes: { from: 14, to: 15, insert: "22" }, selection: { anchor: 16 } }).state;
  const text = state.doc, selection = state.selection, depth = undoDepth(state);
  assert.equal(depth, 1);
  for (const dark of [false, true, false]) {
    state = state.update({ effects: mode.reconfigure(EditorView.darkTheme.of(dark)) }).state;
    assert.equal(state.facet(EditorView.darkTheme), dark);
    assert.equal(state.doc, text);
    assert.equal(state.selection, selection);
    assert.equal(undoDepth(state), depth);
  }
});

function contrast(a, b) {
  const luminance = (color) => {
    const rgb = color.slice(1).match(/../g).map((hex) => parseInt(hex, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test("terminal palettes keep normal text and common ANSI foregrounds readable in both modes", () => {
  for (const scheme of ["light", "dark"]) {
    const palette = getTerminalTheme(scheme);
    for (const key of ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightWhite"]) {
      assert.ok(contrast(palette[key], palette.background) >= 4.5, `${scheme} ${key} meets 4.5:1 contrast`);
    }
    const second = getTerminalTheme(scheme);
    assert.notEqual(second, palette);
    palette.background = "#ff0000";
    assert.notEqual(second.background, palette.background);
  }
});

test("primary, secondary and muted UI text retain 4.5:1 contrast on each main surface", () => {
  const css = readFileSync(new URL("../src/palette.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/:root(?:\[data-theme="light"\])?\s*\{([^}]+)\}/g)];
  const palette = {};
  for (const block of blocks) {
    for (const [, key, value] of block[1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)) palette[key] = value;
    for (const foreground of ["--text", "--secondary", "--muted"]) {
      for (const surface of ["--color-canvas", "--color-surface", "--chrome"]) {
        assert.ok(contrast(palette[foreground], palette[surface]) >= 4.5, `${block[0].slice(0,30)} ${foreground} on ${surface}`);
      }
    }
  }
  assert.equal(blocks.length, 2);
});
