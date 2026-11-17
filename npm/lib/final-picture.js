'use strict';

const { mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { markBox } = require('./png-mark');
const { stateDir } = require('./routine-store');

let count = 0;

/**
 * Takes a picture through `capture(path)`, frames the box `place(image)` returns, and keeps it under
 * the state folder's finals/ so the reply can name it. Returns the path.
 */
async function markedPicture(capture, place) {
  const dir = join(stateDir(), 'finals');
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, 'final-' + Date.now() + '-' + process.pid + '-' + (++count));
  const raw = stem + '-raw.png';
  await capture(raw);
  try {
    const png = readFileSync(raw);
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const out = stem + '.png';
    writeFileSync(out, markBox(png, place(size)));
    return out;
  } finally {
    rmSync(raw, { force: true });
  }
}

module.exports = { markedPicture };
