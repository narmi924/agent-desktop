'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { pick } = require('./script-match');

const LINE = /^(\s*)- (\S+?)(?: "((?:[^"\\]|\\.)*)")?(?: \[(.*)\])?(?:: (.*))?$/;
const WRITABLE = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'];
const CHOICES = ['combobox', 'listbox'];
const TICKS = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'];
const STALE = /unknown ref|stale|not found in the ref map/i;
const MISS = /not found|no element|no match|did not match|could not find|unable to find|found 0|none match/i;
const HIDDEN = /cannot take focus/i;
const NOT_READY = /would not reach it|is covered by|cannot take focus|No option matched/i;
const PATIENCE_MS = 4000;
const SETTLE_MS = 2000;
const VIEW_LIMIT = 6000;
const QUIET_MS = 400;
const EFFECTS = [
  ['url_changed', 'the page went to another address'],
  ['new_tab', 'a new tab opened'],
  ['dialog_opened', 'a dialog opened'],
  ['target_removed', 'the control is gone from the page'],
];

function unquote(text) {
  return text === undefined ? '' : text.replace(/\\(.)/g, '$1');
}

/** Turns the lines of a page read into controls with a role, a name and a ref. */
function parseControls(snapshot) {
  const controls = [];
  for (const line of String(snapshot ?? '').split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, indent, role, name, attributes = '', value] = match;
    const ref = /(?:^|, )ref=(e\d+)/.exec(attributes)?.[1];
    const near = /near="((?:[^"\\]|\\.)*)"/.exec(attributes)?.[1];
    const disabled = /(?:^|, )disabled(?:,|$)/.test(attributes);
    controls.push({ role, name: unquote(name), near: unquote(near), ref: ref && '@' + ref, value, depth: indent.length, ...(disabled ? { disabled } : {}) });
  }
  return controls;
}

/**
 * Finds text in a full page read, also when it sits in a frame or spans several
 * text nodes. Returns the text that holds it, or the text itself. Plain text
 * wins over a control's name, so a wait for "Save" after saving returns the
 * status line "Saved at 10:42" and not the Save button.
 */
function shows(snapshot, text) {
  const lines = parseControls(snapshot).filter(line => line.name.includes(text));
  const holder = lines.find(line => !line.ref) ?? lines[0];
  if (holder) return holder.name.trim();
  const quoted = Array.from(snapshot.matchAll(/"((?:[^"\\]|\\.)*)"/g), m => unquote(m[1]));
  const squeeze = value => value.replace(/\s+/g, '');
  return squeeze(quoted.join('')).includes(squeeze(text)) || snapshot.includes(text) ? text : undefined;
}

/** The text selected on the page: in the focused field, or in the document, looking into open shadow roots and same-origin frames. */
function selectedText() {
  const inField = element => {
    if (!element || typeof element.selectionStart !== 'number' || element.selectionStart === element.selectionEnd) return '';
    return String(element.value ?? '').slice(element.selectionStart, element.selectionEnd);
  };
  const read = doc => {
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (active && active.tagName === 'IFRAME') {
      try { if (active.contentDocument) return read(active.contentDocument); } catch { return ''; }
    }
    const field = inField(active);
    if (field) return field;
    const selection = (active && active.getRootNode && active.getRootNode().getSelection) ? active.getRootNode().getSelection() : doc.getSelection();
    return selection ? String(selection) : '';
  };
  return read(document) || null;
}

function extractTable(selector) {
  const tables = document.querySelectorAll(selector || 'table');
  if (tables.length !== 1) throw new Error('Expected one table, found ' + tables.length);
  return Array.from(tables[0].rows, row => Array.from(row.cells, cell => cell.innerText.trim()));
}

/** Page helpers for a script: every target is a visible name, a ref or `css:SELECTOR`. */
function createWeb({ call, step, warn, note = () => {}, flags = [], fetchPage }) {
  let known;
  const ab = (args, options) => call([...flags, '--json', ...args], options);
  const controls = async fresh => {
    if (!known || fresh) known = parseControls((await ab(['snapshot', '-i'])).snapshot);
    return known;
  };
  const changed = () => { known = undefined; };

  async function locate(target, options) {
    if (typeof target !== 'string' || !target) throw Object.assign(new Error('Name the control: its visible name, a ref such as @e5, or css:SELECTOR.'), { code: 'INVALID_ARGS' });
    if (/^@e\d+$/.test(target)) return target;
    if (target.startsWith('css:')) return target.slice(4);
    if (options?.near !== undefined) return pick(parseControls((await ab(['snapshot', '-c'])).snapshot), target, options)?.ref;
    const cached = Boolean(known);
    return (pick(await controls(), target, options) ?? (cached ? pick(await controls(true), target, options) : undefined))?.ref;
  }

  async function firstHit(attempts) {
    let last;
    for (const attempt of attempts) {
      try { return await attempt(); } catch (err) {
        if (!MISS.test(err.message)) throw err;
        last = err;
      }
    }
    throw last;
  }

  /**
   * A page that is still loading shows a control late, disabled or covered.
   * Keep trying for a few seconds, as a person would, before reporting it.
   */
  async function act(target, options, run, fallback) {
    const until = Date.now() + (options?.timeout ?? PATIENCE_MS);
    for (;;) {
      try { return await attempt(target, options, run, fallback); } catch (err) {
        if (!(err.code === 'ELEMENT_NOT_FOUND' || NOT_READY.test(err.message)) || Date.now() >= until) throw err;
        known = undefined;
        await delay(150);
      }
    }
  }

  async function attempt(target, options, run, fallback) {
    let at = await locate(target, options);
    if (!at) {
      const beside = options?.near === undefined ? '' : ' beside "' + options.near + '"';
      const missing = Object.assign(new Error('No visible control is named "' + target + '"' + beside + ' on this page.'), { code: 'ELEMENT_NOT_FOUND' });
      if (!fallback || options?.near !== undefined || options?.nth !== undefined) throw missing;
      try { return await fallback(); } catch (err) { throw MISS.test(err.message) || HIDDEN.test(err.message) ? missing : err; }
    }
    try { return await run(at); } catch (err) {
      if (!STALE.test(err.message) || !/^@e\d+$/.test(at) || at === target) throw err;
      known = undefined;
      at = await locate(target, options);
      if (!at) throw err;
      return run(at);
    }
  }

  function confirmed(label, target, reply) {
    const effects = reply?.receipt?.effects ?? {};
    for (const [key, text] of EFFECTS) if (effects[key]) note(text);
    if (reply?.receipt?.verified === false) warn(label + ' "' + target + '" was sent, but the page did not confirm it.');
    return reply?.receipt?.verified !== false;
  }

  const byName = (kinds, target, ...action) => () => firstHit(kinds.map(kind => () => ab(kind === 'button' || kind === 'link'
    ? ['find', 'role', kind, ...action, '--name', target, '--exact']
    : ['find', kind, target, ...action, '--exact'])));

  const web = {
    open: url => step('web.open', url, async () => {
      changed();
      const { url: at, title } = await ab(['open', String(url)], { timeout: 60000 });
      return { url: at, title };
    }),
    read: ({ all = false } = {}) => step('web.read', all ? 'all' : '', async () => {
      const data = await ab(['snapshot', all ? '-c' : '-i']);
      if (!all) known = parseControls(data.snapshot);
      return data.snapshot;
    }),
    fill: (target, value, options) => step('web.fill', target, async () => {
      const reply = await act(target, { roles: WRITABLE, ...options }, async at => {
        if (known?.find(c => c.ref === at)?.role === 'combobox') {
          try {
            const picked = await ab(['select', at, String(value)]);
            if (picked?.receipt?.verified !== false) return picked;
          } catch (err) {
            if (/No option matched/i.test(err.message)) throw err;
          }
        }
        return ab(['fill', at, String(value)]);
      }, byName(['label', 'placeholder', 'near'], target, 'fill', String(value)));
      return confirmed('web.fill', target, reply);
    }),
    type: (target, text, options) => step('web.type', target, async () => {
      const reply = await act(target, { roles: WRITABLE, ...options }, at => ab(['type', at, String(text)], { timeout: 120000 }),
        byName(['label', 'placeholder', 'near'], target, 'type', String(text)));
      return confirmed('web.type', target, reply);
    }),
    click: (target, options) => step('web.click', target, async () => {
      const reply = await act(target, options, at => ab(['click', at]),
        options?.role ? undefined : byName(['text', 'button', 'link'], target, 'click'));
      changed();
      return confirmed('web.click', target, reply);
    }),
    select: (target, ...choices) => step('web.select', target, async () => {
      const reply = await act(target, { roles: CHOICES }, at => ab(['select', at, ...choices.map(String)]),
        byName(['label'], target, 'select', ...choices.map(String)));
      changed();
      return confirmed('web.select', target, reply);
    }),
    check: (target, options) => step('web.check', target, async () => {
      const reply = await act(target, { roles: TICKS, ...options }, at => ab(['check', at]), byName(['label'], target, 'check'));
      changed();
      return confirmed('web.check', target, reply);
    }),
    uncheck: (target, options) => step('web.uncheck', target, async () => {
      const reply = await act(target, { roles: TICKS, ...options }, at => ab(['uncheck', at]), byName(['label'], target, 'uncheck'));
      changed();
      return confirmed('web.uncheck', target, reply);
    }),
    press: key => step('web.press', key, async () => {
      await ab(['press', String(key)]);
      changed();
    }),
    waitText: (text, timeout = 10000) => step('web.waitText', text, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const found = shows((await ab(['snapshot', '-c'])).snapshot, String(text));
        if (found) { changed(); return found; }
        if (Date.now() >= until) throw Object.assign(new Error('The text "' + text + '" did not appear within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(120);
      }
    }),
    waitIdle: ({ timeout = 10000, quiet = QUIET_MS } = {}) => step('web.waitIdle', '', async () => {
      const until = Date.now() + timeout;
      let last, since = Date.now();
      for (;;) {
        const { snapshot } = await ab(['snapshot', '-c']);
        if (snapshot !== last) { last = snapshot; since = Date.now(); } else if (Date.now() - since >= quiet) { changed(); return snapshot; }
        if (Date.now() >= until) {
          changed();
          warn('web.waitIdle: the page was still changing after ' + timeout + ' ms; this is its latest read.');
          return snapshot;
        }
        await delay(120);
      }
    }),
    waitFor: (target, { timeout = 10000, ...options } = {}) => step('web.waitFor', target, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const hit = pick(await controls(true), target, options);
        if (hit) return hit.ref;
        if (Date.now() >= until) throw Object.assign(new Error('No control named "' + target + '" appeared within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(150);
      }
    }),
    has: (target, options) => step('web.has', target, async () => {
      const until = Date.now() + SETTLE_MS;
      for (;;) {
        const hit = pick(await controls(true), target, options);
        const busy = hit?.disabled && hit.role !== 'option';
        if (!busy || Date.now() >= until) return Boolean(hit) && !busy;
        await delay(150);
      }
    }),
    text: target => step('web.text', target ?? '', async () => target === undefined
      ? (await ab(['read'])).content
      : act(target, undefined, async at => (await ab(['get', 'text', at])).text)),
    value: target => step('web.value', target, () => act(target, undefined, async at => (await ab(['get', 'value', at])).value)),
    table: selector => step('web.table', selector ?? '', async () =>
      (await ab(['eval', '--stdin'], { input: '(' + extractTable + ')(' + JSON.stringify(selector ?? null) + ')' })).result),
    eval: source => step('web.eval', '', async () => {
      changed();
      return (await ab(['eval', '--stdin'], { input: String(source) })).result;
    }),
    fetch: url => step('web.fetch', url, () => fetchPage(String(url))),
    selection: () => step('web.selection', '', async () =>
      (await ab(['eval', '--stdin'], { input: '(' + selectedText + ')()' })).result ?? null),
    sleep: ms => delay(ms),
    url: () => step('web.url', '', async () => (await ab(['get', 'url'])).url),
    title: () => step('web.title', '', async () => (await ab(['get', 'title'])).title),
    cmd: (...args) => step('web.cmd', args[0], async () => {
      changed();
      const data = await ab(args.map(String), { timeout: 120000 });
      if (data && typeof data === 'object') delete data.lifecycle;
      return data;
    }),
  };

  async function scene() {
    const data = await ab(['snapshot', '-c']);
    const view = data.snapshot.length > VIEW_LIMIT ? data.snapshot.slice(0, VIEW_LIMIT) + '\n… (cut)' : data.snapshot;
    return { surface: 'web', url: data.origin, view };
  }

  return { web, scene };
}

module.exports = { createWeb, parseControls, shows };
