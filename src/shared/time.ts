export type TimestampValue = string | number | Date;

function asDate(value: TimestampValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, options);
}

export function formatTime(value: TimestampValue): string {
  const date = asDate(value);
  if (date === null) return "";
  return formatter({
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatDateTime(value: TimestampValue): string {
  const date = asDate(value);
  if (date === null) return "";
  return formatter({ dateStyle: "medium", timeStyle: "medium" }).format(date);
}

export function formatCompactDateTime(value: TimestampValue): string {
  const date = asDate(value);
  if (date === null) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDurationMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatDay(value: TimestampValue, thisYear?: number): string {
  const date = asDate(value);
  if (date === null) return "";
  const year = thisYear === undefined || date.getFullYear() !== thisYear;
  return formatter({
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  }).format(date);
}

export function formatMonthDay(value: TimestampValue, thisYear?: number): string {
  const date = asDate(value);
  if (date === null) return "";
  const year = thisYear === undefined || date.getFullYear() !== thisYear;
  return formatter({
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  }).format(date);
}

export function toIsoTimestamp(value: TimestampValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = asDate(value);
  return date === null ? null : date.toISOString();
}
