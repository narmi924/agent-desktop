'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { COMMAND_OPTIONS } = require('./cli-options');
const { stateDir } = require('./routine-store');
const { INSTRUCTIONS, GUIDE } = require('./mcp-guide');

/**
 * Stdio MCP server for the workflow layer. It is not a second command surface: every tool builds the argument
 * list of one `agent-desktop-workflow` command and runs that command as a child process, so the refusals, the
 * preferences and the reply are the same as on the command line.
 */
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_CONCURRENT_CALLS = 4;
const WAIT_DEFAULT_MS = 50000;
const MODES = ['background', 'watch', 'record', 'direct'];
const BROWSERS = ['clean', 'chrome', 'space'];

const text = description => ({ type: 'string', description });
const flag = description => ({ type: 'boolean', description });
const number = description => ({ type: 'integer', minimum: 1, description });
const json = description => ({ type: 'object', description, additionalProperties: true });

const RUN_SHARED = {
  mode: { type: 'string', enum: MODES, description: 'How the user sees the work: background (default, mouse and keyboard untouched), watch (on screen at a human pace, amber pointer), record (on screen at a human pace, the user\'s own pointer), direct (real input whenever a step needs it). Leave it out unless the user asked for one; saved preferences apply otherwise.' },
  browser: { type: 'string', enum: BROWSERS, description: 'Which browser web steps use, separate from mode: clean (a private window with no sign-ins), chrome (the user\'s own Chrome with their sign-ins, in its own tab; it stays behind unless mode puts work on screen; workflow_connect once), space (the agent\'s own profile signed in once). Leave it out to use the saved preference.' },
  session: text('A named agent-browser session instead of browser; never one that was connected to the user\'s Chrome.'),
  allow_input: flag('Let steps use the real mouse and keyboard. Only after the user agreed in this chat, or said so in this request.'),
  allow_final: flag('Let send, submit, pay, delete and post steps go through. Only when the user asked for that step in this request or agreed in this chat.'),
  args: json('Values the script reads as args.NAME.'),
  timeout_ms: number('How long the script may run, default 120000.'),
  detach: flag('Hand the work to the resident host and get a job id at once; follow it with workflow_job (action wait). Use it for work longer than about 20 seconds.'),
};

const TOOLS = [
  { name: 'workflow_guide', command: ['run'], fixed: ['--api'], raw: true, description: 'How to work: the order of routes from fastest to slowest, the script helpers, and the rules for the mouse, keyboard and final steps. Read it once before the first workflow_run.', properties: {} },
  { name: 'workflow_run', command: ['run'], description: 'Run one JavaScript script that does many web and desktop steps in one call (web.*, desktop.*, visible.*). Write the whole task as one script; return the value you need. Use args for values that change. save keeps a script that succeeded as a named routine.',
    properties: { script: text('The script body (JavaScript, top-level await allowed).'), ...RUN_SHARED,
      save: text('Save the script as a routine under this name after it succeeds.'), about: text('One sentence on what the saved routine does.'),
      params: json('For save: argument name to a short description of what it is.'), replace: flag('For save: replace a routine with the same name.') },
    required: ['script'] },
  { name: 'workflow_routine_list', command: ['routine', 'list'], description: 'List saved routines, one line each, optionally filtered by app, site or words. Check this before writing a new script.', properties: { for: text('Filter text: a site host, window name or words.') } },
  { name: 'workflow_routine_show', command: ['routine', 'show'], positional: ['name'], description: 'Show a saved routine: its arguments, steps and script.', properties: { name: text('Routine name.') }, required: ['name'] },
  { name: 'workflow_routine_run', command: ['routine', 'run'], positional: ['name'], description: 'Run a saved routine. It stops at the first step whose effect differs from the saved runs (EFFECT_MISMATCH); then finish the rest with workflow_run.', properties: { name: text('Routine name.'), ...RUN_SHARED }, required: ['name'] },
  { name: 'workflow_routine_schedule', command: ['routine', 'schedule'], positional: ['name'], description: 'Run a saved routine at set times through the Windows Task Scheduler, only when the user asked for that. The arguments are kept for the runs; allow_final only when the user agreed now that the routine may send or submit unattended. A notification tells the user how each run ended.',
    properties: { name: text('Routine name.'), at: text('Time of day, HH:MM.'), every: text('day (default), weekdays, hour, or days such as mon,wed,fri.'), args: json('Arguments for every run.'), allow_final: flag('The user agreed now to the routine\'s final steps on unattended runs.') }, required: ['name', 'at'] },
  { name: 'workflow_routine_unschedule', command: ['routine', 'unschedule'], positional: ['name'], description: 'Stop the scheduled runs of a routine.', properties: { name: text('Routine name.') }, required: ['name'] },
  { name: 'workflow_prefs', command: ['prefs'], description: 'Show how scripts work here and where each setting comes from: mode, pointer and browser, by this run, the routine, the project folder and everywhere.', properties: { dir: text('Show it for this folder instead of the server\'s working folder.') } },
  { name: 'workflow_prefs_set', command: ['prefs', 'set'], description: 'Remember how the user wants to work, only when the user said so ("from now on in this project ...", "from now on ...", "this routine always ..."). Tell the user what changed and how to undo it.',
    properties: { mode: { type: 'string', enum: MODES }, pointer: text('amber, red, green, off, or the path of a square PNG.'), browser: { type: 'string', enum: BROWSERS },
      scope: { type: 'string', enum: ['project', 'always', 'routine'], description: 'project: the folder in dir; always: everywhere; routine: the routine named in routine.' },
      dir: text('The project folder (scope project).'), routine: text('The routine name (scope routine).') }, required: ['scope'] },
  { name: 'workflow_prefs_unset', command: ['prefs', 'unset'], description: 'Forget saved settings in one scope.',
    properties: { keys: { type: 'array', items: { type: 'string', enum: ['mode', 'pointer', 'browser'] } }, scope: { type: 'string', enum: ['project', 'always', 'routine'] }, dir: text('The project folder (scope project).'), routine: text('The routine name (scope routine).') }, required: ['keys', 'scope'] },
  { name: 'workflow_job', command: ['job'], description: 'Follow and fix detached work. wait returns when the job finishes or needs you (state done, waiting with reason fix, approval, hands or user, failed); call it again when it returns still running. approve and grant only after the user agreed in this chat.',
    properties: { action: { type: 'string', enum: ['list', 'show', 'wait', 'stop', 'report', 'retry', 'do', 'skip', 'approve', 'grant'] }, id: text('Job id.'),
      timeout_ms: number('For wait: how long to wait, default 50000.'), target: text('For retry: the name to use now.'), options: json('For retry: step options such as {"timeout": 15000}.'),
      patch: text('For do: a script to run before the failed step.'), value: { description: 'For skip: the value the skipped step returns.' },
      seconds: number('For grant: how long the job may use the mouse and keyboard.'), all: flag('For grant: every job waiting for the hands.') }, required: ['action'] },
  { name: 'workflow_watch', command: ['watch'], description: 'Let the resident host watch for something and tell you, or start a routine when it happens: a window opening or closing, text in a window, a notification, a file finishing. wait returns when it fires.',
    properties: { action: { type: 'string', enum: ['add', 'list', 'show', 'wait', 'remove'] }, id: text('Watch id.'), window: text('Window title part.'), text: text('Text to watch for (with in).'),
      in: text('Window whose text to watch.'), gone: flag('Fire when it goes away instead.'), notification: text('Notification text part.'), file: text('File path that should finish downloading.'),
      then: text('Routine to start when it fires.'), args: json('Arguments for then; {match}, {file}, {title} are filled in.'), allow_final: flag('The user agreed now to the routine\'s final steps.'),
      timeout_ms: number('For wait: how long to wait, default 50000.') }, required: ['action'] },
  { name: 'workflow_read_url', command: ['read'], description: 'The text of a web page, fastest route when only the text is needed.', properties: { url: text('http or https address.') }, required: ['url'] },
  { name: 'workflow_current', command: ['current'], description: 'The page in one of the user\'s Chrome windows: address, text and a page handle, and whether it is reachable in the background (route web) or only with the real mouse and keyboard (route desktop).', properties: { window: text('Window id from a desktop read.'), visible: flag('Bind the visible tab for the real mouse and keyboard only.') } },
  { name: 'workflow_connect', command: ['connect'], description: 'Connect to the user\'s running Chrome once, so browser chrome works in the background. Chrome shows an approval prompt the user must accept; tell them first.', properties: { cdp: text('A DevTools address instead of finding the running Chrome.') } },
];

/** Maps each tool argument to the command-line option it becomes. */
const OPTION_OF = {
  allow_input: 'allow-input', allow_final: 'allow-final', timeout_ms: 'timeout-ms', detach: 'detach', session: 'session', mode: 'mode', save: 'save', about: 'about',
  replace: 'replace', for: 'for', dir: 'dir', target: 'target', all: 'all', window: 'window', text: 'text', in: 'in', gone: 'gone', notification: 'notification',
  file: 'file', then: 'then', url: 'url', visible: 'visible', cdp: 'cdp', at: 'at', every: 'every',
};

function invalid(message) {
  return Object.assign(new Error(message), { invalid: true });
}

/** Writes a value the command reads from a file; the server removes it after the call. */
function tempFile(files, extension, content) {
  const dir = join(stateDir(), 'mcp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, randomUUID() + extension);
  writeFileSync(path, content, 'utf8');
  files.push(path);
  return path;
}

/** The command line for one tool call, and the temporary files it uses. */
function toArgv(tool, input) {
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(tool.properties, name)) throw invalid(tool.name + ' has no argument ' + name + '.');
  }
  const files = [];
  const argv = [...tool.command];
  const command = tool.command[0];
  const allowed = new Set(COMMAND_OPTIONS[command]);
  const add = (option, value) => {
    if (!allowed.has(option)) throw invalid(tool.name + ' cannot pass --' + option + '.');
    if (value === true) argv.push('--' + option);
    else if (value !== false && value !== undefined && value !== null) argv.push('--' + option, String(value));
  };
  for (const name of tool.positional ?? []) {
    if (typeof input[name] !== 'string' || !input[name]) throw invalid(tool.name + ' needs ' + name + '.');
    argv.push(input[name]);
  }
  if (tool.name === 'workflow_job' || tool.name === 'workflow_watch') {
    if (!input.action) throw invalid(tool.name + ' needs action.');
    argv.push(input.action);
    if (input.id) argv.push(input.id);
    if (input.action === 'wait') add('timeout-ms', input.timeout_ms ?? WAIT_DEFAULT_MS);
  }
  if (tool.name === 'workflow_prefs_set' || tool.name === 'workflow_prefs_unset') {
    if (tool.name === 'workflow_prefs_set') {
      const pairs = ['mode', 'pointer', 'browser'].filter(key => input[key] !== undefined).map(key => key + '=' + input[key]);
      if (!pairs.length) throw invalid('workflow_prefs_set needs at least one of mode, pointer, browser.');
      argv.push(...pairs);
    } else {
      if (!Array.isArray(input.keys) || !input.keys.length) throw invalid('workflow_prefs_unset needs keys.');
      argv.push(...input.keys);
    }
    if (input.scope === 'always') add('always', true);
    else if (input.scope === 'routine') add('routine', input.routine);
    else if (input.scope === 'project') { if (input.dir) add('dir', input.dir); else add('project', true); }
    else throw invalid('scope is project, always or routine.');
  }
  for (const fixed of tool.fixed ?? []) argv.push(fixed);
  if (input.script !== undefined) add('file', tempFile(files, '.js', String(input.script)));
  if (input.args !== undefined) add('args-file', tempFile(files, '.json', JSON.stringify(input.args)));
  if (input.patch !== undefined) add('file', tempFile(files, '.js', String(input.patch)));
  if (input.options !== undefined) add('options', JSON.stringify(input.options));
  if (input.value !== undefined) add('value', JSON.stringify(input.value));
  if (input.seconds !== undefined) add('for', input.seconds);
  if (input.params !== undefined) for (const [name, about] of Object.entries(input.params)) add('param', name + '=' + about);
  if (input.browser === 'chrome') add('chrome', true);
  if (input.browser === 'space') add('space', true);
  const handled = new Set(['script', 'args', 'patch', 'options', 'value', 'seconds', 'params', 'browser', 'action', 'id', 'keys', 'scope', 'pointer', ...(tool.positional ?? []),
    ...(tool.name === 'workflow_prefs_set' ? ['mode', 'routine', 'dir'] : []), ...(tool.name === 'workflow_prefs_unset' ? ['routine', 'dir'] : [])]);
  for (const [name, value] of Object.entries(input)) {
    if (handled.has(name) || (name === 'timeout_ms' && input.action === 'wait')) continue;
    if (!Object.hasOwn(tool.properties, name)) throw invalid(tool.name + ' has no argument ' + name + '.');
    add(OPTION_OF[name] ?? name, value);
  }
  return { argv, files };
}

/** Runs one workflow command and turns its envelope into an MCP tool result. */
function runCommand({ workflowPath, argv, raw, register }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [workflowPath, ...argv], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    register?.(child);
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (raw && code === 0) { resolve({ content: [{ type: 'text', text: GUIDE + '\n\n' + stdout }], isError: false }); return; }
      const last = (stdout || stderr).split('\n').reverse().find(line => line.startsWith('{'));
      let envelope;
      try { envelope = last ? JSON.parse(last) : undefined; } catch { envelope = undefined; }
      if (!envelope) { resolve({ content: [{ type: 'text', text: (stderr || stdout || 'The command ended without a reply (exit ' + code + ').') }], isError: true }); return; }
      resolve({ content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: envelope.ok !== true });
    });
    child.on('error', error => resolve({ content: [{ type: 'text', text: error.message }], isError: true }));
  });
}

function definition(tool) {
  return { name: tool.name, description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, ...(tool.required ? { required: tool.required } : {}), additionalProperties: false } };
}

function initialize(params) {
  const version = LEGACY_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0];
  return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: serverInfo(), instructions: INSTRUCTIONS };
}

function serverInfo() {
  return { name: 'agent-desktop-workflow', version: require('../package.json').version };
}

/**
 * Serves MCP over newline-delimited JSON-RPC until the input closes. Tool calls run concurrently, at most
 * MAX_CONCURRENT_CALLS at once; a cancelled call has its command stopped.
 */
function serve({ workflowPath, input = process.stdin, output = process.stdout }) {
  const running = new Map();
  const write = message => output.write(JSON.stringify(message) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete' } });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  let buffer = '';
  const pending = [];
  const handle = async message => {
    if (message.method === 'notifications/cancelled') {
      running.get(JSON.stringify(message.params?.requestId))?.kill();
      return;
    }
    if (message.id === undefined) return;
    const { id, method, params = {} } = message;
    if (method === 'initialize') return reply(id, initialize(params));
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS.map(definition) });
    if (method !== 'tools/call') return fail(id, -32601, 'Method not found: ' + method);
    const tool = TOOLS.find(t => t.name === params.name);
    if (!tool) return fail(id, -32602, 'Unknown tool: ' + params.name);
    if (running.size >= MAX_CONCURRENT_CALLS) return reply(id, { content: [{ type: 'text', text: MAX_CONCURRENT_CALLS + ' tool calls are already running; retry when one finishes' }], isError: true });
    let call;
    try { call = toArgv(tool, params.arguments ?? {}); } catch (error) {
      return reply(id, { content: [{ type: 'text', text: error.message }], isError: true });
    }
    const key = JSON.stringify(id);
    let result;
    try {
      result = await runCommand({ workflowPath, argv: call.argv, raw: tool.raw, register: child => running.set(key, child) });
    } finally {
      running.delete(key);
      for (const path of call.files) rmSync(path, { force: true });
    }
    reply(id, result);
  };
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + error.message } }); continue; }
      pending.push(handle(message));
    }
  });
  return new Promise(resolve => input.on('end', () => Promise.allSettled(pending).then(resolve)));
}

module.exports = { serve, toArgv, TOOLS, definition };
