import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const MONO_FONT =
  '"Cascadia Code", "Consolas", ui-monospace, monospace';

const view = EditorView.theme(
  {
    "&": {
      color: "var(--text, #f0f0f0)",
      backgroundColor: "var(--color-canvas, #1e1e1e)",
      height: "100%",
      fontSize: "14px",
    },
    ".cm-content": {
      fontFamily: MONO_FONT,
      caretColor: "var(--text, #f0f0f0)",
      padding: "14px 0 64px",
      lineHeight: "1.7",
    },
    ".cm-scroller": {
      fontFamily: MONO_FONT,
      overflow: "auto",
    },
    ".cm-gutters": {
      backgroundColor: "var(--color-canvas, #1e1e1e)",
      color: "var(--muted, #a6a6a6)",
      border: "none",
      paddingLeft: "8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--editor-active-line, rgba(255,255,255,.06))",
      color: "var(--text, #f0f0f0)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--editor-active-line, rgba(255,255,255,.04))",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection, rgba(255,255,255,.10))",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--text, #f0f0f0)",
      borderLeftWidth: "2px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--color-elevated, #2d2d2d)",
      border: "1px solid var(--border, rgba(255,255,255,.08))",
      color: "var(--syntax-keyword, #c5a3e8)",
    },
    ".cm-panels": {
      backgroundColor: "var(--color-surface, #252526)",
      color: "var(--secondary, #d4d4d4)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--search-match, rgba(78,149,255,.25))",
      outline: "1px solid var(--search-match-border, rgba(78,149,255,.45))",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--selection, rgba(255,255,255,.18))",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--color-elevated, #2d2d2d)",
      border: "1px solid var(--border, rgba(255,255,255,.08))",
      borderRadius: "6px",
      color: "var(--text, #f0f0f0)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--selection, rgba(255,255,255,.10))",
      color: "var(--text, #f0f0f0)",
    },
    ".cm-lintRange-error": {
      backgroundImage: "none",
      borderBottom: "1px wavy var(--danger, #f87171)",
    },
    ".cm-lintRange-warning": {
      backgroundImage: "none",
      borderBottom: "1px wavy var(--warning, #f5c97b)",
    },
    ".cm-diagnostic": {
      fontFamily: MONO_FONT,
      padding: "4px 8px",
    },
    ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger, #f87171)" },
    ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning, #f5c97b)" },
    ".cm-diagnostic-info": { borderLeft: "3px solid var(--syntax-tag, #72b7e8)" },
  },
);

export const helmcodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "var(--syntax-keyword, #c5a3e8)" },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: "var(--syntax-string, #b8cf9a)" },
  { tag: t.regexp, color: "var(--syntax-regexp, #dfa389)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number, #d8b58c)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syntax-comment, #969696)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function, #dcdcaa)" },
  { tag: [t.typeName, t.className, t.definition(t.typeName)], color: "var(--syntax-type, #78cab4)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syntax-punctuation, #d4d4d4)" },
  { tag: [t.propertyName, t.attributeName, t.variableName], color: "var(--syntax-property, #9cdcfe)" },
  { tag: t.name, color: "var(--text, #f0f0f0)" },
  { tag: t.tagName, color: "var(--syntax-tag, #72b7e8)" },
  { tag: [t.meta, t.annotation], color: "var(--syntax-keyword, #c5a3e8)" },
  { tag: t.heading, color: "var(--syntax-tag, #72b7e8)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--syntax-tag, #72b7e8)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--syntax-string, #b8cf9a)" },
  { tag: t.inserted, color: "var(--syntax-string, #b8cf9a)" },
  { tag: t.deleted, color: "var(--syntax-deleted, #e8a09b)" },
  { tag: [t.invalid], color: "var(--danger, #f87171)" },
]);

export const helmcodeTheme: Extension = [view, syntaxHighlighting(helmcodeHighlight)];

