'use strict';

const { inflateSync, deflateSync, crc32 } = require('node:zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced PNG into rows of raw pixels. */
function decode(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG image.');
  let at = 8, header, data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    if (type === 'IDAT') data.push(body);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[header?.color];
  if (!header || header.depth !== 8 || !channels || header.interlace) throw new Error('Only 8-bit, non-interlaced grey, RGB or RGBA PNG images can be marked.');
  const raw = inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const value = line[x];
      pixels[y * stride + x] = (filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up
        : filter === 3 ? value + ((left + up) >> 1) : value + paeth(left, up, corner)) & 255;
    }
  }
  return { ...header, channels, stride, pixels };
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), body.length + 8);
  return out;
}

function encode({ width, height, color, channels, stride, pixels }) {
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = color;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Draws a red frame around a box (in image pixels) so a reader sees which control a refused step meant.
 * The frame sits just outside the box and is clipped to the image.
 */
function markBox(png, { x, y, width, height }, thickness = 4) {
  const image = decode(png);
  const paint = (px, py) => {
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return;
    const at = py * image.stride + px * image.channels;
    const rgb = image.channels >= 3 ? [220, 30, 30] : [80];
    rgb.forEach((v, i) => { image.pixels[at + i] = v; });
    if (image.channels === 4 || image.channels === 2) image.pixels[at + image.channels - 1] = 255;
  };
  const left = Math.round(x) - thickness, top = Math.round(y) - thickness;
  const right = Math.round(x + width) + thickness, bottom = Math.round(y + height) + thickness;
  for (let t = 0; t < thickness; t++) {
    for (let px = left; px <= right; px++) { paint(px, top + t); paint(px, bottom - t); }
    for (let py = top; py <= bottom; py++) { paint(left + t, py); paint(right - t, py); }
  }
  return encode(image);
}

module.exports = { markBox, decode, encode };
