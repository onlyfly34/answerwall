// Draws the app icons (a wall of four answer cells) and writes them to public/.
// Run after changing the design: `node scripts/generate-icons.mjs`. The output
// is committed; the build does not run this. No dependencies: the PNG encoder
// below is all it needs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = join(import.meta.dirname, '..', 'public');
const BACKGROUND = [0x2f, 0x6f, 0xeb];
const CELL = [0xff, 0xff, 0xff];
/** The design, in units of a 64 x 64 canvas. */
const CELLS = [
  { x: 14, y: 14, w: 16, h: 22 },
  { x: 34, y: 14, w: 16, h: 14 },
  { x: 14, y: 40, w: 16, h: 10 },
  { x: 34, y: 32, w: 16, h: 18 },
];
const CELL_RADIUS = 3;
const SAMPLES = 4;

function insideRoundedRect(px, py, { x, y, w, h }, radius) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + radius), x + w - radius);
  const cy = Math.min(Math.max(py, y + radius), y + h - radius);
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

/**
 * `cornerRadius`: of the background, in canvas units (0 for a full-bleed
 * icon). `scale`: shrinks the cells towards the centre, for maskable icons
 * whose outer fifth may be cropped.
 */
function render(size, { cornerRadius, scale }) {
  const pixels = Buffer.alloc(size * size * 4);
  const cells = CELLS.map((cell) => ({
    x: 32 + (cell.x - 32) * scale,
    y: 32 + (cell.y - 32) * scale,
    w: cell.w * scale,
    h: cell.h * scale,
  }));
  const canvas = { x: 0, y: 0, w: 64, h: 64 };
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let covered = 0;
      let white = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = ((column + (sx + 0.5) / SAMPLES) / size) * 64;
          const py = ((row + (sy + 0.5) / SAMPLES) / size) * 64;
          if (!insideRoundedRect(px, py, canvas, cornerRadius)) continue;
          covered += 1;
          if (cells.some((cell) => insideRoundedRect(px, py, cell, CELL_RADIUS * scale))) {
            white += 1;
          }
        }
      }
      const offset = (row * size + column) * 4;
      const mix = covered === 0 ? 0 : white / covered;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - mix) + CELL[channel] * mix,
        );
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
    // Each row starts with its filter type; 0 is "none".
    pixels.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="${hex(BACKGROUND)}"/>
${CELLS.map(
  (cell) =>
    `  <rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}" rx="${CELL_RADIUS}" fill="${hex(CELL)}"/>`,
).join('\n')}
</svg>
`;

const rounded = { cornerRadius: 12, scale: 1 };
const fullBleed = { cornerRadius: 0, scale: 0.75 };
const files = {
  'icon.svg': svg,
  'icon-192.png': encodePng(192, render(192, rounded)),
  'icon-512.png': encodePng(512, render(512, rounded)),
  'icon-maskable-512.png': encodePng(512, render(512, fullBleed)),
  // Home-screen icons on iOS are cropped by the system and must be opaque.
  'apple-touch-icon.png': encodePng(180, render(180, { cornerRadius: 0, scale: 0.85 })),
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(OUT, name), content);
