import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaRef } from "../shared/types.js";

/** Image types every image-capable provider accepts. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

const ID_PATTERN = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export class MediaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415,
  ) {
    super(message);
  }
}

function mimeOf(id: string): string | undefined {
  const ext = id.slice(id.lastIndexOf(".") + 1);
  return Object.entries(MEDIA_TYPES).find(([, value]) => value === ext)?.[0];
}

/**
 * Content-addressed image files in `DATA_DIR/media`. An id is a hash of the bytes plus the
 * extension, so the same image saved twice is one file and an id can be checked without I/O.
 */
export class MediaStore {
  private readonly known = new Map<string, string>();

  constructor(private readonly dir: string) {}

  isId(id: string): boolean {
    return ID_PATTERN.test(id);
  }

  async save(bytes: Uint8Array, mimeType: string): Promise<MediaRef> {
    const ext = MEDIA_TYPES[mimeType];
    if (ext === undefined) {
      throw new MediaError("Only PNG, JPEG, GIF and WebP images can be attached", 415);
    }
    if (bytes.byteLength === 0) throw new MediaError("The image is empty", 400);
    // A non-image in the transcript would make every later model request fail.
    if (!matchesSignature(bytes, mimeType)) {
      throw new MediaError(`The file is not a valid ${ext.toUpperCase()} image`, 400);
    }
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new MediaError(`An image can be at most ${MAX_MEDIA_BYTES / 1024 / 1024} MB`, 413);
    }
    const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    const path = join(this.dir, id);
    if (!(await exists(path))) {
      await mkdir(this.dir, { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, path);
    }
    return { id, mimeType };
  }

  /** The bytes and type for an id, or a 404 MediaError. */
  async read(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const mimeType = this.isId(id) ? mimeOf(id) : undefined;
    if (mimeType === undefined) throw new MediaError("Unknown attachment", 404);
    try {
      return { bytes: await readFile(join(this.dir, id)), mimeType };
    } catch {
      throw new MediaError("Unknown attachment", 404);
    }
  }

  /** Model image blocks for ids, in order. Rejects an unknown id. */
  async images(
    ids: readonly string[],
  ): Promise<{ type: "image"; data: string; mimeType: string }[]> {
    const blocks = [];
    for (const id of ids) {
      const { bytes, mimeType } = await this.read(id);
      blocks.push({ type: "image" as const, data: bytes.toString("base64"), mimeType });
    }
    return blocks;
  }

  /**
   * The id for an image block already in the conversation, writing the file when it is missing so
   * the transcript can always show it. Cached by the base64 text, which the entry keeps.
   */
  refFor(data: string, mimeType: string): MediaRef | undefined {
    const ext = MEDIA_TYPES[mimeType];
    if (ext === undefined) return undefined;
    const cached = this.known.get(data);
    if (cached !== undefined) return { id: cached, mimeType };
    const bytes = Buffer.from(data, "base64");
    const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    this.known.set(data, id);
    void this.save(bytes, mimeType).catch((error) => {
      console.warn(`[pi] could not keep attachment ${id}: ${String(error)}`);
    });
    return { id, mimeType };
  }
}

/** Attachment ids from a request body field, or a MediaError. */
export function parseAttachmentIds(store: MediaStore, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new MediaError("attachments must be a list of ids", 400);
  }
  if (value.length > MAX_ATTACHMENTS) {
    throw new MediaError(`At most ${MAX_ATTACHMENTS} images can be attached`, 400);
  }
  for (const id of value) if (!store.isId(id)) throw new MediaError("Unknown attachment", 400);
  return [...new Set(value)];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** The file's magic bytes agree with its declared type. */
function matchesSignature(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}
