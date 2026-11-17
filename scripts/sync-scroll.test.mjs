import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/syncScroll.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('from "react"', `from ${JSON.stringify(import.meta.resolve("react"))}`);
const { connectSyncedScroll } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

class Scroller extends EventTarget {
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 200;
  constructor(height) { super(); this.scrollHeight = height; }
  scroll(top = this.scrollTop, left = this.scrollLeft) {
    this.scrollTop = top;
    this.scrollLeft = left;
    this.dispatchEvent(new Event("scroll"));
  }
}

test("synchronizes proportional vertical and exact horizontal scroll in both directions", () => {
  const left = new Scroller(1200), right = new Scroller(2200);
  const disconnect = connectSyncedScroll(left, right);
  left.scroll(250, 80);
  assert.equal(right.scrollTop, 500);
  assert.equal(right.scrollLeft, 80);
  right.scroll(); // The browser event from the programmatic write.
  right.scroll(1500, 120);
  assert.equal(left.scrollTop, 750);
  assert.equal(left.scrollLeft, 120);
  disconnect();
  left.scroll(0, 0);
  assert.equal(right.scrollTop, 1500);
});

test("returning to a previously written position remains a real user scroll", () => {
  const left = new Scroller(1200), right = new Scroller(2200);
  const disconnect = connectSyncedScroll(left, right);
  right.scroll(500); // Writes 250 to left.
  left.scroll(); // Consume that programmatic event.
  left.scroll(500); // User moves away.
  right.scroll();
  left.scroll(250); // User returns to the old written position.
  assert.equal(right.scrollTop, 500);
  disconnect();
});

test("containers without vertical overflow still synchronize horizontal scrolling", () => {
  const left = new Scroller(200), right = new Scroller(200);
  const disconnect = connectSyncedScroll(left, right);
  left.scroll(0, 100);
  assert.equal(right.scrollTop, 0);
  assert.equal(right.scrollLeft, 100);
  disconnect();
});
