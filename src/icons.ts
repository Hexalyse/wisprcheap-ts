import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Tray icons drawn in code (a white microphone on a colored disc), written as multi-size .ico files.
 * Shapes are signed distance fields in a 32x32 design space, which gives anti-aliased edges at every size.
 */

export type IconName = 'idle' | 'recording' | 'processing' | 'paused';

const COLORS: Record<IconName, [number, number, number]> = {
  idle: [75, 85, 99], // grey
  recording: [220, 38, 38], // red
  processing: [245, 158, 11], // amber
  paused: [156, 163, 175], // light grey + slash
};

const SIZES = [16, 20, 24, 32, 40, 48, 64];

type Vec = [number, number];
const len = (x: number, y: number) => Math.hypot(x, y);

function segment(p: Vec, a: Vec, b: Vec, r: number): number {
  const [px, py] = [p[0] - a[0], p[1] - a[1]];
  const [bx, by] = [b[0] - a[0], b[1] - a[1]];
  const h = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
  return len(px - bx * h, py - by * h) - r;
}

/** Lower half of a ring (the mic holder), with round ends. */
function holder(p: Vec): number {
  const [cx, cy, radius, half] = [16, 14, 7.5, 1.25];
  if (p[1] >= cy) return Math.abs(len(p[0] - cx, p[1] - cy) - radius) - half;
  return Math.min(len(p[0] - (cx - radius), p[1] - cy), len(p[0] - (cx + radius), p[1] - cy)) - half;
}

function micDistance(p: Vec, slash: boolean): number {
  let d = Math.min(
    segment(p, [16, 9.5], [16, 14.5], 4), // capsule
    holder(p),
    segment(p, [16, 21.5], [16, 25.5], 1.25), // stem
    segment(p, [11.5, 25.8], [20.5, 25.8], 1.25), // base
  );
  if (slash) d = Math.min(d, segment(p, [8, 8], [24, 24], 1.6));
  return d;
}

function renderBgra(name: IconName, size: number): Buffer {
  const [r, g, b] = COLORS[name];
  const px = 32 / size; // design units per pixel
  const coverage = (d: number) => Math.max(0, Math.min(1, 0.5 - d / px));
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p: Vec = [(x + 0.5) * px, (y + 0.5) * px];
      const disc = coverage(len(p[0] - 16, p[1] - 16) - 15.5);
      const mic = coverage(micDistance(p, name === 'paused'));
      // ICO bitmaps are stored bottom-up.
      const i = ((size - 1 - y) * size + x) * 4;
      out[i] = Math.round(b + (255 - b) * mic);
      out[i + 1] = Math.round(g + (255 - g) * mic);
      out[i + 2] = Math.round(r + (255 - r) * mic);
      out[i + 3] = Math.round(disc * 255);
    }
  }
  return out;
}

function encodeIco(name: IconName): Buffer {
  const images = SIZES.map((size) => {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); // BITMAPINFOHEADER size
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // XOR + AND masks
    header.writeUInt16LE(1, 12); // planes
    header.writeUInt16LE(32, 14); // bpp
    const pixels = renderBgra(name, size);
    const andMask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: alpha channel is used
    header.writeUInt32LE(pixels.length + andMask.length, 20);
    return { size, data: Buffer.concat([header, pixels, andMask]) };
  });

  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

/** Write idle/recording/processing/paused .ico files into `dir` and return it. */
export function writeIcons(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(COLORS) as IconName[]) {
    writeFileSync(path.join(dir, `${name}.ico`), encodeIco(name));
  }
  return dir;
}
