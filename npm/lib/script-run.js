'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { invoke } = require('./script-call');
const { createWeb } = require('./script-web');
const { createDesktop } = require('./script-desktop');
const { createVisible, readingMs } = require('./script-visible');
const { readPage } = require('./page-read');
const { inputUses, inputRefused } = require('./script-input');
const { argsView, missingArgs } = require('./script-args');
const { scanFinals, guardFinals, finalRefused } = require('./script-final');
const { screenWeb } = require('./script-screen');
const { fixable } = require('./script-fix');
const { surfaceRefused } = require('./routine-approvals');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SCENE_WAIT_MS = 8000;
const SUBJECT_LIMIT = 60;

const api = [
  'A script is the body of an async function. It runs many steps in one call and returns one JSON reply.',
  'Return a value to get it back as data.result. A step that fails stops the script; the reply then names the step',
  'and carries data.scene, a fresh read of the page or window, so the next script can continue from there.',
  'Values given with run --args JSON are read as args.name; a script that reads a name nobody gave stops with MISSING_ARGS.',
  '',
  'A target is the name shown in quotes by read(), a ref (@e5), or css:SELECTOR. When a name repeats, add',
  '{near: "text in the same row or card"}, {nth: 2} or {role: "button"}.',
  'Steps wait up to 4 s for a control that is not there yet, is disabled or is covered; {timeout: ms} changes that.',
  'A click on a control named like 发送, 提交, 付款, 删除, Send, Submit, Pay or Delete, and any step given {final: "what it does"},',
  'is a final step: without run --allow-final it is refused with FINAL_NOT_ALLOWED before anything is sent. {final: false} clears a name.',
  'Names reach into frames and shadow DOM. css: selectors and web.text()/web.table() see the top document only.',
  'read() lists controls, not messages. To see what an action produced, use waitText(), which returns the text.',
  'A line in data.steps says what the step changed: a window that opened, closed or changed title, a page that went to another',
  'address, a new tab or a dialog. A step that used the real mouse and keyboard says so, and data.input_used is then true.',
  'Desktop clicks, ticks and unconfirmed fills also say which controls changed: "合计" value "0.00" -> "231.00", "需要发票" checked,',
  '2 controls appeared: "确定", "取消". A value the step itself wrote shows only as value changed. "no control changed" covers',
  'controls only: text a window merely draws is not compared, so read the window or waitText() before calling a step failed,',
  'and never send a final step again on that line alone.',
  '',
  'The real mouse and keyboard (visible.*, human(), desktop.type, acting by picture, --headed) need run --allow-input. Without',
  'it such a step is refused with code INPUT_NOT_ALLOWED before anything is sent: ask the user, then run the steps that are',
  'left with --allow-input. Everything else runs in the background and leaves the mouse and keyboard alone.',
  '',
  'web (background browser, or your Chrome with --chrome):',
  '  await web.open(url)                     -> {url, title}',
  '  await web.read()                        -> controls only, with names and refs; web.read({all:true}) adds the page text',
  '  await web.fill(target, value)           await web.type(target, text)   (type sends real keys)',
  '  await web.click(target, {role, nth})    await web.press("Enter")',
  '  await web.select(target, option)        await web.check(target)        await web.uncheck(target)',
  '  await web.waitText(text, ms = 10000)    -> the text node that shows it, for example "订单号 D6176"',
  '  await web.waitFor(target, {timeout})    await web.has(target) -> true when the control is there and enabled',
  '  await web.waitIdle({timeout})           -> the page read once it stops changing; for when you cannot know what text will appear',
  '  await web.text()                        -> readable page text; web.text(target) -> text of one element',
  '  await web.value(target)                 await web.table(cssSelector?) -> rows of cell text',
  '  await web.eval("document.title")        await web.url()                await web.title()',
  '  await web.fetch(url)                    -> {url, via, text}: the text of another address, read without leaving the current page',
  '  await web.selection()                   -> the text the user selected on the page, or null',
  '  await web.cmd("scroll", "down", "600")  -> any agent-browser command, returns its data',
  '',
  'desktop (windows are ids from desktop.windows(), or part of an app name or title):',
  '  await desktop.windows(filter?)          -> [{id, app, title, minimized, focused}]',
  '  await desktop.apps(filter?)             -> installed apps [{name, id, kind, path, window_open}]',
  '  await desktop.launch(nameOrId)          -> {app, pid, window, title}: opens an installed app by its name, id or program name',
  '  await desktop.focused(window)           -> {role, name, ref} of the focused control, or null',
  '  await desktop.selection(window, target?) -> the text selected in that control, else in the focused one or the first text field that has a selection, or null',
  '  await desktop.read(window)              -> controls only, with names and refs; {all:true} adds labels and status text; {picture:true} adds the text on screen',
  '  await desktop.click(window, target)     await desktop.fill(window, target, value)',
  '  await desktop.check(window, target)     await desktop.uncheck(window, target)',
  '  await desktop.value(window, target)     await desktop.has(window, target)   await desktop.waitFor(window, target, {timeout})',
  '  await desktop.waitText(window, text, ms = 10000)  -> the line that shows the text',
  '  await desktop.waitIdle(window, {timeout}) -> the window read once it stops changing',
  '  await desktop.cmd("press", "ctrl+s", "--app", "notepad")  -> any agent-desktop command, returns its data',
  'A name no control has is looked for in the window\'s picture right away, and a window with no control outside its',
  'title bar is read from its picture; read() then lists that text as [picture x,y]. Acting by picture brings the window',
  'to the front and uses the real mouse and keyboard: click returns {via: "picture", text, x, y}, fill clicks the text,',
  'types, and returns false when the typed text cannot be seen afterwards. The same text in several places needs',
  '{near} or {nth}. {picture: false} keeps a step to controls; waitText takes it as a fourth argument.',
  '',
  'visible (the page in the Chrome window on screen, with the real mouse and keyboard; one helper is one thing a person does; needs --allow-input):',
  '  await visible.use(window?)              -> {title, url, text, controls}: binds the tab on screen; later helpers bind again when the page changes',
  '  await visible.read()                    -> the same, read fresh',
  '  await visible.click(name, {role, nth, expectText})      await visible.hover(name)',
  '  await visible.choose(name)              -> ticks a radio button or checkbox and confirms it: {changed, checked}; {off: true} clears a checkbox.',
  '                                             {gone: true} means the page moved on and the choice is no longer there to check',
  '  await visible.type(field, text, {multiline, replace, at}) -> true when the field shows the text. Text goes in at the caret, and a field',
  '                                             nobody clicked has its caret at the start: {at: "end"} appends, {multiline: true} lets a line break press Enter',
  '  await visible.scrollTo(text)            -> turns the wheel until the text is on screen; {over: "text inside a panel"} scrolls that panel',
  '  await visible.scroll(lines = 3, {over}) -> positive is down',
  '  await visible.open(url)                 -> opens the address in a new tab of the user\'s Chrome and binds it; never reuses an open tab',
  '  await visible.select(field, option)     -> picks one option of a dropdown on the screen page',
  '  await visible.press(keys)               -> presses keys in that Chrome window, for example "enter" or "ctrl+a"',
  '  await visible.waitText(text) / waitFor(name) / waitIdle() / has(name) -> the same waits and checks as web.*, on the screen page',
  'With --mode watch or record, web.* runs here on screen: the same script that runs in the background browser runs where the',
  'user can follow it. web.eval, table, fetch, cmd, selection, value and {near} work in the background browser only.',
  '',
  'acting like a person (for a recording or a demonstration; slower, takes the mouse and keyboard, needs --allow-input):',
  '  human("natural")                        -> from here on visible.*, desktop.click and desktop.type move and type like a person;',
  '                                             "careful" is slower near small targets; human(false) turns it off',
  '  await readTime(text)                    -> waits about as long as reading that text takes; returns at once while human() is off.',
  '                                             Use it instead of sleep(): a wait should follow what is on screen, not a fixed number.',
  '  await desktop.type(window, target, text, {multiline, at}) -> real keys into a field (desktop.fill writes the value directly and needs no keys)',
  '  await desktop.sequence(window, [{click: name}, {type: [name, text]}, {press: "ctrl+s"}]) -> several of these in one go: the names are',
  '                                             looked up once and the hand does not stop between them (about 0.4 s instead of 1 s)',
  '',
  'other:',
  '  await sleep(ms)   await waitFor(async () => condition, {timeout, interval})   log(...values)   expect(condition, message)',
  '  await flow(command, options)            -> any other slipwing command, for example flow("view", {window, output})',
  '',
  'Example:',
  '  await web.open("https://example.com/login");',
  '  await web.fill("邮箱", "a@example.com");',
  '  await web.click("下一步");',
  '  await web.waitText("验证码已发送");',
  '  return await web.read();',
].join('\n');

/** A misspelled helper answers with the helpers that exist, so the next script can be right. */
function named(name, helpers) {
  return new Proxy(helpers, {
    get(target, key) {
      if (typeof key !== 'string' || key in target || key === 'then') return target[key];
      throw Object.assign(new Error(name + '.' + key + ' is not a helper. ' + name + ' has: ' + Object.keys(target).sort().join(', ') + '.'), { code: 'INVALID_ARGS' });
    },
  });
}

/**
 * Commands started by a script keep the agent pointer on screen from the
 * first real input to the end of the script, not just for their own run.
 */
function holding(env) {
  return env.AGENT_DESKTOP_POINTER_HOLDER ? env : { ...env, AGENT_DESKTOP_POINTER_HOLDER: String(process.pid) };
}

function brief(subject) {
  const text = typeof subject === 'string' ? subject : subject === undefined ? '' : JSON.stringify(subject);
  return text.length > SUBJECT_LIMIT ? text.slice(0, SUBJECT_LIMIT) + '…' : text;
}

/** Runs a script against the page and desktop helpers and reports every step it took. */
async function runScript(source, { browser, native, flags = [], env, timeout = 120000, flow, call = invoke, picture, allowInput: allowInputOption = false,
  args = {}, allowFinal = false, onStep, watch = false, fix, finalsAtRunTime = false, hands, approvedRoutine = false, startPace, screen = false, openUrl } = {}) {
  const handsFree = () => (typeof allowInputOption === 'function' ? allowInputOption() : allowInputOption);
  let approvedOnce = false;
  const finalAllowed = () => {
    if (allowFinal) return true;
    if (!approvedOnce) return false;
    approvedOnce = false;
    return true;
  };
  const watching = () => watch || Boolean(onStep);
  const started = Date.now();
  env = holding(env ?? process.env);
  const steps = [], logs = [], warnings = [], children = new Set(), records = [], finals = [];
  const touched = { apps: new Set(), hosts: new Set() };
  let surface, inputUsed = false, effects = [];

  let notes = [];
  /**
   * Every command that takes the real mouse and keyboard passes here first. Without
   * --allow-input it is refused before anything is sent; with it, the step is marked.
   */
  const takeInput = what => {
    if (!handsFree()) throw inputRefused('This step needs the real mouse and keyboard' + (what ? ' (' + what + ')' : '') + ': the window comes to the front and the pointer moves.');
    hands?.using();
    inputUsed = true;
    if (!notes.includes('real mouse and keyboard')) notes.push('real mouse and keyboard');
  };
  const gate = args => { if (args.includes('--headed')) takeInput(); };
  const step = async (name, subject, run) => {
    const at = Date.now();
    surface = name.split('.')[0];
    const label = name + (brief(subject) ? ' ' + brief(subject) : '');
    notes = [];
    effects = [];
    const how = () => (notes.length ? ' (' + notes.join(', ') + ')' : '');
    let recorded = false;
    const record = ok => {
      recorded = true;
      const entry = { label, effects, input: notes.includes('real mouse and keyboard'), ms: Date.now() - at, ok };
      records.push(entry);
      return entry;
    };
    try {
      const value = await run();
      const done = record(true);
      if (onStep) await onStep(done);
      steps.push(label + how() + ' ' + (Date.now() - at) + 'ms');
      return value;
    } catch (err) {
      if (!recorded) record(false);
      steps.push(label + how() + ' ' + (Date.now() - at) + 'ms FAILED');
      if (err && typeof err === 'object' && !err.step) err.step = label;
      throw err;
    }
  };
  const need = (binary, name, check = () => {}) => (args, options) => {
    if (!binary) return Promise.reject(new Error(name + ' is not installed.'));
    try { check(args); } catch (err) { return Promise.reject(err); }
    return call(binary, args, { env, children, ...options });
  };
  const note = (text, effect) => {
    if (text) notes.push(text);
    if (effect) effects.push(effect);
  };
  const touch = ({ app, host }) => {
    if (!approvedRoutine) {
      const refused = surfaceRefused({ app, host });
      if (refused) throw refused;
    }
    if (app) touched.apps.add(app);
    if (host) touched.hosts.add(host);
  };
  const page = createWeb({
    call: need(browser, 'agent-browser'), step, warn: text => warnings.push(text), note, flags, touch, watching,
    fetchPage: url => readPage(browser, url, (binary, args, options) => need(binary, 'agent-browser')(args, options)),
  });
  let pace = startPace;
  const desk = createDesktop({ call: need(native, 'agent-desktop', gate), step, warn: text => warnings.push(text), note, picture, pace: () => pace,
    inputAllowed: handsFree, touch, watching, interrupted: () => Boolean(hands?.cutShort?.()) });
  const seen = createVisible({ step, warn: text => warnings.push(text), pace: () => pace, takeInput,
    pressKey: (window, key) => desk.desktop.sequence(window, [{ press: key }]),
    ...(openUrl ? { openUrl } : {}),
    flow: (command, options) => {
      if (!flow) throw new Error('The visible page helpers are not available here.');
      return flow(command, options, gate);
    } });
  const webSurface = screen ? screenWeb(seen.visible) : page.web;
  const guarded = guardFinals({ web: webSurface, desktop: desk.desktop, visible: seen.visible }, {
    allowed: finalAllowed,
    onFinal: final => finals.push(final),
    mark: (on, callArgs) => (on === 'web' && !screen ? page.markTarget(callArgs[0]) : on === 'desktop' ? desk.markTarget(callArgs[0], callArgs[1]) : undefined),
  });
  const sceneOf = async on => {
    try {
      const look = on === 'desktop' ? desk.scene() : on === 'web' && !screen ? page.scene() : on === 'visible' || on === 'web' ? seen.scene() : undefined;
      return await Promise.race([look, delay(SCENE_WAIT_MS)]);
    } catch { return undefined; }
  };
  const surfaces = fix ? fixable(guarded, {
    fixes: fix.fixes,
    waitHands: hands?.wait,
    allowOnce: () => { approvedOnce = true; },
    ask: async info => fix.ask({ ...info, scene: await sceneOf(info.surface) }),
    runPatch: patchSource => new AsyncFunction(...Object.keys(helpers), String(patchSource))(...Object.values(helpers)),
  }) : guarded;
  /**
   * A person took over: typing in progress is stopped, since their keys would mix into it; a pointer movement in
   * progress stops by itself when the cursor is moved, and any other command is left to finish. Whether something
   * was cut short is the answer.
   */
  hands?.bind?.({ abort: () => {
    let cut = false;
    for (const child of children) {
      if (child.spawnargs?.includes('--headed') && child.spawnargs.includes('type')) { child.kill(); cut = true; }
    }
    return cut;
  } });
  const helpers = {
    args: argsView(args),
    web: named('web', surfaces.web),
    desktop: named('desktop', surfaces.desktop),
    visible: named('visible', surfaces.visible),
    human: value => {
      if (![false, undefined, 'natural', 'careful'].includes(value)) throw Object.assign(new Error('human() takes "natural", "careful" or false.'), { code: 'INVALID_ARGS' });
      if (value && !handsFree() && !hands) throw inputRefused('human("' + value + '") moves the real mouse and keyboard.');
      pace = value || undefined;
    },
    readTime: text => (pace ? delay(readingMs(text) * (pace === 'careful' ? 1.3 : 1)) : Promise.resolve()),
    flow: (command, options = {}) => step('flow.' + command, '', () => {
      if (!flow || command === 'run') throw new Error('flow() cannot run "' + command + '".');
      return flow(String(command), options, gate);
    }),
    sleep: ms => delay(ms),
    waitFor: async (condition, { timeout: wait = 10000, interval = 200 } = {}) => {
      const until = Date.now() + wait;
      for (;;) {
        const value = await condition();
        if (value) return value;
        if (Date.now() >= until) throw Object.assign(new Error('The condition did not become true within ' + wait + ' ms.'), { code: 'TIMEOUT' });
        await delay(interval);
      }
    },
    log: (...values) => { logs.push(values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ')); },
    expect: (condition, message) => {
      if (!condition) throw Object.assign(new Error(message ?? 'An expectation in the script was not met.'), { code: 'EXPECTATION_FAILED' });
    },
  };

  const report = () => ({
    ...(warnings.length ? { warnings } : {}), ...(logs.length ? { logs } : {}), steps,
    ...(inputUsed ? { input_used: true } : {}), ...(finals.length ? { finals } : {}), elapsed_ms: Date.now() - started,
  });
  const trail = () => ({ records, apps: [...touched.apps], hosts: [...touched.hosts] });
  const withTrail = (target, value = trail()) => Object.defineProperty(target, 'trail', { value, enumerable: false });
  let body;
  try { body = new AsyncFunction(...Object.keys(helpers), source); } catch (err) {
    throw Object.assign(new Error('The script does not parse: ' + err.message), { code: 'INVALID_ARGS', report: report() });
  }
  const missing = missingArgs(source, args);
  if (missing.length) {
    throw Object.assign(new Error('The script reads arguments that were not given: ' + missing.join(', ') + '. Pass them with --args JSON.'),
      { code: 'MISSING_ARGS', details: { needs: missing }, report: report() });
  }
  const seenFinals = allowFinal || finalsAtRunTime ? [] : scanFinals(source);
  if (seenFinals.length) {
    throw Object.assign(finalRefused('This script has final steps (' + seenFinals.map(f => f.what + ': ' + f.why).join('; ') + '), so none of it ran.',
      { finals: seenFinals }), { report: report() });
  }
  const uses = handsFree() || hands ? [] : inputUses(source);
  if (uses.length) {
    throw Object.assign(inputRefused('This script uses the real mouse and keyboard (' + uses.join(', ') + '), so none of it ran.',
      'Ask the user first; when they agree, run it again with --allow-input.'), { report: report() });
  }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The script did not finish within ' + timeout + ' ms.'), { code: 'TIMEOUT' })), timeout);
  });
  try {
    const result = await Promise.race([body(...Object.values(helpers)), expired]);
    return withTrail({ result: result === undefined ? null : result, ...report() });
  } catch (thrown) {
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    for (const child of children) child.kill();
    let scene;
    try {
      const look = surface === 'desktop' ? desk.scene() : surface === 'web' ? page.scene() : surface === 'visible' ? seen.scene() : undefined;
      scene = await Promise.race([look, delay(SCENE_WAIT_MS)]);
    } catch { /* The page or window may be gone. */ }
    err.report = { ...(err.step ? { step: err.step } : {}), ...report(), ...(scene ? { scene } : {}) };
    withTrail(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runScript, api };
