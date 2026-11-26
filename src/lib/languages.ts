import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

// JSON with comments is common in editor and tool configuration files.
// An expression parser also accepts comments and trailing commas without
// treating the root object as a JavaScript block.
const jsonWithComments = LanguageDescription.of({
  name: "JSON con commenti",
  load: () => import("@codemirror/lang-javascript").then(({ javascriptLanguage }) =>
    new LanguageSupport(javascriptLanguage.configure({ top: "SingleExpression" }))),
});

const markdown = LanguageDescription.of({
  name: "Markdown",
  load: () => import("@codemirror/lang-markdown").then((module) =>
    module.markdown({ codeLanguages: languages })),
});

const byName = (name: string) => LanguageDescription.matchLanguageName(languages, name, false);

/** Resolve language metadata without downloading a parser until a file opens. */
export function getLanguageDescription(path: string): LanguageDescription | null {
  if (path.startsWith("jdt://")) return byName("Java");
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (lower.endsWith(".class")) return byName("Java");

  if (/\.(jsonc|json5|code-workspace)$/.test(lower) ||
      /^(tsconfig|jsconfig)(\..+)?\.json$/.test(lower) ||
      /^\.(eslintrc|babelrc|prettierrc)(\.json)?$/.test(lower)) return jsonWithComments;
  if (/\.(md|markdown|mkd)$/.test(lower)) return markdown;
  if (/^dockerfile(?:\..+)?$/.test(lower) || lower === "containerfile") return byName("Dockerfile");
  if (/^\.env(?:\..+)?$/.test(lower) ||
      /^\.(bashrc|bash_profile|bash_login|zshrc|zprofile|profile)$/.test(lower) ||
      /\.zsh$/.test(lower)) return byName("Shell");
  if ([".editorconfig", ".npmrc", ".yarnrc", ".gitconfig", ".gitmodules"].includes(lower)) {
    return byName("Properties files");
  }

  return LanguageDescription.matchFilename(languages, name) ??
    LanguageDescription.matchFilename(languages, lower);
}

export function languageName(path: string): string {
  return getLanguageDescription(path)?.name ?? "Testo semplice";
}

// ponytail: smallest indent wins; upgrade to a histogram if mixed files misalign.
export function detectIndentUnit(text: string): string {
  let spaces = Infinity;
  for (const line of text.split("\n")) {
    if (/^\t+\S/.test(line)) return "\t";
    const match = /^( +)\S/.exec(line);
    if (match) spaces = Math.min(spaces, match[1].length);
  }
  return spaces >= 2 && spaces <= 8 ? " ".repeat(spaces) : "  ";
}
