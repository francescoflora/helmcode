export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span data-tauri-drag-region className={`brand-name ${className}`}>
      <span data-tauri-drag-region className="brand-helm">helm</span><span data-tauri-drag-region className="brand-code">code</span>
    </span>
  );
}
