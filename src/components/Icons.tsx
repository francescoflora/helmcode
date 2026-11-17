import { HelmShape } from "./HelmShape";

type IconProps = { className?: string };

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  focusable: false,
};

export function FolderIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
    </svg>
  );
}

export function FolderOpenIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 11V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2" />
      <path d="M5 20a2 2 0 0 1-2-2v-7h18l-2.1 7.5A2 2 0 0 1 17 20H5Z" />
    </svg>
  );
}

export function FolderPickerIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
      <path d="M9 13h6m-3-3v6" />
    </svg>
  );
}

export function FilePlusIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9l-6-6Z M13 3v6h6M8 15h8m-4-4v8" /></svg>;
}

const statusBase = { ...base, width: 16, height: 16, viewBox: "0 0 16 16", strokeWidth: 1.4 };
export function StatusBranchIcon() {
  return <svg {...statusBase} aria-hidden="true"><path d="M4 5v6M12 6v1a4 4 0 0 1-4 4H4" /><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="4.5" r="1.5" /></svg>;
}
export function StatusSyncIcon({ className }: IconProps) {
  return <svg {...statusBase} className={className} aria-hidden="true"><path d="M13.5 5a6 6 0 0 0-10-1L1.5 6m0-4v4h4M2.5 11a6 6 0 0 0 10 1l2-2m0 4v-4h-4" /></svg>;
}
export function StatusErrorIcon() {
  return <svg {...statusBase} aria-hidden="true"><circle cx="8" cy="8" r="6.25" /><path d="m5.75 5.75 4.5 4.5m0-4.5-4.5 4.5" /></svg>;
}
export function StatusWarningIcon() {
  return <svg {...statusBase} aria-hidden="true"><path d="M7.1 2.3a1 1 0 0 1 1.8 0l5.3 10a1 1 0 0 1-.9 1.45H2.7a1 1 0 0 1-.9-1.45l5.3-10Z M8 5.5V9" /><circle cx="8" cy="11.5" r=".75" fill="currentColor" stroke="none" /></svg>;
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M20 8a8 8 0 0 0-13.7-2.7L3 8m0-5v5h5M4 16a8 8 0 0 0 13.7 2.7L21 16m0 5v-5h-5" />
    </svg>
  );
}

export function TerminalIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15l-1 5Z" /></svg>;
}

export function SparklesIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m12 3 1.8 4.6L18 9.5l-4.2 1.9L12 16l-1.8-4.6L6 9.5l4.2-1.9z" />
      <path d="M18.5 15.5 19.4 18l2.6.9-2.6 1L18.5 22l-.9-2.1-2.6-1 2.6-.9z" />
    </svg>
  );
}

export function RobotIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="4" y="7" width="16" height="13" rx="3" />
      <path d="M12 3v4M1 12v3m22-3v3M9 16h6" />
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HelmIcon({ className }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true" focusable="false">
      <HelmShape />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      {/* A single filled contour keeps the intersection solid at small sizes. */}
      <path d="M6.62 5.38 12 10.76l5.38-5.38a.877.877 0 0 1 1.24 1.24L13.24 12l5.38 5.38a.877.877 0 0 1-1.24 1.24L12 13.24l-5.38 5.38a.877.877 0 0 1-1.24-1.24L10.76 12 5.38 6.62a.877.877 0 0 1 1.24-1.24Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m4 12 16-8-6 16-3.5-6.5z" />
      <path d="M10.5 13.5 20 4" />
    </svg>
  );
}

export function PanelBottomIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 14h18" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m8 5 11 7-11 7z" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M10.3 4a2 2 0 0 1 3.4 0l7.7 13.5a2 2 0 0 1-1.7 3H4.3a2 2 0 0 1-1.7-3L10.3 4Z" />
      <path d="M12 9v4" />
      <circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FilesIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7l-5-5Z" />
      <path d="M15 2v5h5M4 6H3v14a2 2 0 0 0 2 2h10v-1" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
    </svg>
  );
}

export function GitBranchIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M6 7v10M18 8v2a6 6 0 0 1-6 6H6" />
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="6" r="2" />
    </svg>
  );
}

export function MergeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M6 8v11M6 8a10 10 0 0 0 10 10" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="6" cy="6" r="2" />
    </svg>
  );
}

export function CloudIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M6.5 19a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 17.8 9.5 4.25 4.25 0 0 1 17.5 18H6.5Z" />
    </svg>
  );
}

export function CloudUpIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M6.5 19a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 17.8 9.5 4.25 4.25 0 0 1 17.5 18H6.5Z" />
      <path d="M12 15v-4.5m-2.25 2.25L12 10.5l2.25 2.25" />
    </svg>
  );
}

export function CloudDownIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M6.5 19a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 17.8 9.5 4.25 4.25 0 0 1 17.5 18H6.5Z" />
      <path d="M12 10.5V15m-2.25-2.25L12 15l2.25-2.25" />
    </svg>
  );
}

export function CodeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="m13.5 4-3 16" />
    </svg>
  );
}

export function BuildIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z" />
    </svg>
  );
}

export function MinimizeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

export function SyncIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" /></svg>;
}

export function ErrorIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>;
}

export function MaximizeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </svg>
  );
}

export function RestoreIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="8" y="4" width="12" height="12" rx="1" />
      <path d="M16 16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

export function WindowIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="5" width="14" height="12" rx="2" />
      <path d="M7 19h12a2 2 0 0 0 2-2V9" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m9 3-.6 2.2-1.8 1L4.4 6 2.9 8.6l1.5 1.7v2.1l-1.5 1.7 1.5 2.6 2.2-.2 1.8 1L9 20h3l.6-2.2 1.8-1 2.2.2 1.5-2.6-1.5-1.7v-2.1l1.5-1.7L16.6 6l-2.2.2-1.8-1L12 3H9Z" transform="translate(1.5 .5)" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="m5 6 1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M10 10v7m4-7v7" />
    </svg>
  );
}

export function ArrowLeftIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="m20 4-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

export function CrosshairIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DiscardIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M3 7v6h6" />
      <path d="M3.5 13a9 9 0 1 0 2.4-9.3L3 7" />
    </svg>
  );
}

export function SunIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

export function MoonIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><path d="M20.5 13.1A8.8 8.8 0 0 1 10.9 3.5 8.8 8.8 0 1 0 20.5 13.1Z" /></svg>;
}

export function MonitorIcon({ className }: IconProps) {
  return <svg {...base} className={className} aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>;
}
