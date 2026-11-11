'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { invoke } = require('./script-call');
const { createWeb } = require('./script-web');
const { createDesktop } = require('./script-desktop');
const { readPage } = require('./page-read');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SCENE_WAIT_MS = 8000;
const SUBJECT_LIMIT = 60;

const api = [
  'A script is the body of an async function. It runs many steps in one call and returns one JSON reply.',
  'Return a value to get it back as data.result. A step that fails stops the script; the reply then names the step',
  'and carries data.scene, a fresh read of the page or window, so the next script can continue from there.',
  '',
  'A target is the name shown in quotes by read(), a ref (@e5), or css:SELECTOR. When a name repeats, add',
  '{near: "text in the same row or card"}, {nth: 2} or {role: "button"}.',
  'Steps wait up to 4 s for a control that is not there yet, is disabled or is covered; {timeout: ms} changes that.',
  'Names reach into frames and shadow DOM. css: selectors and web.text()/web.table() see the top document only.',
  'read() lists controls, not messages. To see what an action produced, use waitText(), which returns the text.',
  '',
  'web (background browser, or your Chrome with --chrome):',
  '  await web.open(url)                     -> {url, title}',
  '  await web.read()                        -> controls only, with names and refs; web.read({all:true}) adds the page text',
  '  await web.fill(target, value)           await web.type(target, text)   (type sends real keys)',
  '  await web.click(target, {role, nth})    await web.press("Enter")',
  '  await web.select(target, option)        await web.check(target)        await web.uncheck(target)',
  '  await web.waitText(text, ms = 10000)    -> the text node that shows it, for example "订单号 D6176"',
  '  await web.waitFor(target, {timeout})    await web.has(target) -> true when the control is there and enabled',
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
  '  await desktop.read(window)              -> controls only, with names and refs; {all:true} adds labels and status text',
  '  await desktop.click(window, target)     await desktop.fill(window, target, value)',
  '  await desktop.check(window, target)     await desktop.uncheck(window, target)',
  '  await desktop.value(window, target)     await desktop.has(window, target)   await desktop.waitFor(window, target, {timeout})',
  '  await desktop.waitText(window, text, ms = 10000)  -> the line that shows the text',
  '  await desktop.cmd("press", "ctrl+s", "--app", "notepad")  -> any agent-desktop command, returns its data',
  '',
  'other:',
  '  await sleep(ms)   await waitFor(async () => condition, {timeout, interval})   log(...values)   expect(condition, message)',
  '  await flow(command, options)            -> any other agent-desktop-workflow command, for example flow("view", {window, output})',
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

function brief(subject) {
  const text = typeof subject === 'string' ? subject : subject === undefined ? '' : JSON.stringify(subject);
  return text.length > SUBJECT_LIMIT ? text.slice(0, SUBJECT_LIMIT) + '…' : text;
}

/** Runs a script against the page and desktop helpers and reports every step it took. */
async function runScript(source, { browser, native, flags = [], env, timeout = 120000, flow, call = invoke } = {}) {
  const started = Date.now();
  const steps = [], logs = [], warnings = [], children = new Set();
  let surface;

  const step = async (name, subject, run) => {
    const at = Date.now();
    surface = name.split('.')[0];
    const label = name + (brief(subject) ? ' ' + brief(subject) : '');
    try {
      const value = await run();
      steps.push(label + ' ' + (Date.now() - at) + 'ms');
      return value;
    } catch (err) {
      steps.push(label + ' ' + (Date.now() - at) + 'ms FAILED');
      if (err && typeof err === 'object' && !err.step) err.step = label;
      throw err;
    }
  };
  const need = (binary, name) => (args, options) => {
    if (!binary) return Promise.reject(new Error(name + ' is not installed.'));
    return call(binary, args, { env, children, ...options });
  };
  const page = createWeb({
    call: need(browser, 'agent-browser'), step, warn: text => warnings.push(text), flags,
    fetchPage: url => readPage(browser, url, (binary, args, options) => need(binary, 'agent-browser')(args, options)),
  });
  const desk = createDesktop({ call: need(native, 'agent-desktop'), step, warn: text => warnings.push(text) });
  const helpers = {
    web: named('web', page.web),
    desktop: named('desktop', desk.desktop),
    flow: (command, options = {}) => step('flow.' + command, '', () => {
      if (!flow || command === 'run') throw new Error('flow() cannot run "' + command + '".');
      return flow(String(command), options);
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
    ...(warnings.length ? { warnings } : {}), ...(logs.length ? { logs } : {}), steps, elapsed_ms: Date.now() - started,
  });
  let body;
  try { body = new AsyncFunction(...Object.keys(helpers), source); } catch (err) {
    throw Object.assign(new Error('The script does not parse: ' + err.message), { code: 'INVALID_ARGS', report: report() });
  }
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The script did not finish within ' + timeout + ' ms.'), { code: 'TIMEOUT' })), timeout);
  });
  try {
    const result = await Promise.race([body(...Object.values(helpers)), expired]);
    return { result: result === undefined ? null : result, ...report() };
  } catch (thrown) {
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    for (const child of children) child.kill();
    let scene;
    try {
      const look = surface === 'desktop' ? desk.scene() : surface === 'web' ? page.scene() : undefined;
      scene = await Promise.race([look, delay(SCENE_WAIT_MS)]);
    } catch { /* The page or window may be gone. */ }
    err.report = { ...(err.step ? { step: err.step } : {}), ...report(), ...(scene ? { scene } : {}) };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runScript, api };
