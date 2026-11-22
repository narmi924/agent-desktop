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
const { connect, disconnect, webPerform, withRoute, chromeFlags } = require('../lib/web-page');
const { runScript, api } = require('../lib/script-run');
const { space, spaceFlags } = require('../lib/space');
const { readPage } = require('../lib/page-read');
const { markRepeat, clearRepeat } = require('../lib/script-repeat');
const routines = require('../lib/routine-command');
const host = require('../lib/host-command');
const prefs = require('../lib/prefs');
const { COMMAND_OPTIONS, POSITIONAL_COMMANDS, parseOptions } = require('../lib/cli-options');
const mcp = require('../lib/mcp-server');
const schedule = require('../lib/routine-schedule');
const skill = require('../lib/skill-command');
const { versionReport } = require('../lib/bundle-version');

const usage = [
  'agent-desktop-workflow --version   (the version of this bundle, and for each program the installed version and the official release it is built on)',
  'agent-desktop-workflow connect [--cdp URL]   (once: lets page commands use your running Chrome without taking the foreground)',
  'agent-desktop-workflow disconnect',
  'agent-desktop-workflow current [--window ID | --page PAGE] [--visible]   (--visible binds the tab for the real mouse and keyboard only and skips the background connection)',
  'agent-desktop-workflow follow --page PAGE (--link NAME [--expect-url URL] | --button NAME --expect-url URL) [--visible]',
  'agent-desktop-workflow type --page PAGE --field NAME (--value TEXT | --stdin) [--interval-ms MS | --human natural|careful [--seed N]] [--multiline] [--replace | --at start|end] [--after IMAGE.png]   (text goes in at the caret; a field that was never clicked has its caret at the start, so say --at end to append)',
  'agent-desktop-workflow wheel --page PAGE [--over VISIBLE_TEXT] [--lines N] [--until TEXT] [--human natural|careful] [--seed N] (positive is down; without --over the page itself scrolls)',
  'agent-desktop-workflow point --page PAGE --on NAME [--role ROLE] [--nth N] [--expect-text TEXT] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow click --page PAGE --on NAME [--role ROLE] [--nth N] [--expect-text TEXT] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow edit --page PAGE --field NAME (--value TEXT | --stdin)',
  'agent-desktop-workflow choose --page PAGE --field LABEL --value OPTION [--within SECTION] [--open BUTTON] [--popup PANEL] [--advance BUTTON] [--search FIELD] [--confirm BUTTON] [--expect-value TEXT]',
  'agent-desktop-workflow choose --session NAME [--tab TAB] (--field LABEL | --input CSS) --value VALUE [--position N] [--format DATE_FORMAT]',
  'agent-desktop-workflow choose-file --session NAME [--tab TAB] --input CSS --file ABSOLUTE_PATH',
  'agent-desktop-workflow reveal --session NAME [--tab TAB] --within CSS --text EXACT_TEXT',
  'agent-desktop-workflow view (--window ID | --app NAME) [--output NEW_IMAGE.png] [--region X,Y,W,H] [--popups]   (without --output the image gets a new name; the reply has its path)',
  'agent-desktop-workflow edit (--window ID | --app NAME) --document TAB_NAME [--field LABEL] (--value TEXT | --stdin)',
  'agent-desktop-workflow move --frame IMAGE.png --from X,Y --to X,Y [--to-frame DEST.png] [--after IMAGE.png] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow tap --frame IMAGE.png (--at X,Y | --text VISIBLE_TEXT [--nth N]) [--button left|right|middle] [--count N] [--human natural|careful] [--seed N]',
  'agent-desktop-workflow browser-move --session NAME [--tab TAB] --surface CSS --from X,Y --to X,Y [--object CSS] [--after IMAGE.png]',
  'agent-desktop-workflow drop-file --session NAME [--tab TAB] --input DROP_ZONE_CSS --file ABSOLUTE_PATH',
  'agent-desktop-workflow replay --file FLOW.jsonl [--window ID] [--speed N]   (record a flow by setting AGENT_DESKTOP_RECORD=FLOW.jsonl)',
  'agent-desktop-workflow run [--file SCRIPT.js] [--mode background|watch|record|direct] [--session NAME | --space | --chrome] [--allow-input] [--allow-final] [--timeout-ms MS] [--args JSON | --args-file FILE.json] [--save NAME --about TEXT [--param name="what it is"]... [--replace]]   (many page and desktop steps in one call; the script comes from stdin without --file; run --api lists the helpers. Without --allow-input a step that needs the real mouse and keyboard is refused before anything is sent; without --allow-final a send, submit, pay or delete step is refused the same way. --save keeps a script that succeeded as a routine; argument values are not stored)',
  'agent-desktop-workflow routine run NAME [--mode WAY] [--args JSON | --args-file FILE.json] [--allow-input] [--allow-final] [--session NAME | --space | --chrome]   (runs a saved routine and stops at the first step whose effect differs from the saved runs: EFFECT_MISMATCH)',
  'agent-desktop-workflow routine schedule NAME --at HH:MM [--every day|weekdays|hour|mon,wed,fri] [--args JSON | --args-file FILE.json] [--allow-final] | routine unschedule NAME   (runs a saved routine at set times through the Windows Task Scheduler while the user is signed in; the arguments are kept for it; a notification says how each run ended. Set it only when the user asked for it)',
  'agent-desktop-workflow routine list [--for TEXT] | routine show NAME | routine remove NAME | routine allow NAME | routine permissions | routine revoke NAME   (allow: the user said in the chat that this routine may always do its final steps; permissions lists those routines and the apps and sites protected.json under the state folder protects)',
  'agent-desktop-workflow run ... --detach | routine run NAME ... --detach   (hands the work to the resident host and answers at once with a job id)',
  'agent-desktop-workflow job list | job show ID | job wait ID [--timeout-ms MS] | job stop ID | job report ID',
  'agent-desktop-workflow job retry ID [--target NAME] [--options JSON] | job do ID --file PATCH.js | job skip ID [--value JSON]   (a job whose step failed waits up to 10 minutes for one of these)',
  'agent-desktop-workflow host start | host stop | host status',
  'agent-desktop-workflow watch add (--window TITLE [--gone] | --text TEXT --in WINDOW [--gone] | --notification TEXT | --file PATH) [--then ROUTINE [--args JSON] [--allow-final]] | watch list | watch show ID | watch wait ID | watch remove ID   (the host watches; --then starts a saved routine as a job, which stops before a final step unless the user agreed to it when the watch was set: --allow-final)',
  'agent-desktop-workflow job approve ID   (a job stopped before a final step, reason "approval": ask the user in the chat first; job approve lets that one step go, job skip passes it, job stop ends the job)',
  'agent-desktop-workflow job grant (ID | --all) --for SECONDS   (a job waits with reason "hands" before a step that needs the real mouse and keyboard: let it, or every job, use them that long; a person touching them makes the job wait until they stop for 3 seconds; nothing goes on while the screen is locked)',
  'agent-desktop-workflow prefs [--dir FOLDER] | prefs set KEY=VALUE... (--project | --dir FOLDER | --always | --routine NAME) | prefs unset KEY... SCOPE   (how scripts work here: mode is background, watch, record or direct; pointer is amber, red, green, off or a PNG; browser is background, chrome or space. The most specific wins: --mode for this run, the routine, the project folder, everywhere. Set them only when the user asks for it)',
  'agent-desktop-workflow skill [NAME] | skill --list | skill --install [--dir FOLDER] [--force]   (the working guide for agents; --install puts a short entry that points here into the Claude Code and Codex skill folders)',
  'agent-desktop-workflow mcp   (serves run, routines, preferences, jobs and watches as MCP tools over stdio, for any MCP client)',
  'agent-desktop-workflow read --url URL   (the text of a web page: a plain request and a background browser run together and the first full answer is returned)',
  'agent-desktop-workflow space [--login URL | --close]   (the agent\'s own browser profile: --login shows its window so the user signs in once; later runs with --space keep that sign-in in the background)',
].join('\n');

function one(items, description) {
  if (items.length !== 1) throw new Error('Expected one ' + description + ', found ' + items.length);
  return items[0];
}

function run(binary, args, input, check) {
  check?.(args);
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

/** A shell that splits `812,604` into separate words still means one coordinate. */
function joinCoordinates(args) {
  const joined = [];
  for (let i = 0; i < args.length; i++) {
    joined.push(args[i]);
    if (!['--at', '--from', '--to', '--region'].includes(args[i])) continue;
    const parts = [];
    while (/^-?\d+(\.\d+)?$/.test(args[i + 1] ?? '')) parts.push(args[++i]);
    if (parts.length) joined.push(parts.join(','));
  }
  return joined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage); return; }
  if (args[0] === '--version') { console.log(JSON.stringify({ ok: true, data: versionReport({ nativeBinary: nativeBinary(), browserBinary: optionalBrowserBinary() }) })); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('The workflow commands require Node.js 22 or later.');
  const command = args.shift();
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error(usage);
  if (command === 'mcp') { await mcp.serve({ workflowPath: __filename }); return; }
  const names = COMMAND_OPTIONS[command];
  const { values, positionals } = parseArgs({ args: joinCoordinates(args), options: parseOptions(command), allowPositionals: POSITIONAL_COMMANDS.includes(command) });
  if (names.includes('session') && !values.page && !values.session) values.session = process.env.AGENT_BROWSER_SESSION;
  if (command === 'run' && values.api) { console.log(api); return; }
  if (command === 'skill' && !values.list && !values.install) { console.log(skill.read(positionals[0])); return; }
  const own = {
    replay: () => replay(values),
    run: () => script(values),
    routine: () => routine(positionals, values),
    job: () => host.job(positionals, values, path => readFileSync(path, 'utf8')),
    host: () => host.hostCommand(positionals, { workflowPath: __filename, nativeBinary: nativeBinary() }),
    'job-run': () => jobRun(positionals[0]),
    watch: () => host.watch(positionals, values, { workflowPath: __filename, readText: path => readFileSync(path, 'utf8'),
      settle: routine => runnerValues(prefs.runnerOptions(prefs.resolveSettings({ routine }), {})) }),
    prefs: () => prefs.prefsCommand(positionals, values),
    skill: () => (values.list ? { parts: skill.parts() } : skill.install({ dir: values.dir, force: Boolean(values.force) })),
    space: () => space(browserBinary(), values),
    read: () => readPage(browserBinary(), values.url ?? ''),
  };
  const data = await (own[command] ?? (() => perform(command, values)))();
  if (process.env.AGENT_DESKTOP_RECORD) recordStep(process.env.AGENT_DESKTOP_RECORD, command, values);
  console.log(JSON.stringify({ ok: true, data }));
  if (command === 'run' || command === 'routine' || command === 'job') leave(0);
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

/** The runner options a detached job carries to its own process. */
function runnerValues(values) {
  return Object.fromEntries(['session', 'chrome', 'space', 'timeout-ms', 'allow-input', 'allow-final', 'pace', 'pointer', 'screen'].filter(k => values[k] !== undefined).map(k => [k, values[k]]));
}

/** A job may wait hours for a fix, the hands or the user's word before a final step, so its own clock is long. */
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** One detached job: runs its script with the same runner, and a failed step waits for a fix sent through the host. */
async function jobRun(dir) {
  const start = JSON.parse(readFileSync(join(dir, 'start.json'), 'utf8'));
  return host.runJob(start, { runner: scriptRunner({ 'timeout-ms': String(JOB_TIMEOUT_MS), ...start.values }), routines, nativeBinary: nativeBinary() });
}

/** The runner both `run` and `routine run` use: same helpers, same refusals, same reply. */
function scriptRunner({ session, chrome, space: own, 'timeout-ms': wait = '120000', 'allow-input': allowInput = false, 'allow-final': allowFinal = false, pace, pointer, screen = false }) {
  const timeout = Number(wait);
  if (!(timeout > 0)) throw new Error('--timeout-ms takes a positive number.');
  if ([session, chrome, own].filter(Boolean).length > 1) throw new Error('Choose one of --session NAME, --space and --chrome.');
  process.env.AGENT_DESKTOP_POINTER_HOLDER ??= String(process.pid);
  if (pointer) process.env.AGENT_DESKTOP_POINTER ??= pointer;
  return (source, extra) => runScript(source, {
    browser: optionalBrowserBinary(), native: nativeBinary(), timeout, flow: perform, allowInput, allowFinal, startPace: pace, screen,
    flags: own ? spaceFlags() : chrome ? chromeFlags() : ['--session', session ?? 'work'],
    env: chrome ? { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' } : process.env, ...extra,
  });
}

/** The first script that runs on a computer carries a short note on the ways of working, for the agent to pass on once. */
function welcomed(reply) {
  return prefs.firstUse() ? { ...reply, welcome: prefs.WELCOME } : reply;
}

async function script(values) {
  const { file, save, about, param, replace = false, detach } = values;
  if (!file && process.stdin.isTTY) throw new Error('Pipe a script to run, or pass --file SCRIPT.js.');
  if ((about !== undefined || param || replace) && !save) throw new Error('--about, --param and --replace go with --save NAME.');
  if (detach && save) throw new Error('--save runs in the foreground; leave out --detach.');
  const args = routines.readArgs(values, path => readFileSync(path, 'utf8'));
  const source = readFileSync(file ?? 0, 'utf8').replace(/^\uFEFF/, '');
  const settings = prefs.resolveSettings({ request: { mode: values.mode } });
  const options = prefs.runnerOptions(settings, values);
  if (detach) return welcomed({ ...await host.detach({ source, args, values: runnerValues(options) }, { workflowPath: __filename }), ...prefs.settingsNote(settings) });
  const run = scriptRunner(options);
  try {
    const done = await run(source, { args, watch: Boolean(save) });
    clearRepeat();
    const reply = { ...done, ...prefs.settingsNote(settings) };
    if (save) {
      const saved = routines.save({ name: save, about, params: param, replace, source, args, done });
      if (values.mode) prefs.rememberRoutineMode(save, values.mode);
      return welcomed({ ...reply, saved });
    }
    const known = routines.knownRoutines(done.trail);
    return welcomed(known.length ? { ...reply, known_routines: known, known_note: 'Saved routines already work on this app or site. Before writing steps here again, check them with routine show NAME and use routine run NAME.' } : reply);
  } catch (err) {
    throw markRepeat(err);
  }
}

async function routine([action, name, ...rest], values) {
  if (rest.length) throw new Error(usage);
  if (action === 'list') {
    const listed = routines.list(values.for);
    const planned = Object.entries(schedule.schedules()).map(([routineName, s]) => ({ routine: routineName, at: s.at, every: s.every, ...(s.allow_final ? { allow_final: true } : {}) }));
    return planned.length ? { ...listed, schedules: planned } : listed;
  }
  if (action === 'permissions') return routines.permissions();
  if (action === 'allow' && name) return routines.allow(name);
  if (action === 'revoke' && name) return routines.revoke(name);
  if (!name) throw new Error('Name the routine: routine ' + (action ?? 'run') + ' NAME.');
  if (action === 'show') return routines.show(name);
  if (action === 'remove') {
    const removed = routines.remove(name);
    return schedule.schedules()[name] ? { ...removed, ...schedule.unschedule(name) } : removed;
  }
  if (action === 'schedule') {
    return schedule.schedule(name, { at: values.at, every: values.every, args: routines.readArgs(values, path => readFileSync(path, 'utf8')), allowFinal: Boolean(values['allow-final']) }, { workflowPath: __filename });
  }
  if (action === 'unschedule') return schedule.unschedule(name);
  if (action === 'run-scheduled') {
    return schedule.runScheduled(name, {
      start: ({ args: stored, allowFinal }) => {
        const settings = prefs.resolveSettings({ routine: name });
        const options = prefs.runnerOptions(settings, allowFinal ? { 'allow-final': true } : {});
        return host.detach({ routine: name, args: stored, values: runnerValues(options) }, { workflowPath: __filename });
      },
      wait: (id, ms) => host.job(['wait', id], { 'timeout-ms': String(ms) }, path => readFileSync(path, 'utf8')),
    });
  }
  if (action !== 'run') throw new Error(usage);
  const args = routines.readArgs(values, path => readFileSync(path, 'utf8'));
  const settings = prefs.resolveSettings({ routine: name, request: { mode: values.mode } });
  const options = prefs.runnerOptions(settings, values);
  if (values.detach) return welcomed({ ...await host.detach({ routine: name, args, values: runnerValues(options) }, { workflowPath: __filename }), ...prefs.settingsNote(settings) });
  try {
    const done = await routines.runRoutine(name, args, scriptRunner(options));
    clearRepeat();
    return welcomed({ ...done, ...prefs.settingsNote(settings) });
  } catch (err) {
    throw markRepeat(err);
  }
}

async function perform(command, values, check) {
  const db = nativeBinary();
  const ad = (...args) => run(db, args, undefined, check);
  const web = await webPerform(optionalBrowserBinary(), command, values);
  if (web) return web;
  let data;
  switch (command) {
    case 'connect': data = connect(browserBinary(), values); break;
    case 'disconnect': data = disconnect(); break;
    case 'current': {
      const page = await current(ad, values);
      data = values.visible ? { ...page, route: 'desktop' } : withRoute(optionalBrowserBinary(), page);
      break;
    }
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
    case 'type': data = await typePage(ad,(args,input)=>run(db,args,input,check),values); break;
    case 'wheel': data = await wheelPage(ad,values); break;
    case 'point': case 'click': data = await pointerPage(ad,command,values); break;
    case 'edit': {
      const write = (args,data) => run(db,args,data,check);
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
    ...(err.report ? {...(err.code && !err.disposition ? {code:err.code} : {}),...err.report} : {}),
    ...(['MISSING_ARGS','EFFECT_MISMATCH','FINAL_NOT_ALLOWED','ROUTINE_NOT_FOUND','ROUTINE_EXISTS','INVALID_ARGS',
      'JOB_NOT_FOUND','JOB_NOT_WAITING','JOB_NEEDS_APPROVAL','STEP_ALREADY_SENT','HOST_NOT_RUNNING'].includes(err.code) && !err.report ? {code:err.code} : {}),
    ...(err.details && ['MISSING_ARGS','EFFECT_MISMATCH','FINAL_NOT_ALLOWED'].includes(err.code) ? {details:err.details} : {})}));
  process.exitCode=1;
  if (err.report) leave(1);
});

/**
 * A script that timed out or failed can still have timers of its own pending. The reply is already out, so the
 * process ends now: the commands it started stop holding the agent pointer, and the caller gets its exit code.
 */
function leave(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
