import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const GLYPH = ["11110", "10001", "10001", "11110", "10000", "10000", "10000"];

const BACKGROUND = [0x17, 0x17, 0x17, 0xff];
const FOREGROUND = [0xfa, 0xfa, 0xfa, 0xff];

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function icon(size, masked) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      pixels[offset] = BACKGROUND[0];
      pixels[offset + 1] = BACKGROUND[1];
      pixels[offset + 2] = BACKGROUND[2];
      pixels[offset + 3] = BACKGROUND[3];
    }
  }

  const scale = Math.max(1, Math.floor(size * (masked ? 0.048 : 0.08)));
  const glyphWidth = GLYPH[0].length * scale;
  const glyphHeight = GLYPH.length * scale;
  const startX = Math.floor((size - glyphWidth) / 2);
  const startY = Math.floor((size - glyphHeight) / 2);

  for (let row = 0; row < GLYPH.length; row++) {
    for (let column = 0; column < GLYPH[row].length; column++) {
      if (GLYPH[row][column] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = startX + column * scale + dx;
          const y = startY + row * scale + dy;
          const offset = (y * size + x) * 4;
          pixels[offset] = FOREGROUND[0];
          pixels[offset + 1] = FOREGROUND[1];
          pixels[offset + 2] = FOREGROUND[2];
          pixels[offset + 3] = FOREGROUND[3];
        }
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outputDir = resolve(process.cwd(), "public", "icons");
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "icon-192.png"), icon(192, false));
await writeFile(resolve(outputDir, "icon-512.png"), icon(512, false));
await writeFile(resolve(outputDir, "icon-512-maskable.png"), icon(512, true));
console.log(`Wrote icons to ${dirname(resolve(outputDir, "icon-192.png"))}`);
