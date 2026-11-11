'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { pick } = require('./script-match');
const { createPicture, renderLines } = require('./script-picture');

const WRITABLE = ['textfield', 'combobox', 'incrementor', 'slider'];
const TICKS = ['checkbox', 'radiobutton', 'switch'];
const VALUE_LIMIT = 200;
const VIEW_LIMIT = 6000;
const PATIENCE_MS = 4000;
const SELECTION_FIELDS = 5;
const SEEN_WAIT_MS = 1500;

function isTitleBar(node) {
  return node.role === 'titlebar' || (node.native_id?.kind === 'automation_id' && node.native_id.value === 'TitleBar');
}

function flatten(node, depth, lines, controls, texts, level = 0, inTitle = false) {
  const shown = node.name || node.value || node.ref_id;
  const kept = node.ref_id ? texts.controls : texts.plain;
  const title = inTitle || isTitleBar(node);
  if (node.name) kept.push(node.name);
  if (node.value && node.value !== node.name) kept.push(node.value);
  controls.push({ role: node.role, name: node.name ?? '', near: node.description ?? '', ref: node.ref_id, value: node.value, depth: level,
    checked: (node.states ?? []).includes('checked'), focused: (node.states ?? []).includes('focused'), title });
  if (shown) {
    const states = (node.states ?? []).filter(s => ['disabled', 'selected', 'checked', 'expanded', 'focused'].includes(s));
    const value = node.value && node.value !== node.name ? ': ' + (node.value.length > VALUE_LIMIT ? node.value.slice(0, VALUE_LIMIT) + '…' : node.value) : '';
    lines.push('  '.repeat(depth) + '- ' + node.role + (node.name ? ' "' + node.name + '"' : '') +
      (node.ref_id || states.length ? ' [' + [...states, node.ref_id].filter(Boolean).join(', ') + ']' : '') + value);
  }
  for (const child of node.children ?? []) flatten(child, depth + (shown ? 1 : 0), lines, controls, texts, level + 1, title);
}

/**
 * Renders a window tree as one line per named node, in the style of a page
 * read. `drawn` is true when nothing but the title bar reports controls: the
 * window draws its own interface, and only its picture shows what is in it.
 */
function renderTree(snapshot) {
  const lines = [], controls = [], found = { plain: [], controls: [] };
  flatten(snapshot.tree, 0, lines, controls, found);
  const texts = [...found.plain, ...found.controls];
  if (snapshot.complete === false) lines.push('… (the window was not read completely)');
  const drawn = !controls.some(control => control.ref && !control.title);
  return { text: lines.join('\n'), controls, texts, drawn };
}

const isRef = target => /^@\w+:e\d+$/.test(String(target));

/**
 * Desktop helpers for a script. A window is an id from list-windows or part of an app name or title.
 * A name is looked for among the window's controls first; when no control has it, the window's
 * picture is read and the text found there is used instead, unless the call passes {picture: false}.
 */
function createDesktop({ call, step, warn, note = () => {}, picture: makePicture = createPicture }) {
  const views = new Map(), found = new Map(), drawnWindows = new Set();
  let last;
  const ad = (args, options) => call(args.map(String), options);
  const picture = makePicture({ ad });

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
    if (rendered.drawn) drawnWindows.add(id); else drawnWindows.delete(id);
    last = id;
    return { id, ...rendered };
  }

  async function locate(window, target, options) {
    if (typeof target !== 'string' || !target) throw Object.assign(new Error('Name the control: its visible name or a ref from desktop.read.'), { code: 'INVALID_ARGS' });
    if (isRef(target)) return target;
    const id = await resolve(window);
    const cached = views.get(id);
    const hit = options?.near !== undefined
      ? pick((await view(id, true)).controls, target, options)
      : (cached && pick(cached, target, options)) ?? pick((await view(id)).controls, target, options);
    const beside = options?.near === undefined ? '' : ' beside "' + options.near + '"';
    if (!hit) throw Object.assign(new Error('No control is named "' + target + '"' + beside + ' in this window.'), { code: 'ELEMENT_NOT_FOUND' });
    return hit.ref;
  }

  const pictureAllowed = (target, options) => options?.picture !== false && !isRef(target) && typeof target === 'string' && target !== '';

  /**
   * A window that is still opening shows a control late: keep looking for a few seconds. A name no
   * control has is looked for in the picture at once, every round, not after the wait.
   */
  async function act(window, target, options, run, byPicture) {
    const until = Date.now() + (options?.timeout ?? PATIENCE_MS);
    const usePicture = byPicture && pictureAllowed(target, options);
    for (;;) {
      const id = usePicture ? await resolve(window) : undefined;
      if (usePicture && drawnWindows.has(id)) {
        const done = await byPicture(id);
        if (done !== undefined) return done;
        drawnWindows.delete(id);
      } else {
        try { return await run(await locate(window, target, options)); } catch (err) {
          const named = !isRef(target);
          if (!named || !['STALE_REF', 'ELEMENT_NOT_FOUND', 'WINDOW_NOT_FOUND'].includes(err.code)) throw err;
          if (usePicture && err.code === 'ELEMENT_NOT_FOUND') {
            const done = await byPicture(id);
            if (done !== undefined) return done;
          }
          if (Date.now() >= until) throw usePicture && err.code === 'ELEMENT_NOT_FOUND'
            ? Object.assign(new Error(err.message.replace(/\.$/, '') + ', and its picture does not show it.'), { code: err.code })
            : err;
        }
      }
      if (Date.now() >= until) {
        throw Object.assign(new Error('The picture of this window does not show "' + target + '".'), { code: 'ELEMENT_NOT_FOUND' });
      }
      views.clear();
      await delay(200);
    }
  }

  /** Clicks where the picture shows the text: the window comes to the front and the real mouse moves. */
  async function clickPicture(id, target, options) {
    await ad(['--headed', 'focus-window', '--window-id', id]);
    const spot = await picture.find(id, target, options);
    if (!spot) return undefined;
    const { x, y } = spot.hit.center;
    const report = await ad(['--headed', '--when-idle', '600', 'mouse-click', '--frame', spot.shot.path, '--xy', x + ',' + y]);
    note('by picture at ' + x + ',' + y);
    return { via: 'picture', text: spot.hit.text, x, y, delivery: report?.disposition?.delivery ?? report?.delivery };
  }

  /** Whether a fresh picture of the window shows the text, waiting briefly for it to be drawn. */
  async function pictureShows(id, text, wait = 0) {
    const until = Date.now() + wait;
    for (;;) {
      const { matches } = await picture.read(await picture.capture(id), text);
      if (matches.length) return matches[0];
      if (Date.now() >= until) return undefined;
      await delay(150);
    }
  }

  async function pictureText(id) {
    const { lines } = await picture.read(await picture.capture(id));
    return lines;
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
    apps: filter => step('desktop.apps', filter ?? '', async () =>
      (await ad(['list-apps', '--installed', ...(filter ? ['--app', filter] : [])], { timeout: 30000 })).installed_apps),
    launch: (app, { args = [] } = {}) => step('desktop.launch', app, async () => {
      const launched = await ad(['launch', app, ...args.map(arg => '--arg=' + arg)], { timeout: 60000 });
      found.clear();
      views.clear();
      if (launched.window?.id) last = launched.window.id;
      return { app: launched.app, pid: launched.pid, window: launched.window?.id ?? null, title: launched.window?.title ?? null };
    }),
    focused: window => step('desktop.focused', window, async () => {
      const hit = (await view(window, true)).controls.find(control => control.focused);
      return hit ? { role: hit.role, name: hit.name, ref: hit.ref ?? null } : null;
    }),
    selection: (window, target, options) => step('desktop.selection', target ?? window, async () => {
      const selected = async ref => (await ad(['get', ref, '--property', 'selection'])).value ?? null;
      if (target !== undefined) return act(window, target, options, selected);
      const controls = (await view(window)).controls.filter(control => control.ref);
      const focused = controls.find(control => control.focused);
      if (focused) return selected(focused.ref);
      for (const field of controls.filter(control => WRITABLE.includes(control.role)).slice(0, SELECTION_FIELDS)) {
        const text = await selected(field.ref);
        if (text) return text;
      }
      return null;
    }),
    read: (window, { all = false, picture: withPicture } = {}) => step('desktop.read', window, async () => {
      const seen = await view(window, all);
      if (withPicture === false || (!seen.drawn && !withPicture)) return seen.text;
      const lines = await pictureText(seen.id);
      note('with picture text');
      return [seen.text, '- picture (text read from the screen, not from controls):', renderLines(lines)].filter(Boolean).join('\n');
    }),
    click: (window, target, options) => step('desktop.click', target, async () => {
      const done = await act(window, target, options, ref => ad(['click', ref]), id => clickPicture(id, target, options));
      views.clear();
      return done?.via === 'picture' ? done : undefined;
    }),
    fill: (window, target, value, options) => step('desktop.fill', target, async () => {
      const typed = async id => {
        const clicked = await clickPicture(id, target, options);
        if (!clicked) return undefined;
        await ad(['--headed', 'type', '--window-id', id, '--stdin'], { input: String(value) });
        if (await pictureShows(id, String(value), SEEN_WAIT_MS)) return true;
        warn('desktop.fill "' + target + '" typed the text by picture, but the window does not show it afterwards.');
        return false;
      };
      const reply = await act(window, target, { roles: WRITABLE, ...options }, ref => ad(['set-value', ref, '--stdin'], { input: String(value) }), typed);
      return typeof reply === 'boolean' ? reply : confirmed('desktop.fill', target, reply);
    }),
    value: (window, target, options) => step('desktop.value', target, async () => {
      const reply = await act(window, target, options, ref => ad(['get', ref, '--property', 'value']));
      return reply?.value ?? reply;
    }),
    has: (window, target, options) => step('desktop.has', target, async () => {
      if (pick((await view(window)).controls, target, options)) return true;
      if (!pictureAllowed(target, options)) return false;
      const spot = await picture.find(await resolve(window), target, options);
      if (spot) note('in the picture');
      return Boolean(spot);
    }),
    waitFor: (window, target, { timeout = 10000, ...options } = {}) => step('desktop.waitFor', target, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const hit = pick((await view(window)).controls, target, options);
        if (hit) return hit.ref;
        if (pictureAllowed(target, options)) {
          const spot = await picture.find(await resolve(window), target, options);
          if (spot) {
            note('in the picture');
            return { via: 'picture', text: spot.hit.text, x: spot.hit.center.x, y: spot.hit.center.y };
          }
        }
        if (Date.now() >= until) throw Object.assign(new Error('No control named "' + target + '" appeared within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(200);
      }
    }),
    waitText: (window, text, timeout = 10000, options = {}) => step('desktop.waitText', text, async () => {
      const until = Date.now() + timeout;
      for (;;) {
        const seen = await view(window, true);
        const shown = seen.texts.find(value => value.includes(String(text)));
        if (shown) return shown;
        if (options.picture !== false) {
          const spot = await pictureShows(seen.id, String(text));
          if (spot) {
            note('in the picture');
            return spot.text;
          }
        }
        if (Date.now() >= until) throw Object.assign(new Error('The text "' + text + '" did not appear within ' + timeout + ' ms.'), { code: 'TIMEOUT' });
        await delay(200);
      }
    }),
    sleep: ms => delay(ms),
    cmd: (...args) => step('desktop.cmd', args[0], () => {
      views.clear();
      found.clear();
      return ad(args, { timeout: 120000 });
    }),
  };

  async function scene() {
    if (!last) return undefined;
    const { text } = await view(last);
    let screenshot;
    try { screenshot = (await picture.capture(last)).path; } catch { /* The window may be gone. */ }
    return { surface: 'desktop', window: last, view: text.length > VIEW_LIMIT ? text.slice(0, VIEW_LIMIT) + '\n… (cut)' : text, ...(screenshot ? { screenshot } : {}) };
  }

  return { desktop, scene };
}

module.exports = { createDesktop, renderTree };
