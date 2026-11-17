const formatter = new Intl.RelativeTimeFormat("it-IT", { numeric: "always" });

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** Italian relative label for an ISO date, e.g. "23 ore fa"; empty when the date is missing/invalid. */
export function relativeTime(iso: string, now = Date.now()): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = (time - now) / 1000;
  if (Math.abs(seconds) < 60) return "adesso";
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds), "second");
}
