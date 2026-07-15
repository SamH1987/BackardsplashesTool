// Generates the home-screen app icons (teal tile with a spa-ish waterline).
// Pure Node PNG writer, no image libraries. Run: runtime/bin/node scripts/make_app_icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let t = crc32.t;
  if (!t) {
    t = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(file, size, px) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(path.join(__dirname, '..', 'public', file), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]));
  console.log('wrote', file);
}

function icon(size) {
  const px = Buffer.alloc(size * size * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, 14, 95, 118); // teal tile
  // spa: rounded light square with blue water and a wavy waterline
  const m = Math.round(size * 0.18), w = size - 2 * m;
  for (let y = m; y < m + w; y++) {
    for (let x = m; x < m + w; x++) {
      const rx = Math.min(x - m, m + w - 1 - x), ry = Math.min(y - m, m + w - 1 - y);
      if (rx + ry < size * 0.06) continue; // clipped corners
      set(x, y, 223, 227, 230); // shell
    }
  }
  const im = Math.round(size * 0.26), iw = size - 2 * im;
  for (let y = im; y < im + iw; y++) {
    for (let x = im; x < im + iw; x++) {
      const wave = Math.sin(x / size * 12) * size * 0.012;
      set(x, y, 47, 168 + (y + wave > size * 0.5 ? 0 : 20), 213);
    }
  }
  return px;
}

writePng('icon-192.png', 192, icon(192));
writePng('icon-512.png', 512, icon(512));
