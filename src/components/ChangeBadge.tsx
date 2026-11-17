export function ChangeBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span className={`change-badge ${className}`} aria-label={`${count} file modificati`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
