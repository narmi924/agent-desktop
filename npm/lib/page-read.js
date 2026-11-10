'use strict';

const { invoke } = require('./script-call');

const SESSION = 'reader';
const ENOUGH_CHARS = 600;
const WAIT_MS = 30000;

/**
 * Reads the text of a web address two ways at once: a plain request, and a
 * render in a background browser tab. Sites differ in which one they answer:
 * script-built pages are empty to a plain request, and some sites turn a
 * background browser away. The first full answer wins; when it is thin, the
 * longer of the two is returned.
 */
async function readPage(binary, address, call = invoke) {
  let url;
  try { url = new URL(address); } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('read takes an http or https address.');
  const settle = (via, work) => work.then(
    text => ({ via, text: String(text ?? '').trim() }),
    error => ({ via, text: '', error: error.message }));
  const plain = settle('request', call(binary, ['--json', 'read', url.href, '--timeout', '15000'], { timeout: WAIT_MS })
    .then(data => data.content));
  const rendered = settle('browser', (async () => {
    const flags = ['--session', SESSION, '--json'];
    await call(binary, [...flags, 'open', url.href], { timeout: WAIT_MS });
    return (await call(binary, [...flags, 'read'], { timeout: WAIT_MS })).content;
  })());
  const first = await Promise.race([plain, rendered]);
  if (first.text.length >= ENOUGH_CHARS) return { url: url.href, via: first.via, text: first.text };
  const [a, b] = await Promise.all([plain, rendered]);
  const best = a.text.length >= b.text.length ? a : b;
  if (!best.text) throw new Error('Neither a plain request nor a browser could read ' + url.href + ' (' + (a.error ?? 'empty') + '; ' + (b.error ?? 'empty') + ').');
  return { url: url.href, via: best.via, text: best.text, ...(best.text.length < ENOUGH_CHARS ? { thin: true } : {}) };
}

module.exports = { readPage };
