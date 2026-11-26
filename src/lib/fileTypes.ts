export type FileKind =
  | "file" | "html" | "css" | "javascript" | "typescript" | "react"
  | "rust" | "python" | "json" | "markdown" | "git" | "config"
  | "package" | "image" | "video" | "audio" | "archive" | "database"
  | "document" | "shell" | "c" | "cpp" | "csharp" | "java" | "go"
  | "ruby" | "php" | "vue" | "svelte" | "docker" | "font" | "license";

export type FileType = { kind: FileKind; color: string; label: string };

const types: Record<FileKind, FileType> = {
  file: { kind: "file", color: "#94A3AE", label: "File" },
  html: { kind: "html", color: "#EF8D62", label: "HTML" },
  css: { kind: "css", color: "#71B7F3", label: "CSS" },
  javascript: { kind: "javascript", color: "#E8CF6A", label: "JavaScript" },
  typescript: { kind: "typescript", color: "#69ADF1", label: "TypeScript" },
  react: { kind: "react", color: "#76CEE6", label: "React" },
  rust: { kind: "rust", color: "#D9A38B", label: "Rust" },
  python: { kind: "python", color: "#83B7E4", label: "Python" },
  json: { kind: "json", color: "#DCC77A", label: "JSON" },
  markdown: { kind: "markdown", color: "#80B9E3", label: "Markdown" },
  git: { kind: "git", color: "#ED967E", label: "Git" },
  config: { kind: "config", color: "#B4A2DB", label: "Configurazione" },
  package: { kind: "package", color: "#E8949D", label: "Pacchetto" },
  image: { kind: "image", color: "#B2A0E0", label: "Immagine" },
  video: { kind: "video", color: "#D3A0D1", label: "Video" },
  audio: { kind: "audio", color: "#E4A5B7", label: "Audio" },
  archive: { kind: "archive", color: "#C8AE7E", label: "Archivio" },
  database: { kind: "database", color: "#DBBB78", label: "Database" },
  document: { kind: "document", color: "#8EB7DC", label: "Documento" },
  shell: { kind: "shell", color: "#91C9A7", label: "Script" },
  c: { kind: "c", color: "#8DB4E2", label: "C" },
  cpp: { kind: "cpp", color: "#A2A8E8", label: "C++" },
  csharp: { kind: "csharp", color: "#AE9BDB", label: "C#" },
  java: { kind: "java", color: "#DFA17D", label: "Java" },
  go: { kind: "go", color: "#78CAD8", label: "Go" },
  ruby: { kind: "ruby", color: "#DF8D9D", label: "Ruby" },
  php: { kind: "php", color: "#AEA9DF", label: "PHP" },
  vue: { kind: "vue", color: "#8DCDAF", label: "Vue" },
  svelte: { kind: "svelte", color: "#F09A7E", label: "Svelte" },
  docker: { kind: "docker", color: "#78B8E7", label: "Docker" },
  font: { kind: "font", color: "#BAA4D8", label: "Carattere" },
  license: { kind: "license", color: "#D5BE83", label: "Licenza" },
};

const extensions: Record<string, FileKind> = {
  html: "html", htm: "html", xhtml: "html", xml: "html", xsl: "html", xsd: "html",
  css: "css", scss: "css", sass: "css", less: "css",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react", jsx: "react",
  rs: "rust", py: "python", pyw: "python", pyi: "python", ipynb: "python",
  json: "json", jsonc: "json", json5: "json", geojson: "json",
  md: "markdown", mdx: "markdown", markdown: "markdown", rst: "markdown",
  yaml: "config", yml: "config", toml: "config", ini: "config", cfg: "config", conf: "config", properties: "config", editorconfig: "config",
  lock: "package", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", svg: "image", ico: "image", icns: "image", bmp: "image", tiff: "image",
  mp4: "video", webm: "video", mov: "video", avi: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio",
  zip: "archive", gz: "archive", tar: "archive", tgz: "archive", rar: "archive", "7z": "archive", bz2: "archive", xz: "archive",
  sql: "database", db: "database", sqlite: "database", sqlite3: "database", csv: "database", tsv: "database",
  pdf: "document", doc: "document", docx: "document", odt: "document", rtf: "document", txt: "document", log: "document",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", psm1: "shell", psd1: "shell", bat: "shell", cmd: "shell",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", cs: "csharp", java: "java", class: "java", kt: "java", kts: "java",
  go: "go", rb: "ruby", rake: "ruby", php: "php", vue: "vue", svelte: "svelte", woff: "font", woff2: "font", ttf: "font", otf: "font",
};

function filename(path: string): string {
  const clean = path.startsWith("jdt://") ? path.split(/[?#]/, 1)[0] : path;
  return clean.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
}

export function getFileType(path: string): FileType {
  if (path.startsWith("jdt://")) return types.java;
  const name = filename(path);
  if (name.startsWith(".git") || name === ".mailmap") return types.git;
  if (/^(dockerfile(?:\..*)?|compose\.ya?ml|docker-compose(?:\..*)?\.ya?ml|\.dockerignore)$/.test(name)) return types.docker;
  if (/^(license|licence|copying)(\.|$)/.test(name)) return types.license;
  if (/^(package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|gemfile(?:\.lock)?|requirements(?:-.*)?\.txt|go\.(mod|sum))$/.test(name)) return types.package;
  if (name === "cargo.toml") return types.rust;
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/.test(name)) return { ...types.config, color: types.typescript.color };
  if (/^(readme|changelog|contributing|authors)(\.|$)/.test(name)) return types.markdown;
  if (name === ".env" || name.startsWith(".env.") || name === ".editorconfig" || name.endsWith("rc")) return types.config;
  if (name === "makefile" || name === "justfile" || name === "cmakelists.txt") return types.shell;
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return types[Object.hasOwn(extensions, extension) ? extensions[extension] : "file"];
}

export type FolderKind = "folder" | "folder-source" | "folder-components" | "folder-public" | "folder-assets" | "folder-scripts" | "folder-git" | "folder-rust" | "folder-tests" | "folder-package" | "folder-docs" | "folder-config" | "folder-build";
export type FolderType = { kind: FolderKind; color: string; label: string };

const folders: Record<string, FolderType> = Object.create(null);
function folder(names: string[], kind: FolderKind, color: string, label: string) {
  for (const name of names) folders[name] = { kind, color, label };
}
folder(["src", "source", "lib", "app", "pages", "routes"], "folder-source", "#83B9E6", "Sorgenti");
folder(["components", "widgets", "ui"], "folder-components", "#80CDD9", "Componenti");
folder(["public", "static", "www"], "folder-public", "#8DCBAF", "Risorse pubbliche");
folder(["assets", "images", "img", "icons", "fonts", "media", "screenshots", "screenshot"], "folder-assets", "#B4A1DD", "Risorse grafiche");
folder(["scripts", "bin", "tools"], "folder-scripts", "#D6BE7A", "Script");
folder([".git", ".github", ".gitlab", ".husky"], "folder-git", "#E59B84", "Git");
folder(["src-tauri", "rust", "native"], "folder-rust", "#D6A48F", "Codice nativo");
folder(["test", "tests", "__tests__", "spec", "specs", "e2e", "fixtures"], "folder-tests", "#9CCC92", "Test");
folder(["node_modules", "vendor", "packages"], "folder-package", "#C2B08A", "Dipendenze");
folder(["docs", "doc", "documentation"], "folder-docs", "#82B6D9", "Documentazione");
folder([".vscode", ".idea", "config", "configs", ".config"], "folder-config", "#B5A1D9", "Configurazione");
folder(["dist", "build", "target", "out", "release", "coverage"], "folder-build", "#D3AE7E", "Output");

export function getFolderType(path: string): FolderType {
  return folders[filename(path)] ?? { kind: "folder", color: "#C9B384", label: "Cartella" };
}
