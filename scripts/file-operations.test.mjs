import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/fileOperations.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { applyMutationToTabs, movedPath, pathContains } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const tab = (path, content = "original", savedContent = content) => ({ path, name: path.split("/").pop(), content, savedContent, revision: 2 });
const mutation = (data = {}) => ({ moves: [], deleted: [], documents: [], warnings: [], referencesUpdated: false, ...data });

test("folder moves remap descendant tabs on segment boundaries and keep dirty buffers", () => {
  const result = applyMutationToTabs([tab("src/java/Main.java", "unsaved", "disk"), tab("src/javascript/app.js")], mutation({
    moves: [{ oldPath: "src/java", newPath: "lib/java", isDir: true }],
    documents: [{ path: "lib/java/Main.java", content: "unsaved", savedContent: "disk" }],
  }));
  assert.equal(result[0].path, "lib/java/Main.java");
  assert.equal(result[0].content, "unsaved");
  assert.equal(result[0].savedContent, "disk");
  assert.equal(result[0].revision, 2);
  assert.equal(result[1].path, "src/javascript/app.js");
  assert.equal(pathContains("src/java", "src/javascript/app.js"), false);
});

test("semantic edits update both renamed and importing open files while preserving unsaved status", () => {
  const result = applyMutationToTabs([tab("Old.java", "class Old { /* draft */ }", "class Old {}"), tab("Use.java", "new Old();")], mutation({
    moves: [{ oldPath: "Old.java", newPath: "New.java", isDir: false }],
    documents: [
      { path: "New.java", content: "class New { /* draft */ }", savedContent: "class Old {}" },
      { path: "Use.java", content: "new New();", savedContent: "new New();" },
    ],
  }));
  assert.equal(result[0].name, "New.java");
  assert.notEqual(result[0].content, result[0].savedContent);
  assert.equal(result[0].revision, 3);
  assert.equal(result[1].content, "new New();");
  assert.equal(result[1].content, result[1].savedContent);
});

test("deletion closes descendants, keeps neighboring names and leaves external dependencies intact", () => {
  const dependency = { ...tab("C:/dependencies/Type.java"), external: true };
  const result = applyMutationToTabs([tab("src/a.ts"), tab("src-old/keep.ts"), dependency], mutation({ deleted: ["src", "C:"] }));
  assert.deepEqual(result.map((item) => item.path), ["src-old/keep.ts", "C:/dependencies/Type.java"]);
  assert.equal(result[1], dependency);
});

test("case-only file rename preserves text and maps only the exact filename", () => {
  const moves = [{ oldPath: "main.ts", newPath: "Main.ts", isDir: false }];
  assert.equal(movedPath("main.ts", moves), "Main.ts");
  assert.equal(movedPath("main.ts.backup", moves), "main.ts.backup");
  assert.equal(applyMutationToTabs([tab("main.ts")], mutation({ moves }))[0].content, "original");
});
