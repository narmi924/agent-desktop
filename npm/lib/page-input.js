'use strict';

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { source, result: pageResult } = require('./current-page');

async function pageState(ad, page, bounds = false) {
  const { state, saved } = await source(ad, page, bounds);
  if (state.url !== saved.url) throw new Error('The page navigated. Read the selected page again.');
  return state;
}

function descendants(root) {
  return [root, ...(root.children ?? []).filter(child => child.role !== 'document').flatMap(descendants)];
}

function namedField(doc, name) {
  const writable = descendants(doc).filter(node => {
    const text = ['textfield', 'textarea'].includes(node.role);
    const combo = node.role === 'combobox' && node.available_actions?.includes('SetValue');
    return node.name === name && node.ref_id && (text || combo) &&
      !node.states?.some(state => ['disabled', 'readonly', 'protected'].includes(state));
  });
  const leaves = writable.filter(node => !writable.some(other => other !== node && descendants(node).includes(other)));
  if (leaves.length !== 1) throw new Error('Expected one writable field named ' + name + ', found ' + leaves.length + '.');
  return leaves[0];
}

function normalize(text) {
  return text.replace(/\r\n?/g, '\n');
}

function observedInsertion(before, after, text) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return false;
  before = normalize(before);
  after = normalize(after);
  text = normalize(text);
  for (let at = after.indexOf(text); at !== -1; at = after.indexOf(text, at + 1)) {
    const prefix = after.slice(0, at), suffix = after.slice(at + text.length);
    if (prefix.length + suffix.length <= before.length && before.startsWith(prefix) && before.endsWith(suffix)) return true;
  }
  return false;
}

function inForeground(ad, state) {
  return ad('list-windows').some(w => w.id === state.window && w.process_instance === state.owner && w.is_focused);
}

async function captureTypedPage(ad, output, report, originalUrl) {
  if (!output) return report;
  try {
    const state = await pageState(ad, report.page);
    const url = new URL(state.url), original = new URL(originalUrl);
    if (url.origin !== original.origin || url.pathname !== original.pathname) throw new Error('The document navigated away.');
    if (!inForeground(ad, state)) throw new Error('The browser is not in front.');
    const picture = ad('screenshot', '--window-id', state.window);
    await pageState(ad, report.page);
    if (!inForeground(ad, state)) throw new Error('The browser lost focus during capture.');
    const path = resolve(output);
    writeFileSync(path, Buffer.from(picture.data, 'base64'), {flag: 'wx'});
    return {...report, image: path};
  } catch (err) {
    return {...report, capture_error: err.message};
  }
}

async function typePage(ad, write, {page, field, value, stdin, multiline, replace, after: output, 'interval-ms': interval = '75'}) {
  if (!page || !field || (value !== undefined) === Boolean(stdin)) throw new Error('Use --page, --field and either --value or --stdin.');
  if (stdin && process.stdin.isTTY) throw new Error('Pipe text to --stdin.');
  if (output && existsSync(output)) throw new Error('Use a new path for --after.');
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 2000) throw new Error('--interval-ms must be between 1 and 2000.');
  const text = stdin ? readFileSync(0, 'utf8') : value;
  if (!text || Buffer.byteLength(text) > 10000) throw new Error('Type between 1 and 10000 bytes at a time.');
  if (text.includes('\t')) throw new Error('Use spaces for indentation; Tab can move focus to another field.');
  if (!multiline && /[\r\n]/.test(text)) throw new Error('Use --multiline to send Enter in a multiline editor.');

  const state = await pageState(ad, page);
  const original = namedField(state.doc, field);
  if (!inForeground(ad, state)) throw new Error('Bring the intended browser to the foreground before typing.');
  if (/[\r\n]/.test(text) && (original.role === 'combobox' || original.subrole === 'searchbox')) {
    throw new Error('Enter can confirm or submit this field. Use single-line text.');
  }
  const mode = replace ? (multiline ? 'replace-multiline' : 'replace') : (multiline ? 'multiline' : undefined);
  const args = ['type', original.ref_id, '--headed', '--selected-tab', state.tab, '--interval-ms', interval];
  if (mode) args.push('--entry-mode', mode);
  const action = write([...args, '--stdin'], text);
  const report = {page, field, keystrokes: action.keystrokes, interval_ms: Number(interval), verified: false};
  try {
    const {state: next} = await source(ad, page);
    if (next.url !== state.url) {
      return captureTypedPage(ad, output, {...report, page: pageResult(next).page, url: next.url,
        message: 'The tab changed its URL after keyboard input. Inspect the new view before repeating.'}, state.url);
    }
    const after = namedField(next.doc, field);
    report.verified = replace
      ? typeof after.value === 'string' && normalize(after.value) === normalize(text)
      : observedInsertion(original.value ?? '', after.value ?? '', text);
  } catch (err) {
    throw Object.assign(new Error('Keyboard input was sent. ' + err.message + ' Inspect the field before repeating.'),
      {code: 'ACTION_FAILED', disposition: {delivery: 'delivered_unverified', retry: 'unsafe'}});
  }
  if (!report.verified) report.message = 'Keys were sent; the field did not expose the expected text. Inspect the rendered field.';
  return captureTypedPage(ad, output, report, state.url);
}

module.exports = {typePage, pageState, descendants};
