/**
 * Phase 6 — generate PWA icons (192px, 512px, 512px maskable).
 *
 * Hand-rolled PNG encoder so we don't pull in `sharp` / `@resvg/resvg-js` /
 * `pngjs` just for three boot-time-only assets. Output:
 *
 *   packages/web/public/icon-192.png         (any)
 *   packages/web/public/icon-512.png         (any)
 *   packages/web/public/icon-maskable-512.png (maskable — extra safe-area padding)
 *   packages/web/public/apple-touch-icon.png (180x180, used by iOS Add-to-Home)
 *
 * Visual: dark-slate (#0f172a) background with a centred emerald (#10b981)
 * "swarm" mark — six small dots around a central dot, evoking a coordinator
 * + workers. No anti-aliasing (the icon is small + flat, doesn't need it).
 *
 * Run with:  pnpm tsx scripts/gen-icons.ts
 *
 * The PNGs are committed to the repo — no build-time generation required.
 * Re-run only if the visual needs to change. Reproducible: same script →
 * same bytes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RGB {
  r: number;
  g: number;
  b: number;
}

const BG: RGB = { r: 0x0f, g: 0x17, b: 0x2a }; // slate-950
const FG: RGB = { r: 0x10, g: 0xb9, b: 0x81 }; // emerald-500

/** CRC table (PNG spec). Computed once. */
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode an RGB pixel buffer (size*size*3 bytes) as a minimal PNG (color
 * type 2 — truecolor, no alpha). Filter byte 0 (None) before each row.
 */
function encodePng(size: number, pixels: Buffer): Buffer {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type 2 (RGB)
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // IDAT — prepend filter byte 0 to each row
  const stride = size * 3;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fill(pixels: Buffer, size: number, color: RGB): void {
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3] = color.r;
    pixels[i * 3 + 1] = color.g;
    pixels[i * 3 + 2] = color.b;
  }
}

function setPixel(pixels: Buffer, size: number, x: number, y: number, color: RGB): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 3;
  pixels[i] = color.r;
  pixels[i + 1] = color.g;
  pixels[i + 2] = color.b;
}

function fillCircle(
  pixels: Buffer,
  size: number,
  cx: number,
  cy: number,
  r: number,
  color: RGB,
): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(pixels, size, x, y, color);
    }
  }
}

/**
 * Draw the swarm mark inside the inscribed square of side `inner` centred at
 * (cx, cy). One central dot + 6 satellite dots in a hex pattern.
 */
function drawMark(
  pixels: Buffer,
  size: number,
  cx: number,
  cy: number,
  inner: number,
  color: RGB,
): void {
  const center = inner * 0.12;
  const sat = inner * 0.08;
  const ring = inner * 0.32;
  fillCircle(pixels, size, cx, cy, center, color);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI * 2 * k) / 6 - Math.PI / 2;
    const sx = cx + Math.cos(a) * ring;
    const sy = cy + Math.sin(a) * ring;
    fillCircle(pixels, size, sx, sy, sat, color);
  }
}

function makeIcon(size: number, opts: { maskable?: boolean } = {}): Buffer {
  const pixels = Buffer.alloc(size * size * 3);
  fill(pixels, size, BG);
  // Maskable icons need a safe area: per spec, the inner 80% diameter MUST
  // contain the entire glyph. We draw a smaller mark when maskable=true.
  const innerScale = opts.maskable ? 0.55 : 0.78;
  drawMark(pixels, size, size / 2, size / 2, size * innerScale, FG);
  return encodePng(size, pixels);
}

const outDir = path.resolve(__dirname, '..', 'packages', 'web', 'public');
fs.mkdirSync(outDir, { recursive: true });

const targets: Array<{ name: string; size: number; maskable?: boolean }> = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180 },
];

for (const t of targets) {
  const buf = makeIcon(t.size, { maskable: t.maskable });
  const dst = path.join(outDir, t.name);
  fs.writeFileSync(dst, buf);
  console.log(`wrote ${dst} (${buf.length} bytes)`);
}
