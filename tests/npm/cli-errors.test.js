'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { errorCode } = require('../../npm/lib/error-code');
const { view } = require('../../npm/lib/window-move');
const { runScript } = require('../../npm/lib/script-run');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');
const home = mkdtempSync(join(tmpdir(), 'ad-cli-errors-'));
const env = { ...process.env, AGENT_DESKTOP_HOME: home, AGENT_DESKTOP_HOST_PIPE: '\\\\.\\pipe\\ad-cli-errors-' + process.pid,
  AGENT_DESKTOP_BIN: join(home, 'no-native.exe'), AGENT_DESKTOP_NOTIFY: 'off' };

/** Runs one command and returns its exit status and the JSON it printed. */
function cli(args, input) {
  const out = spawnSync(process.execPath, [workflow, ...args], { env, cwd: home, input: input ?? '', encoding: 'utf8', windowsHide: true });
  const line = (out.stdout || out.stderr).trim().split('\n').at(-1) ?? '';
  let reply;
  try { reply = JSON.parse(line); } catch { reply = { raw: out.stdout + out.stderr }; }
  return { status: out.status, reply };
}

test('a file that is not there is FILE_NOT_FOUND with the option and the folder a relative path counts from', () => {
  const missing = cli(['run', '--file', 'nope.js']);
  assert.equal(missing.status, 1);
  assert.equal(missing.reply.code, 'FILE_NOT_FOUND');
  assert.match(missing.reply.error, /nope\.js \(--file\)/);
  assert.ok(missing.reply.error.includes(home), 'names the folder');
  writeFileSync(join(home, 'ok.js'), 'return 1;');
  assert.equal(cli(['run', '--file', 'ok.js', '--args-file', 'args.json']).reply.code, 'FILE_NOT_FOUND');
});

test('a routine that does not exist is named before its arguments file is read, and revoke of one says so', () => {
  const run = cli(['routine', 'run', 'weekly-orders', '--args-file', 'args.json']);
  assert.equal(run.reply.code, 'ROUTINE_NOT_FOUND');
  assert.match(run.reply.error, /weekly-orders/);
  assert.equal(cli(['routine', 'revoke', 'no-such-routine']).reply.code, 'ROUTINE_NOT_FOUND');
});

test('watch add --then refuses an unknown routine at once and starts no host', () => {
  const added = cli(['watch', 'add', '--file', join(home, 'report.pdf'), '--then', 'no-such-routine-xyz']);
  assert.equal(added.reply.code, 'ROUTINE_NOT_FOUND');
  assert.match(added.reply.error, /no-such-routine-xyz/);
  assert.equal(cli(['host', 'status']).reply.data.running, false, 'the refusal comes before the host starts');
});

test('every failure carries a documented code: a step that failed, a script that threw, a wrong option', () => {
  const step = cli(['run'], 'await desktop.read("Notepad");');
  assert.equal(step.reply.code, 'ACTION_FAILED');
  assert.equal(step.reply.step, 'desktop.read Notepad');
  const thrown = cli(['run'], 'return marker;');
  assert.equal(thrown.reply.code, 'SCRIPT_ERROR');
  assert.match(thrown.reply.error, /marker is not defined/);
  assert.equal(cli(['run', '--colour', 'red']).reply.code, 'INVALID_ARGS');
  assert.equal(cli(['routine', 'wipe', 'x']).reply.code, 'INVALID_ARGS');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'FILE_NOT_FOUND');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'TIMEOUT' })), 'TIMEOUT');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'ACTION_FAILED');
});

test('view names the window id it could not find, with a code', () => {
  const ad = () => [{ id: 'w-1', visible: true, minimized: false, app_name: 'notepad.exe', process_instance: 'p1' }];
  assert.throws(() => view(ad, { window: 'w-1234' }), err => err.code === 'WINDOW_NOT_FOUND' && /w-1234/.test(err.message) && !/pass --window/.test(err.message));
  assert.throws(() => view(ad, { app: 'chrome.exe' }), { code: 'APP_NOT_FOUND' });
});

test('routine list --for finds a routine by an address it opens; --help names the browsers prefs takes', () => {
  const dir = join(home, 'routines', 'order-lookup');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'script.js'), 'await web.open("http://127.0.0.1:8790/orders");');
  writeFileSync(join(dir, 'routine.json'), JSON.stringify({ name: 'order-lookup', about: '查订单', params: [{ name: 'order', about: '' }], status: 'proven',
    successes: 5, failures: 0, input: false, finals: [], apps: [], hosts: ['127.0.0.1:8790'], steps: [{ label: 'web.open http://127.0.0.1:8790/orders', effects: [], ms: 70 }] }));
  writeFileSync(join(home, 'routines', 'index.json'), JSON.stringify({ routines: { 'order-lookup': { about: '查订单', params: ['order'], input: false, finals: 0,
    status: 'proven', successes: 5, failures: 0, apps: [], hosts: ['127.0.0.1:8790'] } } }));
  assert.deepEqual(cli(['routine', 'list', '--for', 'orders']).reply.data.routines, ['order-lookup (order): 查订单 [proven, 5 ok]'],
    'an index written before addresses were kept is built again');
  assert.deepEqual(cli(['routine', 'list', '--for', 'register']).reply.data.routines, []);
  const help = spawnSync(process.execPath, [workflow, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /browser is clean, chrome or space/);
});

test('web.read on a page nothing was opened in says so', async () => {
  const call = async () => ({ snapshot: '(no interactive elements)', origin: 'about:blank' });
  const done = await runScript('return await web.read();', { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call });
  assert.match(done.result, /about:blank/);
  assert.match(done.result, /web\.open/);
});
