'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');
let pipes = 0;

/** A host of its own: a fresh state folder and pipe, no native binary, and a short idle time when asked. */
function isolated(idleMs = 600000) {
  const home = mkdtempSync(join(tmpdir(), 'ad-host-'));
  const env = { ...process.env, AGENT_DESKTOP_HOME: home, AGENT_DESKTOP_HOST_PIPE: '\\\\.\\pipe\\ad-host-test-' + process.pid + '-' + (++pipes),
    AGENT_DESKTOP_BIN: join(home, 'no-native.exe'), AGENT_DESKTOP_HOST_IDLE_MS: String(idleMs) };
  delete env.AGENT_DESKTOP_POINTER_HOLDER;
  return env;
}

function cli(env, args, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [workflow, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      const text = (out || err).trim().split('\n').filter(Boolean).at(-1) ?? '';
      let reply;
      try { reply = JSON.parse(text); } catch { reply = { ok: false, error: text } }
      resolve({ code, reply });
    });
    child.stdin.end(input ?? '');
  });
}

function serve(env) {
  const child = spawn(process.execPath, [workflow, 'host', 'serve'], { env, stdio: 'ignore', windowsHide: true });
  return child;
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await delay(100);
  }
}

const statusOf = env => cli(env, ['host', 'status']).then(r => r.reply.data);
const stopHost = env => cli(env, ['host', 'stop']);

test('only one host runs per pipe, and a request with the wrong token is refused', async () => {
  const env = isolated();
  const first = serve(env);
  try {
    const status = await until(async () => (await statusOf(env))?.pid);
    assert.equal(status, first.pid);
    const second = serve(env);
    const code = await new Promise(resolve => second.on('exit', resolve));
    assert.notEqual(code, 0, 'the second host gives up');
    assert.equal((await statusOf(env)).pid, first.pid);
    const net = require('node:net');
    const reply = await new Promise(resolve => {
      const socket = net.connect(env.AGENT_DESKTOP_HOST_PIPE, () => socket.write(JSON.stringify({ token: 'wrong', op: 'status' }) + '\n'));
      let text = '';
      socket.on('data', d => { text += d; if (text.includes('\n')) { socket.end(); resolve(JSON.parse(text)); } });
    });
    assert.equal(reply.error.code, 'TOKEN_REFUSED');
  } finally { await stopHost(env); }
});

test('a host with nothing to do ends after its idle time and removes its token', async () => {
  const env = isolated(600);
  const child = serve(env);
  await until(async () => (await statusOf(env))?.pid);
  const code = await Promise.race([new Promise(resolve => child.on('exit', resolve)), delay(8000).then(() => 'still running')]);
  if (code === 'still running') child.kill();
  assert.equal(code, 0);
  assert.equal(existsSync(join(env.AGENT_DESKTOP_HOME, 'host', 'token')), false);
});

test('a detached script answers at once; a failed step waits for a fix, keeps its variables and finishes after skip', async () => {
  const env = isolated();
  const started = Date.now();
  const { reply } = await cli(env, ['run', '--detach'], 'const before = "kept"; const value = await desktop.read("nothing here"); log(value); return before + " " + value;');
  try {
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.ok(Date.now() - started < 8000);
    const id = reply.data.id;
    const waiting = (await cli(env, ['job', 'wait', id])).reply.data;
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.reason, 'fix');
    assert.equal(waiting.waiting.step, 'desktop.read nothing here');
    const refused = (await cli(env, ['job', 'retry', 'nope'])).reply;
    assert.equal(refused.ok, false);
    const skipped = (await cli(env, ['job', 'skip', id, '--value', '"补上的值"'])).reply.data;
    assert.equal(skipped.state, 'running', 'a fix moves the job on at once, so a wait right after it waits for the next change');
    const done = (await cli(env, ['job', 'wait', id])).reply.data;
    assert.equal(done.state, 'done');
    assert.equal(done.result.result, 'kept 补上的值');
    assert.deepEqual(done.result.fixes, [{ step: 'desktop.read nothing here', action: 'skip', value: '补上的值' }]);
    assert.ok(Date.parse(done.ended) <= Date.now());
    assert.equal((await cli(env, ['job', 'list'])).reply.data.jobs[0].id, id);
  } finally { await stopHost(env); }
});

test('a job wait that starts while the job runs is answered when the job ends', async () => {
  const env = isolated();
  const { reply } = await cli(env, ['run', '--detach'], 'await sleep(2500); return "slept";');
  try {
    const waited = await Promise.race([cli(env, ['job', 'wait', reply.data.id]), delay(12000).then(() => ({ reply: { data: { state: 'no answer' } } }))]);
    assert.equal(waited.reply.data.state, 'done');
    assert.equal(waited.reply.data.result.result, 'slept');
  } finally { await stopHost(env); }
});

test('job wait answers within 300 ms of the change it waits for', async () => {
  const env = isolated();
  const { reply } = await cli(env, ['run', '--detach'], 'await desktop.read("nothing here");');
  try {
    const id = reply.data.id;
    await until(async () => (await cli(env, ['job', 'show', id])).reply.data.state === 'waiting');
    const net = require('node:net');
    const token = readFileSync(join(env.AGENT_DESKTOP_HOME, 'host', 'token'), 'utf8');
    const ask = body => new Promise(resolve => {
      const socket = net.connect(env.AGENT_DESKTOP_HOST_PIPE, () => socket.write(JSON.stringify({ token, ...body }) + '\n'));
      let text = '';
      socket.on('data', d => { text += d; if (text.includes('\n')) { socket.end(); resolve({ at: Date.now(), reply: JSON.parse(text) }); } });
    });
    await ask({ op: 'fix', id, decision: { action: 'skip' } });
    const answer = await ask({ op: 'wait', id });
    assert.equal(answer.reply.data.state, 'done');
    const late = answer.at - Date.parse(answer.reply.data.ended);
    assert.ok(late < 300, 'answered ' + late + ' ms after the job ended');
  } finally { await stopHost(env); }
});

test('a failed step retried with another name runs again with it; a patch runs first; a sent step says so', async () => {
  const { fixable } = require('../../npm/lib/script-fix');
  const calls = [];
  const helpers = { desktop: { click: async (window, target, options) => {
    calls.push([target, options]);
    if (target === '提交') throw Object.assign(new Error('No control is named "提交"'), { code: 'ELEMENT_NOT_FOUND', step: 'desktop.click 提交' });
    if (target === '已发') throw Object.assign(new Error('mismatch'), { code: 'EFFECT_MISMATCH', step: 'desktop.click 已发' });
    return 'clicked ' + target;
  } } };
  const asked = [];
  const answers = [{ action: 'do', source: 'patched' }, { action: 'retry', target: '保存登记', options: { timeout: 9000 } }, { action: 'skip', value: 1 }];
  const patches = [];
  const fixes = [];
  const wrapped = fixable(helpers, { ask: async info => { asked.push(info); return answers.shift(); }, runPatch: async source => patches.push(source), fixes });
  assert.equal(await wrapped.desktop.click('登记', '提交', { near: '底部' }), 'clicked 保存登记');
  assert.deepEqual(calls.map(c => c[0]), ['提交', '提交', '保存登记']);
  assert.deepEqual(calls[2][1], { near: '底部', timeout: 9000 });
  assert.deepEqual(patches, ['patched']);
  assert.equal(asked[0].target, '提交');
  assert.equal(await wrapped.desktop.click('登记', '已发'), 1);
  assert.equal(asked[2].sent, true, 'an EFFECT_MISMATCH step was already sent');
  assert.deepEqual(fixes.map(f => f.action), ['do', 'retry', 'skip']);
});

test('stop ends a job that waits for a fix', async () => {
  const env = isolated();
  const { reply } = await cli(env, ['run', '--detach'], 'await desktop.read("x");');
  try {
    const id = reply.data.id;
    await until(async () => (await cli(env, ['job', 'show', id])).reply.data.state === 'waiting');
    const jobFile = join(env.AGENT_DESKTOP_HOME, 'host', 'jobs', id, 'job.json');
    assert.ok(existsSync(jobFile));
    const stopped = await cli(env, ['job', 'stop', id]);
    assert.ok(stopped.reply.ok);
    const final = await until(async () => { const job = (await cli(env, ['job', 'show', id])).reply.data; return ['stopped', 'failed'].includes(job.state) && job; });
    assert.equal(final.state, 'stopped');
  } finally { await stopHost(env); }
});

test('jobs still running when the host is killed are marked lost at the next start, and their process ends', async () => {
  const env = isolated();
  const { reply } = await cli(env, ['run', '--detach'], 'await sleep(60000);');
  const id = reply.data.id;
  const status = await statusOf(env);
  const jobs = join(env.AGENT_DESKTOP_HOME, 'host', 'jobs', id, 'job.json');
  assert.equal(JSON.parse(readFileSync(jobs, 'utf8')).state, 'running');
  process.kill(status.pid);
  await until(async () => !(await statusOf(env))?.pid, 5000).catch(() => {});
  const again = serve(env);
  try {
    const next = await until(async () => (await statusOf(env))?.pid && await statusOf(env));
    assert.deepEqual(next.lost_on_start, [id]);
    assert.equal(JSON.parse(readFileSync(jobs, 'utf8')).state, 'lost');
  } finally { await stopHost(env); again.kill(); }
});

test('run without --detach does not start a host', async () => {
  const env = isolated();
  const { reply } = await cli(env, ['run'], 'return 1 + 1;');
  assert.equal(reply.data.result, 2);
  assert.equal((await statusOf(env)).running, false);
  writeFileSync(join(env.AGENT_DESKTOP_HOME, 'x'), '');
});
