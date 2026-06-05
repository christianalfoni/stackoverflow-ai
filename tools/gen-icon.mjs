// Generates media/icon.png (128x128) — a Stack Overflow-style tray-with-papers
// mark in white on the SO orange, with rounded corners. No deps (hand-rolled PNG).
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 128, H = 128;
const buf = Buffer.alloc(W * H * 4); // RGBA, transparent by default

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function rect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, r, g, b, a);
}
function insideRounded(x, y, w, h, rad) {
  const cx = Math.min(Math.max(x, rad), w - rad);
  const cy = Math.min(Math.max(y, rad), h - rad);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// Background: rounded square in SO orange.
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (insideRounded(x + 0.5, y + 0.5, W, H, 24)) px(x, y, 244, 128, 36);

// White mark: a tray (open-top bracket) with three stacked "papers".
const w = 255;
// papers
rect(48, 28, 92, 36, w, w, w);
rect(48, 44, 92, 52, w, w, w);
rect(48, 60, 92, 68, w, w, w);
// tray
rect(34, 54, 42, 98, w, w, w); // left side
rect(86, 54, 94, 98, w, w, w); // right side
rect(34, 90, 94, 98, w, w, w); // bottom

// ---- minimal PNG encoder ----
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
// 10,11,12 = compression/filter/interlace = 0

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "icon.png");
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
