import { CharCategory } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { findWordOccurrences } from "./wordOccurrences";

const matchDecoration = Decoration.mark({ class: "cm-selectionMatch" });
const mainDecoration = Decoration.mark({ class: "cm-selectionMatch cm-selectionMatch-main" });

class WordHighlighter {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.build(view);
  }

  update(update: ViewUpdate) {
    if (update.selectionSet || update.docChanged) this.decorations = this.build(update.view);
  }

  private build(view: EditorView): DecorationSet {
    const { state } = view;
    if (state.selection.ranges.length !== 1) return Decoration.none;
    const range = state.selection.main;
    if (!range.empty) return Decoration.none;
    const word = state.wordAt(range.head);
    if (!word) return Decoration.none;
    const query = state.sliceDoc(word.from, word.to);
    if (!query) return Decoration.none;
    const categorize = state.charCategorizer(range.head);
    const occurrences = findWordOccurrences(
      state.doc.toString(),
      query,
      (char) => categorize(char) === CharCategory.Word,
      word.from,
    );
    if (!occurrences.length) return Decoration.none;
    return Decoration.set(occurrences.map((occurrence) =>
      (occurrence.main ? mainDecoration : matchDecoration).range(occurrence.from, occurrence.to)));
  }
}

export const wordHighlightExtension = ViewPlugin.fromClass(WordHighlighter, {
  decorations: (highlighter) => highlighter.decorations,
});
