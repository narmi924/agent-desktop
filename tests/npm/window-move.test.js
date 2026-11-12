'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { deflateSync, crc32 } = require('node:zlib');
const { view, tap } = require('../../npm/lib/window-move');
const { typePage } = require('../../npm/lib/page-input');

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

/** A one-pixel PNG, the smallest picture `view` can store a frame in. */
function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

const WINDOW = { id: 'w-1', pid: 7, process_instance: 'g-7', title: '订单', app_name: 'Shop', visible: true, minimized: false, is_focused: false, bounds: { width: 1, height: 1 } };

/** A stand-in for the native CLI that records each command and answers by name. */
function fakeNative(answers) {
  const calls = [];
  const ad = (...args) => {
    calls.push(args.join(' '));
    const answer = answers[args.find(arg => Object.hasOwn(answers, arg))];
    if (answer === undefined) throw new Error('unexpected command: ' + args.join(' '));
    return typeof answer === 'function' ? answer(args, calls) : answer;
  };
  return { ad, calls };
}

function withState(run) {
  const home = mkdtempSync(join(tmpdir(), 'agent-desktop-view-'));
  const before = process.env.AGENT_DESKTOP_HOME;
  process.env.AGENT_DESKTOP_HOME = home;
  try { return run(home); } finally {
    if (before === undefined) delete process.env.AGENT_DESKTOP_HOME; else process.env.AGENT_DESKTOP_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
}

const shot = () => ({ data: png().toString('base64'), width: 1, height: 1, scale_factor: 1 });

test('view without --output saves under a new name each time and reports the path', () => withState(home => {
  const { ad } = fakeNative({ 'list-windows': [WINDOW], screenshot: shot });
  const first = view(ad, { window: 'w-1' }), second = view(ad, { window: 'w-1' });
  assert.notEqual(first.path, second.path);
  assert.ok(existsSync(first.path) && existsSync(second.path));
  assert.equal(readdirSync(join(home, 'views')).length, 2);
}));

test('view never overwrites a picture and says how to get a new one', () => withState(home => {
  const { ad, calls } = fakeNative({ 'list-windows': [WINDOW], screenshot: shot });
  const taken = join(home, 'a.png');
  writeFileSync(taken, 'kept');
  assert.throws(() => view(ad, { window: 'w-1', output: taken }), /never overwritten\. Leave out --output/);
  assert.deepEqual(calls, [], 'nothing is captured for a name that is taken');
}));

test('view captures again while a loading page keeps changing the window title', () => withState(() => {
  let listed = 0;
  const titles = ['加载中', '订单', '订单', '订单'];
  const { ad, calls } = fakeNative({
    'list-windows': () => [{ ...WINDOW, title: titles[Math.min(Math.max(listed++ - 1, 0), titles.length - 1)] }],
    screenshot: shot,
  });
  const result = view(ad, { window: 'w-1' });
  assert.equal(result.title, '订单');
  assert.equal(calls.filter(call => call.startsWith('screenshot')).length, 2);
}));

test('view gives up with a plain reason when the window never settles', () => withState(() => {
  let listed = 0;
  const { ad } = fakeNative({ 'list-windows': () => [{ ...WINDOW, title: 't' + listed++ }], screenshot: shot });
  assert.throws(() => view(ad, { window: 'w-1' }), /kept changing while it was captured/);
}));

test('tap brings the captured window forward before the click is sent', () => withState(() => {
  const { ad, calls } = fakeNative({
    'list-windows': [WINDOW], screenshot: shot, 'focus-window': {},
    'mouse-click': { disposition: { delivery: 'delivered_unverified' }, x: 0, y: 0, window: 'w-1' },
  });
  const frame = view(ad, { window: 'w-1' }).path;
  calls.length = 0;
  tap(ad, { frame, at: '0,0' });
  assert.equal(calls[1], 'focus-window --window-id w-1 --headed');
  assert.ok(calls[2].includes('mouse-click --frame'));

  const front = fakeNative({ 'list-windows': [{ ...WINDOW, is_focused: true }], 'mouse-click': { disposition: {} } });
  tap(front.ad, { frame, at: '0,0' });
  assert.ok(!front.calls.some(call => call.startsWith('focus-window')), 'a window already in front is left alone');
}));

test('page typing refuses a fixed interval together with a human pace before touching the page', async () => {
  const { ad, calls } = fakeNative({});
  await assert.rejects(typePage(ad, () => ({}), { page: 'p', field: '备注', value: 'x', human: 'natural', 'interval-ms': '200' }),
    /--interval-ms or --human, not both/);
  assert.deepEqual(calls, []);
});

test('coordinates split into separate words by a shell are read as one point', () => {
  const run = spawnSync(process.execPath, [join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js'), 'tap', '--frame', join(tmpdir(), 'no-such-frame.png'), '--at', '812', '604'],
    { encoding: 'utf8' });
  const reply = JSON.parse(run.stderr);
  assert.equal(reply.ok, false);
  assert.doesNotMatch(reply.error, /Unexpected argument/);
  assert.match(reply.error, /ENOENT|no such file/i);
});
