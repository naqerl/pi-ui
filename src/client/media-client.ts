import type { MediaRef } from "../shared/types";

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MAX_SIDE = 2048;

const MAX_BYTES = 3_500_000;

export const ATTACH_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/*";

export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

async function decode(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  };
}

export async function prepareImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Only images can be attached");
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error("This image could not be read");
  }
  try {
    const longest = Math.max(decoded.width, decoded.height);
    if (ACCEPTED.has(file.type) && longest <= MAX_SIDE && file.size <= MAX_BYTES) return file;
    const scale = Math.min(1, MAX_SIDE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This image could not be read");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob !== null && (blob.size <= MAX_BYTES || quality === 0.6)) return blob;
    }
    throw new Error("This image could not be read");
  } finally {
    decoded.close();
  }
}

export async function uploadMedia(file: File): Promise<MediaRef> {
  const blob = await prepareImage(file);
  let response: Response;
  try {
    response = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
  } catch {
    throw new Error("Upload failed");
  }
  if (!response.ok) {
    const reason = (await response.text()).trim();
    throw new Error(reason.length > 0 ? reason : "Upload failed");
  }
  return (await response.json()) as MediaRef;
}
