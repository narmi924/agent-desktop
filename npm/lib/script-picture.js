'use strict';

const { mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { storeImage } = require('./window-move');

const KEEP_IMAGES = 30;
const TIE_PX = 2;

function sceneDir() {
  const root = process.env.AGENT_DESKTOP_HOME || join(homedir(), '.agent-desktop');
  return join(root, 'scenes');
}

function prune(dir) {
  try {
    const images = readdirSync(dir).filter(name => name.endsWith('.png'))
      .map(name => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of images.slice(KEEP_IMAGES)) rmSync(old.path, { force: true });
  } catch { /* A scene folder that cannot be listed only keeps more images. */ }
}

const center = bounds => ({ x: Math.floor(bounds.x + bounds.width / 2), y: Math.floor(bounds.y + bounds.height / 2) });

function placeList(matches) {
  return matches.slice(0, 6).map(m => '(' + m.center.x + ',' + m.center.y + ') "' + m.text + '"').join(', ');
}

/**
 * Picks the one place a text refers to among the places the picture shows
 * it: the nth from the top, the one closest to a piece of nearby text, or
 * the only one. Several equally good places are refused with their positions.
 */
function choose(matches, text, { nth, near } = {}, nearMatches = []) {
  if (!matches.length) return undefined;
  if (near !== undefined) {
    if (!nearMatches.length) return undefined;
    const distance = m => Math.min(...nearMatches.map(n => Math.hypot(n.center.x - m.center.x, n.center.y - m.center.y)));
    const ranked = matches.map(m => ({ m, d: distance(m) })).sort((a, b) => a.d - b.d);
    if (ranked.length > 1 && ranked[1].d - ranked[0].d < TIE_PX) {
      throw Object.assign(new Error('2 places in the picture show "' + text + '" equally close to "' + near + '": ' +
        placeList(ranked.slice(0, 2).map(r => r.m)) + '. Pass {nth}.'), { code: 'AMBIGUOUS_TARGET' });
    }
    return ranked[0].m;
  }
  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 1 || nth > matches.length) {
      throw Object.assign(new Error('nth ' + nth + ' is out of range: the picture shows "' + text + '" in ' + matches.length + ' places.'), { code: 'INVALID_ARGS' });
    }
    return matches[nth - 1];
  }
  if (matches.length > 1) {
    throw Object.assign(new Error(matches.length + ' places in the picture show "' + text + '": ' + placeList(matches) +
      '. Pass {near: "text beside the one you mean"} or {nth}, counted from the top.'), { code: 'AMBIGUOUS_TARGET' });
  }
  return matches[0];
}

/** Lines read from the picture, one per place, in the style of a window read. */
function renderLines(lines) {
  return lines.map(line => {
    const at = center(line.bounds);
    return '- text "' + line.text + '" [picture ' + at.x + ',' + at.y + ']';
  }).join('\n');
}

/**
 * Reading a window as a picture: capture it as a frame `mouse-click --frame`
 * accepts, read its text, and find a piece of text in it.
 */
function createPicture({ ad, dir = sceneDir() }) {
  let count = 0;

  async function windowInfo(id) {
    const win = (await ad(['list-windows'])).find(w => w.id === id && w.visible !== false && !w.minimized);
    if (!win || !win.process_instance) throw Object.assign(new Error('The window ' + id + ' is not open and visible.'), { code: 'WINDOW_NOT_FOUND' });
    return win;
  }

  async function capture(id) {
    const before = await windowInfo(id);
    const img = await ad(['screenshot', '--window-id', id], { timeout: 30000 });
    const after = await windowInfo(id);
    if (before.process_instance !== after.process_instance || before.bounds?.width !== after.bounds?.width || before.bounds?.height !== after.bounds?.height) {
      throw Object.assign(new Error('The window changed while it was being captured.'), { code: 'STALE_REF' });
    }
    const width = img.full_size?.[0] ?? img.width, height = img.full_size?.[1] ?? img.height;
    const token = Buffer.from(JSON.stringify({ window: after, width, height, scale: img.scale_factor })).toString('base64url');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'scene-' + Date.now() + '-' + process.pid + '-' + (++count) + '.png');
    storeImage(Buffer.from(img.data, 'base64'), token, path);
    prune(dir);
    return { path, scale: img.scale_factor, window: after.id };
  }

  async function read(shot, text) {
    const reply = await ad(['ocr', '--image', shot.path, '--scale', String(shot.scale ?? 1), ...(text === undefined ? [] : ['--find', String(text)])], { timeout: 30000 });
    return { lines: reply.lines ?? [], matches: reply.matches ?? [] };
  }

  /** Where `text` shows in a fresh capture, narrowed by {nth} or {near}. */
  async function find(id, text, options = {}) {
    const shot = await capture(id);
    const { matches } = await read(shot, text);
    if (!matches.length) return undefined;
    const near = options.near === undefined ? [] : (await read(shot, options.near)).matches;
    const hit = choose(matches, text, options, near);
    return hit && { shot, hit };
  }

  return { capture, read, find };
}

module.exports = { createPicture, choose, renderLines, sceneDir };
