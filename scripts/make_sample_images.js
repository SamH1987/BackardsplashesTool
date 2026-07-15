// Generates the placeholder "site photos" and sketch for the sample job.
// Pure Node - writes valid PNGs with zlib, no image libraries needed.
// Run with: npm run sample-images

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(OUT, { recursive: true });

// ---- minimal PNG encoder ----
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, w, h, pixels /* RGB Buffer w*h*3 */) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(path.join(OUT, file), png);
  console.log('wrote', file);
}

// ---- tiny raster helpers ----
function canvasBuf(w, h) { return { w, h, px: Buffer.alloc(w * h * 3) }; }
function set(c, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 3;
  c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b;
}
function rect(c, x0, y0, x1, y1, r, g, b, noise = 0) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const n = noise ? Math.floor((Math.random() - 0.5) * noise) : 0;
    set(c, x, y, clamp(r + n), clamp(g + n), clamp(b + n));
  }
}
function clamp(v) { return Math.max(0, Math.min(255, v)); }
function line(c, x0, y0, x1, y1, r, g, b, width = 3) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + (x1 - x0) * s / steps);
    const y = Math.round(y0 + (y1 - y0) * s / steps);
    for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
      if (dx * dx + dy * dy <= width * width) set(c, x + dx, y + dy, r, g, b);
    }
  }
}
function box(c, x0, y0, x1, y1, r, g, b, width = 3) {
  line(c, x0, y0, x1, y0, r, g, b, width); line(c, x1, y0, x1, y1, r, g, b, width);
  line(c, x1, y1, x0, y1, r, g, b, width); line(c, x0, y1, x0, y0, r, g, b, width);
}
function dashedLine(c, x0, y0, x1, y1, r, g, b, width = 3) {
  const segs = 14;
  for (let s = 0; s < segs; s += 2) {
    const xa = x0 + (x1 - x0) * s / segs, ya = y0 + (y1 - y0) * s / segs;
    const xb = x0 + (x1 - x0) * (s + 1) / segs, yb = y0 + (y1 - y0) * (s + 1) / segs;
    line(c, Math.round(xa), Math.round(ya), Math.round(xb), Math.round(yb), r, g, b, width);
  }
}

const W = 800, H = 600;

// Photo 1: back yard - sky, fence, lawn
function backyard() {
  const c = canvasBuf(W, H);
  rect(c, 0, 0, W, 180, 168, 205, 222, 10);      // sky
  rect(c, 0, 180, W, 300, 121, 96, 66, 18);      // timber fence
  for (let x = 0; x < W; x += 40) line(c, x, 180, x, 300, 96, 74, 48, 1); // fence palings
  rect(c, 0, 300, W, H, 84, 132, 60, 22);        // lawn
  rect(c, 560, 210, 700, 300, 90, 90, 96, 12);   // shed
  rect(c, 590, 230, 660, 300, 60, 60, 66, 8);    // shed door
  return c;
}
const p1 = backyard();
writePng('sample_photo_backyard.png', W, H, p1.px);

// Photo 1 annotated: red box marking the spa position + arrow along access
const p1a = backyard();
box(p1a, 220, 350, 480, 520, 224, 49, 49, 4);
line(p1a, 60, 560, 200, 480, 224, 49, 49, 4);
line(p1a, 200, 480, 175, 505, 224, 49, 49, 4);
line(p1a, 200, 480, 172, 470, 224, 49, 49, 4);
writePng('sample_photo_backyard_annotated.png', W, H, p1a.px);

// Photo 2: side access - house wall, path, fence
function sideAccess() {
  const c = canvasBuf(W, H);
  rect(c, 0, 0, W, 140, 190, 214, 226, 10);      // sky strip
  rect(c, 0, 140, 250, H, 156, 118, 96, 16);     // brick house wall
  for (let y = 160; y < H; y += 30) line(c, 0, y, 250, y, 130, 96, 76, 1);
  rect(c, 550, 140, W, H, 121, 96, 66, 18);      // fence
  for (let x = 560; x < W; x += 40) line(c, x, 140, x, H, 96, 74, 48, 1);
  rect(c, 250, 140, 550, H, 168, 162, 152, 14);  // concrete path
  rect(c, 250, 140, 550, 200, 140, 134, 126, 10);
  return c;
}
const p2 = sideAccess();
writePng('sample_photo_access.png', W, H, p2.px);
const p2a = sideAccess();
line(p2a, 265, 400, 540, 400, 224, 49, 49, 4);   // width arrow
line(p2a, 265, 400, 295, 380, 224, 49, 49, 4);
line(p2a, 265, 400, 295, 420, 224, 49, 49, 4);
line(p2a, 540, 400, 510, 380, 224, 49, 49, 4);
line(p2a, 540, 400, 510, 420, 224, 49, 49, 4);
writePng('sample_photo_access_annotated.png', W, H, p2a.px);

// Photo 3: switchboard on wall
const p3 = canvasBuf(W, H);
rect(p3, 0, 0, W, H, 156, 118, 96, 16);          // brick wall
for (let y = 20; y < H; y += 30) line(p3, 0, y, W, y, 130, 96, 76, 1);
rect(p3, 280, 150, 520, 430, 210, 210, 214, 6);  // board box
box(p3, 280, 150, 520, 430, 120, 120, 124, 3);
rect(p3, 310, 190, 490, 260, 40, 40, 44, 4);     // meter window
rect(p3, 310, 290, 350, 380, 60, 60, 64, 3);     // breakers
rect(p3, 360, 290, 400, 380, 60, 60, 64, 3);
rect(p3, 410, 290, 450, 380, 60, 60, 64, 3);
writePng('sample_photo_switchboard.png', W, H, p3.px);

// Sketch: plan view - house, fence, spa, pipe runs
const sk = canvasBuf(1000, 600);
rect(sk, 0, 0, 1000, 600, 255, 255, 255);
box(sk, 60, 60, 460, 360, 17, 17, 17, 3);        // house outline
line(sk, 60, 200, 250, 200, 17, 17, 17, 2);      // internal wall hint
box(sk, 20, 20, 980, 580, 17, 17, 17, 2);        // boundary/fence
box(sk, 640, 330, 900, 500, 194, 34, 34, 4);     // spa position (red)
dashedLine(sk, 460, 420, 640, 420, 17, 17, 17, 2);   // access route from side path
dashedLine(sk, 250, 500, 460, 440, 17, 17, 17, 2);
line(sk, 470, 90, 640, 340, 34, 34, 194, 2);     // electrical run (blue) from board
dashedLine(sk, 700, 500, 700, 570, 17, 120, 17, 2);  // drainage run (green)
writePng('sample_sketch.png', 1000, 600, sk.px);

console.log('Sample images done.');
