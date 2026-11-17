import type { ReactNode } from "react";
import { getFileType, getFolderType, type FileKind, type FolderKind } from "../lib/fileTypes";
import "./file-icon-theme.css";

type Props = {
  path: string;
  isDir?: boolean;
  open?: boolean;
  className?: string;
};

/** Shared file identity in Explorer, editor tabs, search and Git. */
export function FileTypeIcon({ path, isDir = false, open = false, className = "" }: Props) {
  const type = isDir ? getFolderType(path) : getFileType(path);
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ color: `var(--file-${type.kind}, ${type.color})` }} className={className} aria-hidden="true" focusable="false" data-file-kind={type.kind}>
      {isDir ? <FolderGlyph kind={type.kind as FolderKind} open={open} /> : fileGlyph(type.kind as FileKind)}
    </svg>
  );
}

function FileOutline({ children }: { children?: ReactNode }) {
  return <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" /><path d="M14 3v5h5" />{children}</>;
}

function Monogram({ text }: { text: string }) {
  return <><rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" stroke="none" /><text x="12" y="16.2" textAnchor="middle" fill="var(--file-monogram-ink, #17202A)" stroke="none" fontFamily="Segoe UI, sans-serif" fontSize={text.length > 2 ? "8.5" : "10.5"} fontWeight="750">{text}</text></>;
}

function fileGlyph(kind: FileKind): ReactNode {
  switch (kind) {
    case "html": return <><path d="m4 3 1.5 16L12 21l6.5-2L20 3H4Z" fill="currentColor" fillOpacity=".12" /><path d="m10 8-3 4 3 3m4-7 3 4-3 3" /></>;
    case "css": return <><path d="m4 3 1.5 16L12 21l6.5-2L20 3H4Z" fill="currentColor" fillOpacity=".12" /><path d="M9 7 8 16m7-9-1 9M7 10h10M7 14h9" /></>;
    case "javascript": return <Monogram text="JS" />;
    case "typescript": return <Monogram text="TS" />;
    case "react": return <><ellipse cx="12" cy="12" rx="10" ry="3.7" strokeWidth="1.4" /><ellipse cx="12" cy="12" rx="10" ry="3.7" strokeWidth="1.4" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="3.7" strokeWidth="1.4" transform="rotate(120 12 12)" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /></>;
    case "rust": return <><circle cx="12" cy="12" r="8" strokeWidth="2.2" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /><text x="12" y="16" fill="currentColor" stroke="none" textAnchor="middle" fontFamily="Segoe UI, sans-serif" fontSize="11" fontWeight="700">R</text></>;
    case "python": return <><path d="M12 2C7 2 6 3 6 6v3h8v2H5c-3 0-3 7 0 7h3v-4h8V5c0-2-1-3-4-3Z" fill="var(--file-python-blue, #83B7E4)" stroke="none" /><path d="M12 22c5 0 6-1 6-4v-3h-8v-2h9c3 0 3-7 0-7h-3v4H8v9c0 2 1 3 4 3Z" fill="var(--file-python-gold, #E8CF6A)" stroke="none" /><circle cx="10" cy="5.5" r="1" fill="#17202A" stroke="none" /><circle cx="14" cy="18.5" r="1" fill="#17202A" stroke="none" /></>;
    case "json": return <><path d="M8 3H6v6l-3 3 3 3v6h2m8-18h2v6l3 3-3 3v6h-2" /><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" /></>;
    case "markdown": return <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M5 15V9l3 3 3-3v6m6-6v6m-2-2 2 2 2-2" /></>;
    case "git": return <><path d="m12 2 10 10-10 10L2 12 12 2Z" fill="currentColor" fillOpacity=".12" /><path d="m7 7 10 10m-7-7v7" /><circle cx="10" cy="10" r="1.3" fill="currentColor" /><circle cx="17" cy="17" r="1.3" fill="currentColor" /><circle cx="10" cy="17" r="1.3" fill="currentColor" /></>;
    case "config": return <><path d="m9.5 3-.7 2.3-2 .9-2.1-.4-2 3.4 1.6 1.8v2l-1.6 1.8 2 3.4 2.1-.4 2 .9.7 2.3h5l.7-2.3 2-.9 2.1.4 2-3.4-1.6-1.8v-2l1.6-1.8-2-3.4-2.1.4-2-.9L14.5 3h-5Z" /><circle cx="12" cy="12" r="3" /></>;
    case "package": return <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" fill="currentColor" fillOpacity=".1" /><path d="m3 7 9 5 9-5m-9 5v10M7.5 4.5l9 5V13" /></>;
    case "image": return <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>;
    case "video": return <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m10 8 6 4-6 4V8ZM3 7h3m-3 5h3m-3 5h3M18 7h3m-3 5h3m-3 5h3" /></>;
    case "audio": return <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2.5" /><ellipse cx="17" cy="16" rx="3" ry="2.5" /></>;
    case "archive": return <FileOutline><path d="M11 3v3h2v3h-2v3h2v3h-2v3h2" /></FileOutline>;
    case "database": return <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0" /></>;
    case "shell": return <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m6 9 4 3-4 3m7 1h5" /></>;
    case "c": return <Monogram text="C" />;
    case "cpp": return <Monogram text="C++" />;
    case "csharp": return <Monogram text="C#" />;
    case "java": return <><path d="M6 12h12v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-4Zm12 1h1a2 2 0 0 1 0 4h-1M10 9c-4-3 5-3 2-7M5 22h14" /></>;
    case "go": return <Monogram text="GO" />;
    case "ruby": return <><path d="m7 3-5 7 10 12L22 10l-5-7H7Z" fill="currentColor" fillOpacity=".12" /><path d="M2 10h20M7 3l-1 7 6 12 6-12-1-7M6 10l6-7 6 7" /></>;
    case "php": return <><ellipse cx="12" cy="12" rx="11" ry="8" /><text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="Segoe UI, sans-serif" fontSize="9" fontWeight="700">php</text></>;
    case "vue": return <><path d="m2 4 10 17L22 4h-5l-5 8-5-8H2Z" fill="currentColor" fillOpacity=".12" /><path d="m7 4 5 8 5-8" /></>;
    case "svelte": return <><path d="m18 6-4-3-9 6c-4 4 2 9 6 6l5-3m-10 6 4 3 9-6c4-4-2-9-6-6l-5 3" strokeWidth="2.5" /></>;
    case "docker": return <><path d="M2 12h16l3-3 1 4c-2 7-12 10-18 4l-2-5Z" fill="currentColor" fillOpacity=".12" /><path d="M5 8h4v4H5V8Zm4 0h4v4H9V8Zm4 0h4v4h-4V8Zm-4-4h4v4H9V4Z" strokeWidth="1.3" /></>;
    case "font": return <><path d="m3 20 7-17h4l7 17M6 14h12M1 20h5m12 0h5" /></>;
    case "license": return <><path d="M5 3h14v18l-7-4-7 4V3Z" fill="currentColor" fillOpacity=".1" /><circle cx="12" cy="9" r="3" /></>;
    case "document": return <FileOutline><path d="M8 12h8m-8 4h6" /></FileOutline>;
    default: return <FileOutline />;
  }
}

function FolderGlyph({ kind, open }: { kind: FolderKind; open: boolean }) {
  return <>
    <path d="M3 10V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2v-8Z" fill="currentColor" fillOpacity=".09" />
    {open && <path d="M3 11h19l-3 9H5a2 2 0 0 1-2-2v-7Z" fill="var(--color-surface, #171A1C)" />}
    {kind !== "folder" && <><circle cx="17" cy="16.5" r="5.7" fill="var(--color-surface, #171A1C)" stroke="none" /><g strokeWidth="1.55">{folderBadge(kind)}</g></>}
  </>;
}

function folderBadge(kind: FolderKind): ReactNode {
  switch (kind) {
    case "folder-source": return <path d="m15 14-2 2.5 2 2.5m4-5 2 2.5-2 2.5" />;
    case "folder-components": return <><rect x="13" y="12.5" width="3" height="3" rx=".5" /><rect x="18" y="12.5" width="3" height="3" rx=".5" /><rect x="13" y="17.5" width="3" height="3" rx=".5" /><rect x="18" y="17.5" width="3" height="3" rx=".5" /></>;
    case "folder-public": return <><circle cx="17" cy="16.5" r="4.5" /><path d="M12.5 16.5h9M17 12c-3 3-3 6 0 9 3-3 3-6 0-9Z" strokeWidth="1.2" /></>;
    case "folder-assets": return <><rect x="12.5" y="12" width="9" height="9" rx="1" /><path d="m13 19 3-3 2 2 3-4" /><circle cx="15.5" cy="14.5" r=".6" fill="currentColor" stroke="none" /></>;
    case "folder-scripts": return <path d="m13 13.5 3 3-3 3m5 0h3" />;
    case "folder-git": return <><path d="M14 14v5m6-5v1.5a2 2 0 0 1-2 2h-4" /><circle cx="14" cy="13" r="1.4" /><circle cx="14" cy="20" r="1.4" /><circle cx="20" cy="13" r="1.4" /></>;
    case "folder-rust": return <><path d="m17 11 4.5 2.7v5.6L17 22l-4.5-2.7v-5.6L17 11Z" /><path d="M15.5 19v-5h2a1.5 1.5 0 0 1 0 3h-2m2 0 2 2" /></>;
    case "folder-tests": return <path d="m13 16.5 3 3 5-6" strokeWidth="2" />;
    case "folder-package": return <><path d="m17 11 4.5 2.5v5L17 21l-4.5-2.5v-5L17 11Zm-4.5 2.5L17 16l4.5-2.5M17 16v5" /></>;
    case "folder-docs": return <><path d="M14 12h6v9h-6v-9Zm2 3h2m-2 3h2" /></>;
    case "folder-config": return <><circle cx="17" cy="16.5" r="3.5" /><circle cx="17" cy="16.5" r="1" /><path d="M17 11v2m0 7v2M11.5 16.5h2m7 0h2M13 12.5l1.5 1.5m5 5 1.5 1.5M13 20.5l1.5-1.5m5-5 1.5-1.5" /></>;
    case "folder-build": return <path d="m15 12 6 4.5-6 4.5v-9Z" fill="currentColor" fillOpacity=".2" />;
    default: return null;
  }
}
