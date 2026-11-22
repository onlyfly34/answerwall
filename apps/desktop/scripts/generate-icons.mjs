// Generates build/icon.ico (the Windows application and installer icon) and
// build/icon.png (window icon) from the product's own icon,
// packages/web/public/icon.svg. Run after that file changes:
// `pnpm --filter @answerwall/desktop icons`. The output is committed; the
// build does not run this.
//
// No dependencies. The SVG consists of rounded rectangles only, which is all
// the rasteriser below understands; it stops at anything else rather than
// draw it wrongly.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const root = path.join(import.meta.dirname, '..');
const source = path.join(root, '..', '..', 'packages', 'web', 'public', 'icon.svg');
const out = path.join(root, 'build');

const SAMPLES = 4;
/** Sizes Windows asks for: title bar and task bar at every scaling, large views, the installer. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function parseSvg(text) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(text);
  if (!viewBox || viewBox[1] !== viewBox[2]) throw new Error('Expected a square viewBox at 0 0');
  const elements = [...text.matchAll(/<(\w+)\b([^>]*)\/?>/g)].filter(([, tag]) => tag !== 'svg');
  const rects = elements.map(([, tag, attributes]) => {
    if (tag !== 'rect') throw new Error(`Unsupported element <${tag}>`);
    const read = (name, fallback) => {
      const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
      if (!match && fallback === undefined) throw new Error(`<rect> without ${name}`);
      return match ? match[1] : fallback;
    };
    const fill = /^#([0-9a-f]{6})$/i.exec(read('fill'));
    if (!fill) throw new Error('Expected a #rrggbb fill');
    return {
      x: Number(read('x', '0')),
      y: Number(read('y', '0')),
      w: Number(read('width')),
      h: Number(read('height')),
      r: Number(read('rx', '0')),
      rgb: [0, 2, 4].map((at) => parseInt(fill[1].slice(at, at + 2), 16)),
    };
  });
  if (rects.length === 0) throw new Error('Nothing to draw');
  return { extent: Number(viewBox[1]), rects };
}

function inside(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
}

/** RGBA pixels, top row first, straight alpha. Later rectangles paint over earlier ones. */
function render(size, { extent, rects }) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = ((column + (sx + 0.5) / SAMPLES) / size) * extent;
          const py = ((row + (sy + 0.5) / SAMPLES) / size) * extent;
          const top = rects.findLast((rect) => inside(px, py, rect));
          if (!top) continue;
          covered += 1;
          for (let channel = 0; channel < 3; channel += 1) sum[channel] += top.rgb[channel];
        }
      }
      const offset = (row * size + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = covered === 0 ? 0 : Math.round(sum[channel] / covered);
      }
      pixels[offset + 3] = Math.round((covered / SAMPLES ** 2) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    pixels.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An icon image in the classic form every Windows tool reads: a 40-byte
 * bitmap header, 32-bit BGRA rows from the bottom up, then the 1-bit mask
 * (set where the pixel is fully transparent), its rows padded to 32 bits.
 */
function encodeDib(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows plus mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const colour = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let row = 0; row < size; row += 1) {
    const target = size - 1 - row;
    for (let column = 0; column < size; column += 1) {
      const from = (row * size + column) * 4;
      const to = (target * size + column) * 4;
      colour[to] = pixels[from + 2];
      colour[to + 1] = pixels[from + 1];
      colour[to + 2] = pixels[from];
      colour[to + 3] = pixels[from + 3];
      if (pixels[from + 3] === 0) mask[target * maskStride + (column >> 3)] |= 0x80 >> (column & 7);
    }
  }
  return Buffer.concat([header, colour, mask]);
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2); // an icon
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

const drawing = parseSvg(readFileSync(source, 'utf8'));
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, 'icon.ico'),
  encodeIco(
    ICO_SIZES.map((size) => {
      const pixels = render(size, drawing);
      // The largest image is stored as PNG, as Windows itself does; the rest as bitmaps.
      return { size, data: size === 256 ? encodePng(size, pixels) : encodeDib(size, pixels) };
    }),
  ),
);
writeFileSync(path.join(out, 'icon.png'), encodePng(512, render(512, drawing)));
console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')}) and build/icon.png (512).`);
