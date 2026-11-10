#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { basename, delimiter, isAbsolute, join } = require('node:path');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { prepareChoice, finishChoice, revealText } = require('../lib/choose');
const { view, move, edit, tap } = require('../lib/window-move');
const { browserMove, dropFile } = require('../lib/browser-move');
const { current, follow, editPage } = require('../lib/current-page');
const { choosePage } = require('../lib/page-choice');
const { typePage } = require('../lib/page-input');
const { wheelPage, pointerPage, physicalPointer } = require('../lib/page-pointer');
const { recordStep, readSteps } = require('../lib/flow-record');
const { connect, disconnect, webPerform, withRoute } = require('../lib/web-page');
const { runScript, api } = require('../lib/script-run');
const { space, spaceFlags } = require('../lib/space');
const { readPage } = require('../lib/page-read');

const usage = [
  'agent-desktop-workflow connect [--cdp URL]   (once: lets page commands use your running Chrome without taking the foreground)',
  'agent-desktop-workflow disconnect',
  'agent-desktop-workflow current [--window ID | --page PAGE]',
  'agent-desktop-workflow follow --page PAGE (--link NAME [--expect-url URL] | --button NAME --expect-url URL) [--visible]',
  'agent-desktop-workflow type --page PAGE --field NAME (--value TEXT | --stdin) [--interval-ms MS] [--multiline] [--replace] [--after IMAGE.png] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow wheel --page PAGE --over VISIBLE_TEXT [--lines N] [--until TEXT] [--human natural|careful] [--seed N] (positive is down)',
  'agent-desktop-workflow point --page PAGE --on NAME [--role ROLE] [--nth N] [--expect-text TEXT] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow click --page PAGE --on NAME [--role ROLE] [--nth N] [--expect-text TEXT] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow edit --page PAGE --field NAME (--value TEXT | --stdin)',
  'agent-desktop-workflow choose --page PAGE --field LABEL --value OPTION [--within SECTION] [--open BUTTON] [--popup PANEL] [--advance BUTTON] [--search FIELD] [--confirm BUTTON] [--expect-value TEXT]',
  'agent-desktop-workflow choose --session NAME [--tab TAB] (--field LABEL | --input CSS) --value VALUE [--position N] [--format DATE_FORMAT]',
  'agent-desktop-workflow choose-file --session NAME [--tab TAB] --input CSS --file ABSOLUTE_PATH',
  'agent-desktop-workflow reveal --session NAME [--tab TAB] --within CSS --text EXACT_TEXT',
  'agent-desktop-workflow view (--window ID | --app NAME) --output IMAGE.png [--region X,Y,W,H] [--popups]',
  'agent-desktop-workflow edit (--window ID | --app NAME) --document TAB_NAME [--field LABEL] (--value TEXT | --stdin)',
  'agent-desktop-workflow move --frame IMAGE.png --from X,Y --to X,Y [--to-frame DEST.png] [--after IMAGE.png] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow tap --frame IMAGE.png (--at X,Y | --text VISIBLE_TEXT [--nth N]) [--button left|right|middle] [--count N] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow browser-move --session NAME [--tab TAB] --surface CSS --from X,Y --to X,Y [--object CSS] [--after IMAGE.png]',
  'agent-desktop-workflow drop-file --session NAME [--tab TAB] --input DROP_ZONE_CSS --file ABSOLUTE_PATH',
  'agent-desktop-workflow replay --file FLOW.jsonl [--window ID] [--speed N]   (record a flow by setting AGENT_DESKTOP_RECORD=FLOW.jsonl)',
  'agent-desktop-workflow run [--file SCRIPT.js] [--session NAME | --space | --chrome] [--timeout-ms MS]   (many page and desktop steps in one call; the script comes from stdin without --file; run --api lists the helpers)',
  'agent-desktop-workflow read --url URL   (the text of a web page: a plain request and a background browser run together and the first full answer is returned)',
  'agent-desktop-workflow space [--login URL | --close]   (the agent\'s own browser profile: --login shows its window so the user signs in once; later runs with --space keep that sign-in in the background)',
].join('\n');

function one(items, description) {
  if (items.length !== 1) throw new Error('Expected one ' + description + ', found ' + items.length);
  return items[0];
}

function run(binary, args, input) {
  let out;
  try {
    const timeout = args[0] === 'type' && args.includes('--interval-ms') ? 0 : 15000;
    out = execFileSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: args[0] === 'screenshot' ? 96 * 1024 * 1024 : 8 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (!err.stdout) throw new Error('Cannot execute ' + basename(binary) + ' (' + (err.code ?? 'command failed') + ')');
    out = err.stdout;
  }
  const reply = JSON.parse(out);
  if (!(reply.ok ?? reply.success)) {
    const message = reply.error?.message ?? reply.error ?? 'Command refused';
    const error = new Error(String(message).replace(/^Evaluation error: Error: ([^\n]*)\n\s+at [\s\S]*$/, '$1'));
    if (reply.error?.code) Object.assign(error, {code:reply.error.code, details:reply.error.details, disposition:reply.error.disposition});
    throw error;
  }
  return reply.data;
}

function boundTab(session, tab) {
  const binary = browserBinary();
  const args = ['--session', session, '--pin-tab', '--json'];
  const ab = (...command) => run(binary, [...args, ...command]);
  const tabs = () => ab('tab', 'list').tabs;
  const original = one(tabs().filter(t => tab ? [t.targetId, t.tabId, t.label].includes(tab) : t.active), 'matching tab');
  if (!original.targetId) throw new Error('Cannot bind the requested tab.');
  if (tab) ab('tab', original.targetId);
  const check = () => {
    if (one(tabs().filter(t => t.active), 'active session tab').targetId !== original.targetId) throw new Error('The session changed tabs.');
  };
  const evaluate = (fn, ...params) => run(binary, [...args, 'eval', '--stdin'],
    '(' + fn.toString() + ')(...' + JSON.stringify(params) + ')').result;
  return { ab, original, check, evaluate };
}

function choose({ session, tab, field, input, value, position, format }) {
  if (!session || Boolean(field) === Boolean(input) || !value ||
      (position !== undefined && (!/^[1-9]\d*$/.test(position) || !Number.isSafeInteger(Number(position))))) throw new Error(usage);
  const { ab, original, check, evaluate } = boundTab(session, tab);
  const key = 'data-ad-' + randomUUID();
  try {
    check();
    const spec = { field, input, value, position: Number(position) || null, format, key, url: original.url };
    let choice = evaluate(prepareChoice, spec);
    check();
    if (choice.action === 'open') {
      ab('click', choice.selector);
      check();
      choice = evaluate(prepareChoice, spec, true);
      check();
    }
    if (choice.action === 'date') evaluate(finishChoice, key, 'date');
    if (choice.action === 'fill' || choice.action === 'select') ab(choice.action, choice.selector, choice.argument);
    if (choice.action === 'click') ab('click', choice.selector);
    const selected = evaluate(finishChoice, key);
    check();
    return { tab: original.tabId, targetId: original.targetId, ...selected };
  } finally {
    // Only the original document holds this per-call marker.
    try { evaluate(finishChoice, key, 'clean'); } catch { /* The document may have closed. */ }
  }
}

function browserBinary() {
  if (process.env.AGENT_BROWSER_BIN) return process.env.AGENT_BROWSER_BIN;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-' + process.arch + '.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Set AGENT_BROWSER_BIN to the installed agent-browser executable.');
}

function optionalBrowserBinary() {
  try { return browserBinary(); } catch { return undefined; }
}

async function browserPid(url) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('A local headed Chromium session is required.');
  const socket = new WebSocket(url);
  try {
    const processes = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser process lookup timed out')), 4000);
      const fail = () => { clearTimeout(timer); reject(new Error('Cannot identify the browser process')); };
      socket.onerror = fail;
      socket.onclose = fail;
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
      socket.onmessage = ({ data }) => {
        try {
          const msg = JSON.parse(data);
          if (msg.id !== 1) return;
          clearTimeout(timer);
          if (msg.error || !msg.result?.processInfo) return fail();
          resolve(msg.result.processInfo);
        } catch { fail(); }
      };
    });
    return one(processes.filter(p => p.type === 'browser'), 'browser process').id;
  } finally { socket.close(); }
}

function descendants(root) {
  return [root, ...(root.children ?? []).flatMap(descendants)];
}

function pickerIn(snapshot) {
  const children = (snapshot.tree.children ?? []).filter(n => n.role === 'window' || n.role === 'dialog');
  if (!children.length) {
    if (!snapshot.complete || snapshot.tree.subtree_truncated) throw new Error('Cannot determine whether a dialog is open.');
    return null;
  }
  const nodes = descendants(one(children, 'owned dialog'));
  const control = (id, roles) => one(nodes.filter(n => n.native_id?.kind === 'automation_id' && n.native_id.value === id && roles.includes(n.role) && n.ref_id), 'standard file dialog control ' + id);
  return { field: control('1148', ['textfield']), open: control('1', ['button', 'menubutton']) };
}

function readFileInput(selector) {
  const nodes = document.querySelectorAll(selector);
  const field = nodes[0];
  if (nodes.length !== 1 || !(field instanceof HTMLInputElement) || field.type !== 'file' || field.disabled) {
    throw new Error('Expected a unique enabled file input');
  }
  const files = Array.from(field.files, ({ name, size, lastModified }) => ({ name, size, lastModified }));
  return { url: location.href, epoch: performance.timeOrigin, files };
}

async function chooseFile({ session, tab, input, file }) {
  if (process.platform !== 'win32' || typeof WebSocket === 'undefined') throw new Error('Requires Windows and Node.js 22 or newer.');
  if (![session, input, file].every(Boolean) || !isAbsolute(file)) throw new Error(usage);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('Expected a regular file.');
  const { ab, original, check } = boundTab(session, tab);
  const db = process.env.AGENT_DESKTOP_BIN ?? join(__dirname, 'agent-desktop-win32-' + process.arch + '.exe');
  const ad = (...args) => run(db, args);

  const page = () => {
    check();
    return ab('eval', '(' + readFileInput.toString() + ')(' + JSON.stringify(input) + ')').result;
  };
  const initial = page();
  const verifyPage = () => {
    const current = page();
    if (current.url !== initial.url || current.epoch !== initial.epoch) throw new Error('The original tab navigated.');
    return current;
  };
  const pid = await browserPid(ab('get', 'cdp-url').cdpUrl);
  const window = one(ad('list-windows').filter(w => w.pid === pid && w.visible && !w.minimized), 'visible window owned by this browser');
  const dialog = () => {
    if (!window.process_instance || !ad('list-windows').some(w => w.id === window.id && w.pid === pid && w.process_instance === window.process_instance)) {
      throw new Error('The original native window is gone.');
    }
    return pickerIn(ad('snapshot', '--window-id', window.id, '--compact', '-i', '--max-depth', '20'));
  };
  if (dialog()) throw new Error('Close the existing browser dialog first.');
  verifyPage();
  ab('click', input);
  const until = Date.now() + 5000;
  let picker;
  while (!(picker = dialog())) {
    if (Date.now() >= until) throw new Error('The browser file dialog did not open or was cancelled.');
    await delay(80);
  }
  verifyPage();
  ad('set-value', picker.field.ref_id, file);
  picker = dialog();
  if (picker?.field.value !== file) throw new Error('The file dialog closed or its filename changed.');
  verifyPage();
  ad('click', picker.open.ref_id);
  const end = Date.now() + 4000;
  do {
    const files = verifyPage().files;
    if (files.length === 1 && files[0].name === basename(file) && files[0].size === stat.size && files[0].lastModified === Math.trunc(stat.mtimeMs) && !dialog()) {
      return { tab: original.tabId, targetId: original.targetId, file: files[0] };
    }
    await delay(80);
  } while (Date.now() < end);
  throw new Error('File selection was not confirmed on the original input.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('The workflow commands require Node.js 22 or later.');
  const command = args.shift();
  const commands = {
    connect: ['cdp'],
    disconnect: [],
    current: ['window', 'page'],
    follow: ['page', 'link', 'button', 'expect-url', 'visible', 'human', 'seed'],
    choose: ['page', 'session', 'tab', 'field', 'input', 'value', 'position', 'format', 'within', 'open', 'popup', 'advance', 'search', 'confirm', 'expect-value'],
    reveal: ['session', 'tab', 'within', 'text'],
    'choose-file': ['session', 'tab', 'input', 'file'],
    view: ['window', 'app', 'output', 'region', 'popups'],
    type: ['page','field','value','stdin','interval-ms','multiline','replace','after','human','seed'],
    wheel: ['page','over','lines','until','human','seed'],
    point: ['page','on','role','nth','expect-text','human','seed'],
    click: ['page','on','role','nth','expect-text','human','seed'],
    edit: ['window', 'app', 'document', 'field', 'value', 'stdin', 'page'],
    move: ['frame', 'from', 'to-frame', 'to', 'after', 'human', 'seed'],
    tap: ['frame', 'at', 'text', 'nth', 'button', 'count', 'human', 'seed'],
    replay: ['file', 'window', 'speed'],
    'browser-move': ['session', 'tab', 'surface', 'from', 'to', 'object', 'after'],
    'drop-file': ['session', 'tab', 'input', 'file'],
    run: ['file', 'session', 'chrome', 'space', 'timeout-ms', 'api'],
    space: ['login', 'close'],
    read: ['url'],
  };
  if (!Object.hasOwn(commands, command)) throw new Error(usage);
  const names = commands[command];
  const options = Object.fromEntries(names.map(key => [key, { type: ['stdin','multiline','replace','visible','popups','chrome','api','space','close'].includes(key) ? 'boolean' : 'string' }]));
  const { values } = parseArgs({ args, options });
  if (names.includes('session') && !values.page && !values.session) values.session = process.env.AGENT_BROWSER_SESSION;
  if (command === 'run' && values.api) { console.log(api); return; }
  const own = {
    replay: () => replay(values),
    run: () => script(values),
    space: () => space(browserBinary(), values),
    read: () => readPage(browserBinary(), values.url ?? ''),
  };
  const data = await (own[command] ?? (() => perform(command, values)))();
  if (process.env.AGENT_DESKTOP_RECORD) recordStep(process.env.AGENT_DESKTOP_RECORD, command, values);
  console.log(JSON.stringify({ ok: true, data }));
}

function nativeBinary() {
  return process.env.AGENT_DESKTOP_BIN ?? join(__dirname, 'agent-desktop-win32-' + process.arch + '.exe');
}

async function replay({ file, window, speed = '1' }) {
  const ad = (...args) => run(nativeBinary(), args);
  const factor = Number(speed);
  if (!file || !(factor > 0)) throw new Error('Use --file FLOW.jsonl and a positive --speed.');
  const steps = readSteps(file);
  const report = [];
  for (const [index, step] of steps.entries()) {
    if (step.wait_ms) await delay(step.wait_ms / factor);
    const options = { ...step.options };
    if (step.needs_page) options.page = (await current(ad, { window })).page;
    try {
      const data = await perform(step.command, options);
      report.push({ step: index + 1, command: step.command, delivery: data?.delivery, verified: data?.verified });
    } catch (error) {
      error.message = 'Replay stopped at step ' + (index + 1) + ' (' + step.command + '): ' + error.message;
      throw error;
    }
  }
  return { steps: report.length, report };
}

function script({ file, session, chrome, space: own, 'timeout-ms': wait = '120000' }) {
  const timeout = Number(wait);
  if (!(timeout > 0) || (!file && process.stdin.isTTY)) throw new Error('Pipe a script to run, or pass --file SCRIPT.js. --timeout-ms takes a positive number.');
  if ([session, chrome, own].filter(Boolean).length > 1) throw new Error('Choose one of --session NAME, --space and --chrome.');
  const source = readFileSync(file ?? 0, 'utf8').replace(/^\uFEFF/, '');
  return runScript(source, {
    browser: optionalBrowserBinary(), native: nativeBinary(), timeout, flow: perform,
    flags: own ? spaceFlags() : ['--session', session ?? 'work', ...(chrome ? ['--auto-connect'] : [])],
    env: chrome ? { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' } : process.env,
  });
}

async function perform(command, values) {
  const db = nativeBinary();
  const ad = (...args) => run(db, args);
  const web = await webPerform(optionalBrowserBinary(), command, values);
  if (web) return web;
  let data;
  switch (command) {
    case 'connect': data = connect(browserBinary(), values); break;
    case 'disconnect': data = disconnect(); break;
    case 'current': data = withRoute(optionalBrowserBinary(), await current(ad, values)); break;
    case 'follow': data = await follow(ad, values, physicalPointer); break;
    case 'choose-file': data = await chooseFile(values); break;
    case 'choose':
      if (!values.page && (values.within || values.open || values.popup || values.advance || values.search || values.confirm || values['expect-value'])) throw new Error('Native choice options require --page.');
      data = values.page !== undefined ? await choosePage(ad, values) : choose(values);
      break;
    case 'reveal': {
      if (!values.session || !values.within || !values.text?.trim()) throw new Error(usage);
      const {original,check,evaluate}=boundTab(values.session,values.tab);
      check();
      data = {tab:original.tabId,...evaluate(revealText,values.within,values.text,original.url)};
      check();
      break;
    }
    case 'view': data = view(ad, values); break;
    case 'type': data = await typePage(ad,(args,input)=>run(db,args,input),values); break;
    case 'wheel': data = await wheelPage(ad,values); break;
    case 'point': case 'click': data = await pointerPage(ad,command,values); break;
    case 'edit': {
      const write = (args,data) => run(db,args,data);
      data = values.page ? await editPage(ad,write,values) : edit(ad,write,values);
      break;
    }
    case 'move': data = move(ad, values); break;
    case 'tap': data = tap(ad, values); break;
    case 'browser-move': data = await browserMove(boundTab, values); break;
    case 'drop-file': data = await dropFile(boundTab, values); break;
  }
  return data;
}

main().catch(err => {
  const partial=err.details?.typed_keystrokes;
  console.error(JSON.stringify({ok:false,error:err.message,...(err.disposition ? {code:err.code,disposition:err.disposition} : {}),
    ...(Number.isInteger(partial) ? {typed_keystrokes:partial,keystrokes:err.details.keystrokes} : {}),
    ...(err.report ? {...(err.code && !err.disposition ? {code:err.code} : {}),...err.report} : {})}));
  process.exitCode=1;
});
