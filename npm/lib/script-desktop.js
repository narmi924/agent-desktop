'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { pick } = require('./script-match');
const { createPicture, renderLines } = require('./script-picture');
const { inputRefused } = require('./script-input');
const { markedPicture } = require('./final-picture');
const { describeChanges } = require('./control-changes');

const WRITABLE = ['textfield', 'combobox', 'incrementor', 'slider'];
const TICKS = ['checkbox', 'radiobutton', 'switch'];
const VALUE_LIMIT = 200;
const VIEW_LIMIT = 6000;
const PATIENCE_MS = 4000;
const SELECTION_FIELDS = 5;
const SEEN_WAIT_MS = 1500;
const TYPE_WAIT_MS = 30000;
const TYPE_KEY_MS = 700;
const QUIET_MS = 400;
const EFFECT_LIMIT = 3;
const CHANGE_SETTLE_MS = 250;
const BLOCKED_AFTER_MS = 1500;
const BLOCKED_POLL_MS = 600;

/** A read without the read's own id in each ref, so two reads of an unchanged window compare equal. */
function withoutReadIds(text) {
  return text.replace(/@s[a-z0-9]+:/g, '@');
}

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
    checked: (node.states ?? []).includes('checked') || (node.role === 'radiobutton' && (node.states ?? []).includes('selected')),
    focused: (node.states ?? []).includes('focused'), title });
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

/**
 * A window in front reports focus on itself and on the control that holds the keyboard inside it.
 * The one that matters is the innermost.
 */
function innermostFocused(controls) {
  return controls.filter(control => control.focused)
    .reduce((best, control) => (!best || control.depth >= best.depth ? control : best), undefined);
}

const isRef = target => /^@\w+:e\d+$/.test(String(target));

/**
 * Desktop helpers for a script. A window is an id from list-windows or part of an app name or title.
 * A name is looked for among the window's controls first; when no control has it, the window's
 * picture is read and the text found there is used instead, unless the call passes {picture: false}.
 */
const MAX_STRAY = 3;

/**
 * How much of `keys` went in after `before` when typing was stopped part way: the characters that match, and how many
 * stray ones follow them (a slip not yet taken back). Undefined when the field no longer starts with what it held.
 */
function typedSoFar(before, after, keys) {
  if (typeof after !== 'string' || !after.startsWith(before)) return undefined;
  const added = after.slice(before.length);
  let done = 0;
  while (done < added.length && done < keys.length && added[done] === keys[done]) done++;
  const stray = added.length - done;
  return stray <= MAX_STRAY ? { done, stray } : undefined;
}

function createDesktop({ call, step, warn, note = () => {}, picture: makePicture = createPicture, pace = () => undefined, inputAllowed = () => true, touch = () => {}, watching = () => false, interrupted = () => false }) {
  const views = new Map(), found = new Map(), drawnWindows = new Set(), apps = new Map(), readIds = new Map(), written = new Set();
  let last, listed, pending, windowEffects = 0;
  const ad = (args, options) => call(args.map(String), pending ? { signal: pending, ...options } : options);
  const picture = makePicture({ ad });
  const asPerson = () => (pace() ? ['--headed', '--human', pace()] : []);
  const fieldValue = async ref => {
    try { const reply = await ad(['get', ref, '--property', 'value']); return typeof reply === 'string' ? reply : reply?.value; } catch { return undefined; }
  };

  async function windows(filter) {
    const wanted = filter === undefined ? undefined : String(filter).toLowerCase();
    const all = listed ?? await ad(['list-windows']);
    listed = undefined;
    for (const w of all) apps.set(w.id, w.app_name);
    return all
      .filter(w => !wanted || w.id === filter || (w.app_name ?? '').toLowerCase().includes(wanted) || (w.title ?? '').toLowerCase().includes(wanted))
      .map(w => ({ id: w.id, app: w.app_name, title: w.title, minimized: Boolean(w.minimized), focused: Boolean(w.is_focused) }));
  }

  async function resolve(window) {
    const id = await resolveId(window);
    if (apps.has(id)) touch({ app: apps.get(id) });
    return id;
  }

  async function resolveId(window) {
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
    if (snapshot?.snapshot_id) readIds.set(id, snapshot.snapshot_id);
    written.delete(id);
    if (rendered.drawn) drawnWindows.add(id); else drawnWindows.delete(id);
    last = id;
    return { id, ...rendered };
  }

  /**
   * What a step changed inside its window: controls whose value or state changed, controls that appeared or went
   * away, or that no control changed. Text that is only drawn, such as a status label with no accessible name, is not
   * compared, so "no control changed" never means the step had no effect. The window is read once more against the
   * read the step acted on
   * (snapshot --since); that read is kept, so the next step in the same window starts from it instead of reading
   * again. When nothing changed yet, it looks once more after a short wait, since apps update a moment later.
   */
  /**
   * Values written into a window since it was last read make that read an unfair base for the next comparison: the
   * next step that reports changes reads the window first, so it reports only what it changed itself.
   */
  function fromFreshRead(window) {
    const id = knownId(window);
    if (id && written.has(id)) { views.delete(id); written.delete(id); }
  }

  /** The id of a window this script already found, without listing windows again. */
  function knownId(window) {
    return /^w-\d+$/.test(String(window)) ? String(window) : found.get(window);
  }

  async function controlEffects(window, { hidden, written: sent, settle = true } = {}) {
    let id;
    try { id = await resolve(window); } catch { return false; }
    const since = readIds.get(id);
    if (!since || drawnWindows.has(id)) return false;
    for (let attempt = 0; ; attempt++) {
      let snapshot;
      try { snapshot = await ad(['snapshot', '--window-id', id, '--compact', '--max-depth', '50', '-i', '--since', since]); } catch { return false; }
      views.set(id, renderTree(snapshot).controls);
      if (snapshot?.snapshot_id) readIds.set(id, snapshot.snapshot_id);
      const lines = describeChanges(snapshot?.changes, { hidden, written: sent });
      if (lines.length) {
        lines.forEach(([text, effect], index) => note(index < EFFECT_LIMIT ? text : undefined, effect));
        if (lines.length > EFFECT_LIMIT) note((lines.length - EFFECT_LIMIT) + ' more control changes');
        return true;
      }
      if (windowEffects > 0 || !snapshot?.changes) return true;
      if (attempt >= 1 || !settle) { note('no control changed', { kind: 'no_change' }); return true; }
      await delay(CHANGE_SETTLE_MS);
    }
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
    const tryPicture = id => (inputAllowed() ? byPicture(id) : refuseByPicture(id, target, options));
    for (;;) {
      const id = usePicture ? await resolve(window) : undefined;
      if (usePicture && drawnWindows.has(id)) {
        const done = await tryPicture(id);
        if (done !== undefined) return done;
        drawnWindows.delete(id);
      } else {
        try { return await run(await locate(window, target, options)); } catch (err) {
          const named = !isRef(target);
          if (!named || !['STALE_REF', 'ELEMENT_NOT_FOUND', 'WINDOW_NOT_FOUND'].includes(err.code)) throw err;
          if (usePicture && err.code === 'ELEMENT_NOT_FOUND') {
            const done = await tryPicture(id);
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

  /**
   * Without --allow-input a name found only in the picture is refused before the window moves:
   * the picture is read where the window is, and the reply says where it shows the name.
   */
  async function refuseByPicture(id, target, options) {
    const spot = await picture.find(id, target, options);
    if (!spot) return undefined;
    throw inputRefused('No control is named "' + target + '" in this window. Its picture shows it at ' + spot.hit.center.x + ',' + spot.hit.center.y +
      ', and acting on the picture needs the real mouse and keyboard: the window comes to the front and the pointer moves.');
  }

  /** A person clicks only the window in front: a human-paced click on a window behind others brings it forward first. */
  async function bringForward(window) {
    try {
      await ad(['--headed', 'focus-window', '--window-id', await resolve(window)]);
    } catch { /* the click itself reports a window that stayed behind */ }
  }

  /** Windows that opened, closed or changed title while `run` ran, as notes on the step. */
  async function watchWindows(run) {
    const list = async () => {
      try { return await ad(['list-windows']); } catch { return undefined; }
    };
    windowEffects = 0;
    const before = await list();
    listed = before;
    const shown = w => w.visible !== false && !w.minimized;
    let result;
    const control = before ? new AbortController() : undefined;
    try {
      pending = control?.signal;
      const running = run();
      result = control ? await Promise.race([running, blocked(before.filter(shown), running, control)]) : await running;
    } finally { listed = undefined; pending = undefined; }
    const after = before && await list();
    if (!before || !after) return result;
    const was = new Map(before.filter(shown).map(w => [w.id, w]));
    const now = new Map(after.filter(shown).map(w => [w.id, w]));
    const effects = [
      ...[...now.values()].filter(w => !was.has(w.id)).map(w => ['opened window "' + w.title + '" ' + w.id, { kind: 'window_opened', app: w.app_name, title: w.title }]),
      ...[...was.values()].filter(w => !now.has(w.id)).map(w => ['closed window "' + w.title + '"', { kind: 'window_closed', app: w.app_name, title: w.title }]),
      ...[...now.values()].filter(w => was.has(w.id) && was.get(w.id).title !== w.title)
        .map(w => ['window title "' + was.get(w.id).title + '" -> "' + w.title + '"', { kind: 'window_title', app: w.app_name, title: w.title }]),
    ];
    windowEffects = effects.length;
    effects.forEach(([text, effect], index) => note(index < EFFECT_LIMIT ? text : undefined, effect));
    if (effects.length > EFFECT_LIMIT) note((effects.length - EFFECT_LIMIT) + ' more window changes');
    return result;
  }

  /**
   * A click whose app opens a modal dialog can wait until the dialog closes. A window that opens while the action
   * still waits ends the wait: the waiting command stops, the step counts as sent, and the new window is its effect.
   */
  async function blocked(before, running, control) {
    let done = false;
    running.then(() => { done = true; }, () => { done = true; });
    const known = new Set(before.map(w => w.id));
    await delay(BLOCKED_AFTER_MS);
    while (!done) {
      let now;
      try { now = await call(['list-windows'], {}); } catch { now = undefined; }
      const opened = (now ?? []).filter(w => !known.has(w.id) && w.visible !== false && !w.minimized);
      if (opened.length && !done) {
        running.catch(() => {});
        control.abort(Object.assign(new Error('A window opened while the step waited.'), { code: 'ACTION_BLOCKED' }));
        warn('The step opened ' + opened.map(w => '"' + w.title + '"').join(', ') + ' and the app waits for it; the step was sent but not confirmed.');
        return undefined;
      }
      await delay(BLOCKED_POLL_MS);
    }
    return running;
  }

  /** Clicks where the picture shows the text: the window comes to the front and the real mouse moves. */
  async function clickPicture(id, target, options) {
    await ad(['--headed', 'focus-window', '--window-id', id]);
    const spot = await picture.find(id, target, options);
    if (!spot) return undefined;
    const { x, y } = spot.hit.center;
    const report = await ad(['--headed', '--when-idle', '600', ...asPerson().slice(1), 'mouse-click', '--frame', spot.shot.path, '--xy', x + ',' + y]);
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
    fromFreshRead(window);
    let clicked = false;
    await act(window, target, kind, async ref => {
      const box = views.get(await resolve(window))?.find(control => control.ref === ref);
      if (!box || box.checked !== wanted) { await ad(['click', ref]); clicked = true; }
    });
    windowEffects = 0;
    const fresh = clicked && await controlEffects(window, { settle: false });
    const kept = views.get(await resolve(window));
    const after = pick((clicked && !fresh) || !kept ? (await view(window)).controls : kept, target, kind);
    if (after?.checked !== wanted) warn((wanted ? 'desktop.check' : 'desktop.uncheck') + ' "' + target + '" was sent, but the box did not change.');
    return after?.checked === wanted;
  });

  /**
   * Several real-input actions in one window, sent as one native batch: every name is looked up from one read of the
   * window first, so nothing is read again between them. Steps are {click: name}, {type: [name, text]} or {press: keys}.
   */
  async function sequence(window, actions) {
    if (!Array.isArray(actions) || !actions.length) throw Object.assign(new Error('desktop.sequence takes a window and a list like [{click: "保存"}, {type: ["备注", "文字"]}, {press: "enter"}].'), { code: 'INVALID_ARGS' });
    const id = await resolve(window);
    const { controls } = await view(id);
    const ref = name => {
      const hit = pick(controls, name);
      if (!hit?.ref) throw Object.assign(new Error('No control is named "' + name + '" in this window.'), { code: 'ELEMENT_NOT_FOUND' });
      return hit.ref;
    };
    const entries = actions.map(action => {
      if (action.click !== undefined) return { command: 'click', args: { ref_id: ref(action.click) } };
      if (action.type !== undefined) return { command: 'type', args: { ref_id: ref(action.type[0]), text: String(action.type[1]) } };
      if (action.press !== undefined) return { command: 'press', args: { combo: String(action.press), window_id: id } };
      throw Object.assign(new Error('Each step of desktop.sequence is {click}, {type} or {press}.'), { code: 'INVALID_ARGS' });
    });
    if (pace()) await bringForward(id);
    const reply = await watchWindows(() => ad([...(pace() ? ['--headed', '--human', pace()] : ['--headed']), 'batch', JSON.stringify(entries)], { timeout: 30000 + 15000 * entries.length }));
    views.clear();
    await controlEffects(id, { written: actions.filter(action => action.type !== undefined).map(action => String(action.type[1])) });
    const failed = (reply?.results ?? []).find(r => r.ok === false);
    if (failed) throw Object.assign(new Error('desktop.sequence stopped at ' + failed.command + ': ' + (failed.error?.message ?? 'failed')), { code: failed.error?.code ?? 'ACTION_FAILED', disposition: failed.error?.disposition });
    return reply?.completed_entries ?? entries.length;
  }

  /**
   * Writes a value into a field, or picks an option of a drop-down, without keys: set-value on the control. A name
   * found only in the window's picture is clicked and typed instead. `label` names the step as the script called it.
   */
  function fillAs(label, { window, target, value, options }) {
    return step(label, target, async () => {
      const typed = async id => {
        const clicked = await clickPicture(id, target, options);
        if (!clicked) return undefined;
        await ad(['--headed', 'type', '--window-id', id, '--stdin'], { input: String(value) });
        if (await pictureShows(id, String(value), SEEN_WAIT_MS)) return true;
        warn(label + ' "' + target + '" typed the text by picture, but the window does not show it afterwards.');
        return false;
      };
      const reply = await act(window, target, { roles: WRITABLE, ...options }, ref => ad(['set-value', ref, '--stdin'], { input: String(value) }), typed);
      if (typeof reply === 'boolean') return reply;
      const ok = confirmed(label, target, reply);
      if (ok) written.add(await resolve(window));
      else { windowEffects = 0; await controlEffects(window, { hidden: target, written: String(value), settle: false }); }
      return ok;
    });
  }

  const desktop = {
    sequence: (window, actions) => step('desktop.sequence', window, () => sequence(window, actions)),
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
      const hit = innermostFocused((await view(window, true)).controls);
      return hit ? { role: hit.role, name: hit.name, ref: hit.ref ?? null } : null;
    }),
    selection: (window, target, options) => step('desktop.selection', target ?? window, async () => {
      const selected = async ref => (await ad(['get', ref, '--property', 'selection'])).value ?? null;
      if (target !== undefined) return act(window, target, options, selected);
      const controls = (await view(window)).controls.filter(control => control.ref);
      const focused = innermostFocused(controls);
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
      fromFreshRead(window);
      const done = await watchWindows(() => act(window, target, options, async ref => {
        if (pace()) await bringForward(window);
        return ad([...asPerson(), 'click', ref]);
      }, id => clickPicture(id, target, options)));
      views.clear();
      if (done?.via !== 'picture') await controlEffects(window);
      return done?.via === 'picture' ? done : undefined;
    }),
    fill: (window, target, value, options) => fillAs('desktop.fill', { window, target, value, options }),
    select: (window, target, option, options) => fillAs('desktop.select', { window, target, value: option, options }),
    type: (window, target, text, options) => step('desktop.type', target, async () => {
      const keys = String(text);
      const entry = [...(options?.multiline ? ['--entry-mode', 'multiline'] : []), ...(options?.at ? ['--at', options.at] : [])];
      const reply = await watchWindows(() => act(window, target, { roles: WRITABLE, ...options }, async ref => {
        const before = !options?.at || options.at === 'end' ? await fieldValue(ref) : undefined;
        try {
          return await ad(['--headed', ...asPerson().slice(1), 'type', ref, '--stdin', ...entry], { input: keys, timeout: TYPE_WAIT_MS + keys.length * TYPE_KEY_MS });
        } catch (err) {
          if (!interrupted() || typeof before !== 'string') throw err;
          const so = typedSoFar(before, await fieldValue(ref), keys);
          if (!so) throw err;
          if (so.stray) await ad(['set-value', ref, '--stdin'], { input: before + keys.slice(0, so.done) });
          throw Object.assign(new Error('PERSON_TOOK_OVER: typing stopped after ' + so.done + ' of ' + keys.length +
            ' characters; the rest goes in at the end once nobody touches the mouse or keyboard.'),
          { code: 'PERSON_TOOK_OVER', resumeWith: [window, target, keys.slice(so.done), { ...options, at: 'end' }] });
        }
      }));
      views.clear();
      const ok = confirmed('desktop.type', target, reply);
      if (ok) written.add(await resolve(window));
      else await controlEffects(window, { hidden: target, written: keys, settle: false });
      return ok;
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
      const send = () => ad(args, { timeout: 120000 });
      return args[0] === 'press' ? watchWindows(send) : send();
    }),
    waitIdle: (window, { timeout = 10000, quiet = QUIET_MS } = {}) => step('desktop.waitIdle', window, async () => {
      const until = Date.now() + timeout;
      let last, since = Date.now();
      for (;;) {
        const { text } = await view(window, true);
        const content = withoutReadIds(text);
        if (content !== last) { last = content; since = Date.now(); } else if (Date.now() - since >= quiet) return text;
        if (Date.now() >= until) {
          warn('desktop.waitIdle: the window was still changing after ' + timeout + ' ms; this is its latest read.');
          return text;
        }
        await delay(150);
      }
    }),
  };

  /** A picture of the window with the target framed in red, for a step that was refused before it was sent. */
  async function markTarget(window, target) {
    const id = await resolve(window);
    const ref = await locate(window, target);
    const box = (await ad(['get', ref, '--property', 'bounds'])).value;
    const frame = (await ad(['list-windows'])).find(w => w.id === id)?.bounds;
    if (!box || !frame) return undefined;
    return markedPicture(async path => { await ad(['screenshot', '--window-id', id, path]); }, png => {
      const left = frame.x + Math.max(0, (frame.width - png.width) / 2);
      return { x: box.x - left, y: box.y - frame.y, width: box.width, height: box.height };
    });
  }

  async function scene() {
    if (!last) return undefined;
    const { text } = await view(last);
    let screenshot;
    try { screenshot = (await picture.capture(last)).path; } catch { /* The window may be gone. */ }
    return { surface: 'desktop', window: last, view: text.length > VIEW_LIMIT ? text.slice(0, VIEW_LIMIT) + '\n… (cut)' : text, ...(screenshot ? { screenshot } : {}) };
  }

  return { desktop, markTarget, scene };
}

module.exports = { createDesktop, renderTree, typedSoFar };
