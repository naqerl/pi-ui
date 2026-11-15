import { createHash } from "node:crypto";
import type { Context } from "hono";

/** A strong ETag for the exact bytes a response will carry. */
export function etagForBody(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

export function etagForJson(value: unknown): string {
  return etagForBody(JSON.stringify(value));
}

/** `If-None-Match` is a comma-separated list and may use the weak `W/` prefix. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.trim().length === 0) return false;
  const expected = etag.replace(/^W\//, "");
  return header.split(",").some((part) => {
    const value = part.trim();
    return value === "*" || value.replace(/^W\//, "") === expected;
  });
}

/**
 * Sends a JSON body with its ETag. An unchanged representation is answered
 * with 304 and no body, so a poll costs headers instead of a megabyte.
 */
export function sendJsonWithEtag(c: Context, body: string, etag: string): Response {
  c.header("ETag", etag);
  c.header("Cache-Control", "no-store");
  if (matchesEtag(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.body(body, 200, { "Content-Type": "application/json; charset=utf-8" });
}
