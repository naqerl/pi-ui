/**
 * Time handling shared by the server and the client. The wire always carries
 * instants as UTC ISO-8601 strings (or epoch milliseconds); only a browser
 * turns one into a clock, using its own timezone at call time.
 */

export type TimestampValue = string | number | Date;

export interface TimeFormatOptions {
  /** Include seconds. Event feeds need them; message bubbles use hours and minutes. */
  seconds?: boolean;
}

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
  // Constructed per call so a test can change process.env.TZ before the call.
  return new Intl.DateTimeFormat(undefined, options);
}

/** Local `hh:mm`, or `hh:mm:ss` with `seconds`, for any parseable instant. */
export function formatTime(
  value: TimestampValue,
  options: TimeFormatOptions | boolean = {},
): string {
  const date = asDate(value);
  if (date === null) return "";
  const seconds = typeof options === "boolean" ? options : options.seconds === true;
  return formatter({
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).format(date);
}

/** A local date and time for titles and detail rows. */
export function formatDateTime(value: TimestampValue): string {
  const date = asDate(value);
  if (date === null) return "";
  return formatter({ dateStyle: "medium", timeStyle: "medium" }).format(date);
}

/**
 * Converts any accepted instant into the UTC ISO form the wire uses. Returns
 * null for a value that cannot be parsed, so callers can choose a fallback.
 */
export function toIsoTimestamp(value: TimestampValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = asDate(value);
  return date === null ? null : date.toISOString();
}
