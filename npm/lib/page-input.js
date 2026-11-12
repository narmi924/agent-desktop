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

/** Where typed text went into a field: at its start, at its end or in the middle. Unknown when the field changed in another way. */
function landing(before, after, text) {
  if (typeof before !== 'string' || typeof after !== 'string') return undefined;
  before = normalize(before);
  after = normalize(after);
  text = normalize(text);
  if (after === before + text) return 'end';
  if (after === text + before) return 'start';
  return observedInsertion(before, after, text) ? 'middle' : undefined;
}

const WHEN_IDLE_MS = '600';

function inForeground(ad, state) {
  return ad('list-windows').some(w => w.id === state.window && w.process_instance === state.owner && w.is_focused);
}

function bringToFront(ad, state) {
  if (inForeground(ad, state)) return;
  ad('focus-window', '--window-id', state.window, '--headed');
  if (!inForeground(ad, state)) throw new Error('Windows refused to bring the intended browser to the foreground.');
}

function physicalArgs({human, seed}) {
  if (human !== undefined && !['natural', 'careful'].includes(human)) throw new Error('--human must be natural or careful.');
  if (seed !== undefined && (human === undefined || !/^\d+$/.test(seed))) throw new Error('--seed requires --human and a whole number.');
  return ['--when-idle', WHEN_IDLE_MS, ...(human ? ['--human', human] : []), ...(seed ? ['--seed', seed] : [])];
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

async function typePage(ad, write, {page, field, value, stdin, multiline, replace, at, after: output, human, seed, 'interval-ms': given}) {
  if (!page || !field || (value !== undefined) === Boolean(stdin)) throw new Error('Use --page, --field and either --value or --stdin.');
  if (given !== undefined && human !== undefined) throw new Error('Use --interval-ms or --human, not both: --human sets its own uneven rhythm.');
  if (at !== undefined && (!['start', 'end'].includes(at) || replace)) throw new Error('--at takes start or end, and has no meaning with --replace.');
  const interval = given ?? '75';
  if (stdin && process.stdin.isTTY) throw new Error('Pipe text to --stdin.');
  if (output && existsSync(output)) throw new Error('Use a new path for --after.');
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 2000) throw new Error('--interval-ms must be between 1 and 2000.');
  const text = stdin ? readFileSync(0, 'utf8') : value;
  if (!text || Buffer.byteLength(text) > 10000) throw new Error('Type between 1 and 10000 bytes at a time.');
  if (text.includes('\t')) throw new Error('Use spaces for indentation; Tab can move focus to another field.');
  if (!multiline && /[\r\n]/.test(text)) throw new Error('Use --multiline to send Enter in a multiline editor.');

  const state = await pageState(ad, page);
  const original = namedField(state.doc, field);
  bringToFront(ad, state);
  if (/[\r\n]/.test(text) && (original.role === 'combobox' || original.subrole === 'searchbox')) {
    throw new Error('Enter can confirm or submit this field. Use single-line text.');
  }
  const mode = replace ? (multiline ? 'replace-multiline' : 'replace') : (multiline ? 'multiline' : undefined);
  const args = ['type', original.ref_id, '--headed', '--selected-tab', state.tab, '--interval-ms', interval, ...physicalArgs({human, seed})];
  if (mode) args.push('--entry-mode', mode);
  if (at) args.push('--at', at);
  const action = write([...args, '--stdin'], text);
  const pace = human ? {human: action.human ?? {pace: human}} : {interval_ms: Number(interval)};
  const report = {page, field, keystrokes: action.keystrokes, ...pace, verified: false};
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
    if (!replace) report.landed = landing(original.value ?? '', after.value ?? '', text);
    if (at && report.verified && report.landed !== at) {
      report.verified = false;
      report.message = 'The text was typed, but it went in at the ' + report.landed + ' of the field, not at its ' + at + '.';
    }
  } catch (err) {
    throw Object.assign(new Error('Keyboard input was sent. ' + err.message + ' Inspect the field before repeating.'),
      {code: 'ACTION_FAILED', disposition: {delivery: 'delivered_unverified', retry: 'unsafe'}});
  }
  if (!report.verified) report.message ??= 'Keys were sent; the field did not expose the expected text. Inspect the rendered field.';
  return captureTypedPage(ad, output, report, state.url);
}

module.exports = {typePage, pageState, descendants, bringToFront, physicalArgs, observedInsertion, landing};
