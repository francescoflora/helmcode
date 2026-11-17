import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { history, undo, redo, undoDepth } from "@codemirror/commands";

const source = readFileSync(new URL("../src/lib/editorChanges.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/(["'])(@codemirror\/[^"']+)\1/g,
  (_match, _quote, name) => JSON.stringify(import.meta.resolve(name)));
const { externalTextTransaction } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("search replacements preserve prior typing history and undo independently", () => {
  let state = EditorState.create({ doc: "foo", extensions: [history()] });
  state = state.update({ changes: { from: 3, insert: " foo" } }).state;
  state = state.update(externalTextTransaction(state.doc, "bar foo")).state;
  state = state.update(externalTextTransaction(state.doc, "bar bar")).state;
  assert.equal(undoDepth(state), 3);
  const target = { get state() { return state; }, dispatch: transaction => { state = transaction.state; } };
  for (const expected of ["bar foo", "foo foo", "foo"]) {
    assert.equal(undo(target), true);
    assert.equal(state.doc.toString(), expected);
  }
  for (const expected of ["foo foo", "bar foo", "bar bar"]) {
    assert.equal(redo(target), true);
    assert.equal(state.doc.toString(), expected);
  }
});

test("replacement maps a selection outside its span and skips identical updates", () => {
  let state = EditorState.create({ doc: "start foo end", selection: { anchor: 12 }, extensions: [history()] });
  state = state.update(externalTextTransaction(state.doc, "start longer end")).state;
  assert.equal(state.selection.main.anchor, 15);
  assert.equal(externalTextTransaction(state.doc, "start longer end"), null);
  assert.equal(undoDepth(state), 1);
});

test("replacement and undo preserve Unicode with normalized editor line endings", () => {
  const before = "😀café\r\n😀end";
  let state = EditorState.create({ doc: before, extensions: [history()] });
  assert.equal(externalTextTransaction(state.doc, before), null);
  state = state.update(externalTextTransaction(state.doc, "😃caffè\n😀end")).state;
  assert.equal(state.doc.toString(), "😃caffè\n😀end");
  const target = { get state() { return state; }, dispatch: transaction => { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), "😀café\n😀end");
});
