import { HelmShape } from "./HelmShape";

interface BrandMarkProps {
  className?: string;
}

/** helmcode's approved Compatto ship's helm. */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" color="var(--accent, #9bd6bd)" aria-hidden="true">
      <rect width="64" height="64" rx="18" fill="var(--brand-tile, #1f2b26)" />
      <HelmShape />
    </svg>
  );
}
