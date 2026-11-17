import { isolateHistory } from "@codemirror/commands";
import { Annotation, type Text, type TransactionSpec } from "@codemirror/state";

export const externalTextChange = Annotation.define<boolean>();

/** Update the changed span without replacing the editor or merging with earlier typing. */
export function externalTextTransaction(doc: Text, content: string): TransactionSpec | null {
  // CodeMirror's document stores line breaks as LF, including files read as CRLF.
  content = content.replace(/\r\n?/g, "\n");
  const before = doc.toString();
  if (before === content) return null;
  let from = 0;
  const length = Math.min(before.length, content.length);
  while (from < length && before.charCodeAt(from) === content.charCodeAt(from)) from++;
  let oldEnd = before.length;
  let newEnd = content.length;
  while (oldEnd > from && newEnd > from && before.charCodeAt(oldEnd - 1) === content.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return {
    changes: { from, to: oldEnd, insert: content.slice(from, newEnd) },
    annotations: [externalTextChange.of(true), isolateHistory.of("full")],
  };
}
