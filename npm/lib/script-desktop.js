'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { pick } = require('./script-match');

const WRITABLE = ['textfield', 'combobox', 'incrementor', 'slider'];
const TICKS = ['checkbox', 'radiobutton', 'switch'];
const VALUE_LIMIT = 200;
const VIEW_LIMIT = 6000;
const PATIENCE_MS = 4000;

function flatten(node, depth, lines, controls, texts, level = 0) {
  const shown = node.name || node.value || node.ref_id;
  if (node.name) texts.push(node.name);
  if (node.value && node.value !== node.name) texts.push(node.value);
  controls.push({ role: node.role, name: node.name ?? '', near: node.description ?? '', ref: node.ref_id, value: node.value, depth: level,
    checked: (node.states ?? []).includes('checked') });
  if (shown) {
    const states = (node.states ?? []).filter(s => ['disabled', 'selected', 'checked', 'expanded', 'focused'].includes(s));
    const value = node.value && node.value !== node.name ? ': ' + (node.value.length > VALUE_LIMIT ? node.value.slice(0, VALUE_LIMIT) + '…' : node.value) : '';
    lines.push('  '.repeat(depth) + '- ' + node.role + (node.name ? ' "' + node.name + '"' : '') +
      (node.ref_id || states.length ? ' [' + [...states, node.ref_id].filter(Boolean).join(', ') + ']' : '') + value);
  }
  for (const child of node.children ?? []) flatten(child, depth + (shown ? 1 : 0), lines, controls, texts, level + 1);
}

/** Renders a window tree as one line per named node, in the style of a page read. */
function renderTree(snapshot) {
  const lines = [], controls = [], texts = [];
  flatten(snapshot.tree, 0, lines, controls, texts);
  if (snapshot.complete === false) lines.push('… (the window was not read completely)');
  return { text: lines.join('\n'), controls, texts };
}

/** Desktop helpers for a script. A window is an id from list-windows or part of an app name or title. */
function createDesktop({ call, step, warn }) {
  const views = new Map(), found = new Map();
  let last;
  const ad = (args, options) => call(args.map(String), options);

  async function windows(filter) {
    const wanted = filter === undefined ? undefined : String(filter).toLowerCase();
    return (await ad(['list-windows']))
      .filter(w => !wanted || w.id === filter || (w.app_name ?? '').toLowerCase().includes(wanted) || (w.title ?? '').toLowerCase().includes(wanted))
      .map(w => ({ id: w.id, app: w.app_name, title: w.title, minimized: Boolean(w.minimized), focused: Boolean(w.is_focused) }));
  }

  async function resolve(window) {
    if (/^w-\d+$/.test(String(window))) return String(window);
    if (found.has(window)) return found.get(window);
    const open = (await windows(window)).filter(w => !w.minimized);
    if (open.length === 1) {
      found.set(window, open[0].id);
      return open[0].id;
    }
    throw Object.assign(new Error(open.length
      ? open.length + ' windows match "' + window + '": ' + open.slice(0, 6).map(w => w.id + ' ' + w.title).join(', ') + '. Pass the id.'
      : 'No open window matches "' + window + '". A minimized window has to be restored first.'),
    { code: open.length ? 'AMBIGUOUS_TARGET' : 'WINDOW_NOT_FOUND' });
  }

  async function view(window, all = false) {
    const id = await resolve(window);
    const snapshot = await ad(['snapshot', '--window-id', id, '--compact', '--max-depth', '50', ...(all ? [] : ['-i'])]);
    const rendered = renderTree(snapshot);
    views.set(id, rendered.controls);
    last = id;
    return { id, ...rendered };
  }

  async function locate(window, target, options) {
    if (typeof target !== 'string' || !target) throw Object.assign(new Error('Name the control: its visible name or a ref from desktop.read.'), { code: 'INVALID_ARGS' });
    if (/^@\w+:e\d+$/.test(target)) return target;
    const id = await resolve(window);
    const cached = views.get(id);
    const hit = options?.near !== undefined
      ? pick((await view(id, true)).controls, target, options)
      : (cached && pick(cached, target, options)) ?? pick((await view(id)).controls, target, options);
    const beside = options?.near === undefined ? '' : ' beside "' + options.near + '"';
    if (!hit) throw Object.assign(new Error('No control is named "' + target + '"' + beside + ' in this window.'), { code: 'ELEMENT_NOT_FOUND' });
    return hit.ref;
  }

  /** A window that is still opening shows a control late: keep looking for a few seconds. */
  async function act(window, target, options, run) {
    const until = Date.now() + (options?.timeout ?? PATIENCE_MS);
    for (;;) {
      try { return await run(await locate(window, target, options)); } catch (err) {
        const named = !/^@\w+:e\d+$/.test(target);
        if (!named || !['STALE_REF', 'ELEMENT_NOT_FOUND', 'WINDOW_NOT_FOUND'].includes(err.code) || Date.now() >= until) throw err;
        views.clear();
        await delay(200);
      }
    }
  }

  function confirmed(label, target, reply) {
    const delivery = reply?.disposition?.delivery ?? reply?.after_action?.disposition?.delivery ?? reply?.delivery;
    if (delivery === 'delivered_unverified') warn(label + ' "' + target + '" was sent, but the app did not confirm it.');
    return delivery !== 'delivered_unverified';
  }

  /** Ticks or clears a box only when it is not already in that state, then reads the state back. */
  const tick = wanted => (window, target, options) => step(wanted ? 'desktop.check' : 'desktop.uncheck', target, async () => {
    const kind = { roles: TICKS, ...options };
    views.clear();
    await act(window, target, kind, async ref => {
      const box = views.get(await resolve(window))?.find(control => control.ref === ref);
      if (!box || box.checked !== wanted) await ad(['click', ref]);
    });
    const after = pick((await view(window)).controls, target, kind);
    if (after?.checked !== wanted) warn((wanted ? 'desktop.check' : 'desktop.uncheck') + ' "' + target + '" was sent, but the box did not change.');
    return after?.checked === wanted;
  });

  const desktop = {
    check: tick(true),
    uncheck: tick(false),
    windows: filter => step('desktop.windows', filter ?? '', () => windows(filter)),
    read: (window, { all = false } = {}) => step('desktop.read', window, async () => (await view(window, all)).text),
    click: (window, target, options) => step('desktop.click', target, async () => {
      await act(window, target, options, ref => ad(['click', ref]));
      views.clear();
    }),
    fill: (window, target, value, options) => step('desktop.fill', target, async () => {
      const reply = await act(window, target, { roles: WRITABLE, ...options }, ref => ad(['set-value', ref, '--stdin'], { input: String(value) }));
      return confirmed('desktop.fill', target, reply);
    }),
    value: (window, target, options) => step('desktop.value', target, async () => {
      const reply = await act(window, target, options, ref => ad(['get', ref, '--property', 'value']));
      return reply?.value ?? reply;
    }),
    has: (window, target, options) => step('desktop.has', target, async () => Boolean(pick((await view(window)).controls, target, options))),
    waitFor: (window, target, { timeout = 10000, ...options } = {}) => step('desktop.waitFor', target, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const hit = pick((await view(window)).controls, target, options);
        if (hit) return hit.ref;
        if (Date.now() >= until) throw Object.assign(new Error('No control named "' + target + '" appeared within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(200);
      }
    }),
    waitText: (window, text, timeout = 10000) => step('desktop.waitText', text, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const shown = (await view(window, true)).texts.find(value => value.includes(String(text)));
        if (shown) return shown;
        if (Date.now() >= until) throw Object.assign(new Error('The text "' + text + '" did not appear within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(200);
      }
    }),
    cmd: (...args) => step('desktop.cmd', args[0], () => {
      views.clear();
      found.clear();
      return ad(args, { timeout: 120000 });
    }),
  };

  async function scene() {
    if (!last) return undefined;
    const { text } = await view(last);
    return { surface: 'desktop', window: last, view: text.length > VIEW_LIMIT ? text.slice(0, VIEW_LIMIT) + '\n… (cut)' : text };
  }

  return { desktop, scene };
}

module.exports = { createDesktop, renderTree };
