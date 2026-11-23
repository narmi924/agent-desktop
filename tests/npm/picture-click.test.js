'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { deflateSync, crc32 } = require('node:zlib');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-picture-click-'));

const { runScript } = require('../../npm/lib/script-run');

function tinyPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

const WINDOW = { id: 'w-7', app_name: 'pwsh.exe', pid: 70, title: '自绘窗口示例', visible: true, process_instance: 'p-7', bounds: { width: 100, height: 80 } };
const DRAWN = { complete: true, tree: { role: 'window', name: '自绘窗口示例', children: [
  { role: 'group', ref_id: '@s9:e1', native_id: { kind: 'automation_id', value: 'TitleBar' }, children: [{ role: 'button', name: '关闭', ref_id: '@s9:e2' }] }] } };
const FORM = { complete: true, snapshot_id: 's1', tree: { role: 'window', name: '客户登记', children: [
  { role: 'textfield', name: '客户姓名', ref_id: '@s1:e1' }, { role: 'button', name: 'btn-ok', ref_id: '@s1:e2' }] } };
const SEND = { text: '发送', bounds: { x: 992, y: 706, width: 40, height: 20 }, center: { x: 1012, y: 716 }, whole_line: true };

/**
 * A stand-in for the CLI around one window whose picture shows "发送". `shown(state)` gives the picture's lines,
 * where state.posted says whether a click was posted and state.reads counts picture reads.
 */
const OTHER = { ...WINDOW, id: 'w-8', app_name: 'other.exe', pid: 80, title: '别的程序' };

function tools({ tree = DRAWN, shown = () => ['发送', '产品讨论组'], posted = () => ({ disposition: { delivery: 'delivered_unverified' } }), since, windows = () => [WINDOW, OTHER] } = {}) {
  const calls = [];
  const state = { posted: false, reads: 0 };
  const answers = {
    'list-windows': () => windows(state),
    snapshot: words => (words.includes('--since') ? { ...tree, snapshot_id: 's2', changes: since?.(state) ?? { changed: [], added: [], removed: [] } } : tree),
    screenshot: { data: tinyPng().toString('base64'), width: 1, height: 1, scale_factor: 1 },
    ocr: words => {
      state.reads++;
      const lines = shown(state).map(text => ({ text, bounds: { x: 0, y: 0, width: 10, height: 10 } }));
      if (!words.includes('--find')) return { lines };
      const wanted = words[words.indexOf('--find') + 1];
      const spots = lines.filter(line => line.text === wanted).map(line => ({ ...line, center: { x: 5, y: 5 }, whole_line: true }));
      return { lines, matches: wanted === '发送' ? [SEND] : spots };
    },
    'mouse-click': words => {
      state.posted = true;
      return posted(words);
    },
    '--headed': () => ({ disposition: { delivery: 'delivered_unverified' } }),
  };
  const call = async (binary, args) => {
    calls.push(args);
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error('unexpected command: ' + args.join(' '));
    return typeof answer === 'function' ? answer(args, state) : answer;
  };
  const run = (source, options) => runScript(source, { native: 'desktop', flags: ['--session', 't'], call, allowFinal: true, ...options });
  return { calls, run, state };
}

const headedAt = calls => calls.findIndex(args => args.includes('--headed'));
const postedAt = calls => calls.findIndex(args => args[0] === 'mouse-click' && args.includes('--post'));

test('a click by picture is posted in the background first and counts when the picture then changes', async () => {
  const { calls, run } = tools({ shown: state => (state.posted ? ['发送', '产品讨论组', '已发送'] : ['发送', '产品讨论组']) });
  const data = await run(`return await desktop.click('自绘', '发送');`, { allowInput: true });
  assert.deepEqual(data.result, { via: 'picture', background: true, text: '发送', x: 1012, y: 716, delivery: 'delivered_unverified' });
  const post = calls[postedAt(calls)];
  assert.equal(post[post.indexOf('--xy') + 1], '1012,716');
  assert.match(post[post.indexOf('--frame') + 1], /scene-.*\.png$/);
  assert.equal(headedAt(calls), -1, 'neither the window nor the pointer was taken');
  assert.match(data.steps[0], /^desktop\.click 发送 \(by picture in the background at 1012,716\) \d+ms$/);
  assert.notEqual(data.input_used, true);
});

test('a background picture click needs no input permission when the window shows its effect', async () => {
  const { calls, run } = tools({ shown: state => (state.posted ? ['发送', '已发送'] : ['发送']) });
  const data = await run(`return await desktop.click('自绘', '发送');`);
  assert.equal(data.result.background, true);
  assert.equal(headedAt(calls), -1);
});

test('a silent application receives one click regardless of input permission', async () => {
  for (const allowInput of [false, true]) {
    const { calls, run } = tools();
    await assert.rejects(run(`await desktop.click('自绘', '发送');`, { allowInput }), { code: 'CLICK_UNCONFIRMED' });
    assert.equal(calls.filter(words => words.includes('mouse-click')).length, 1);
    assert.equal(headedAt(calls), -1);
  }
});

test('a missing delivery disposition cannot authorize a real click', async () => {
  const posted = () => { throw Object.assign(new Error('No usable reply'), { code: 'INVALID_ARGS' }); };
  const { calls, run } = tools({ posted });
  await assert.rejects(run(`await desktop.click('自绘', '发送');`, { allowInput: true }), { code: 'CLICK_UNCONFIRMED' });
  assert.equal(headedAt(calls), -1);
});

test('losing the observation after sending is an unconfirmed click', async () => {
  const windows = state => { if (state.posted) throw new Error('Observation timed out'); return [WINDOW]; };
  const { calls, run } = tools({ windows });
  await assert.rejects(run(`await desktop.click('自绘', '发送');`), { code: 'CLICK_UNCONFIRMED' });
  assert.equal(headedAt(calls), -1);
});

test('a definite refusal requires input permission before using the real mouse', async () => {
  const posted = () => { throw Object.assign(new Error('Unsupported point'), { code: 'ACTION_NOT_SUPPORTED', disposition: { delivery: 'not_delivered' } }); };
  const { calls, run } = tools({ posted });
  const err = await run(`await desktop.click('自绘', '发送');`).catch(e => e);
  assert.equal(err.code, 'INPUT_NOT_ALLOWED');
  assert.match(err.message, /picture shows it at 1012,716; the window did not take a click/);
  assert.match(err.message, /run the steps that are left with run --allow-input/);
  assert.ok(postedAt(calls) >= 0);
  assert.equal(headedAt(calls), -1);
});

test('a picture that changes on its own cannot confirm the click', async () => {
  const { calls, run } = tools({ shown: state => ['发送', '12:0' + state.reads] });
  await assert.rejects(run(`return await desktop.click('自绘', '发送');`, { allowInput: true }), { code: 'CLICK_UNCONFIRMED' });
  assert.equal(headedAt(calls), -1);
});

test('a window that refuses the posted click goes straight to the real mouse, and the step says so', async () => {
  const refused = () => { throw Object.assign(new Error('The point is on a window border'), { code: 'ACTION_NOT_SUPPORTED', disposition: { delivery: 'not_delivered' } }); };
  const { calls, run } = tools({ posted: refused, shown: state => (state.posted ? ['发送', '已发送'] : ['发送']) });
  const data = await run(`return await desktop.click('自绘', '发送');`, { allowInput: true });
  assert.equal(data.result.background, undefined);
  assert.match(data.steps[0], /the window did not take a click posted in the background/);
  assert.ok(headedAt(calls) > postedAt(calls));
});

test('a control that changes after the posted click counts as its effect in a window with controls', async () => {
  const since = state => (state.posted
    ? { changed: [{ role: 'textfield', name: '客户姓名', before: { value: '' }, after: { value: '请填写' } }], added: [], removed: [] }
    : { changed: [], added: [], removed: [] });
  const { calls, run } = tools({ tree: FORM, since, shown: () => ['确定', '客户姓名'] });
  const data = await run(`return await desktop.click('w-7', '发送');`, { allowInput: true });
  assert.equal(data.result.background, true);
  assert.equal(headedAt(calls), -1);
  assert.match(data.steps[0], /"客户姓名" value "" -> "请填写"/);
});

test('a fill by picture still clicks with the real mouse, since typing takes the window anyway', async () => {
  const { calls, run } = tools({ shown: state => (state.posted ? ['发送', '你好'] : ['发送']) });
  await run(`return await desktop.fill('自绘', '发送', '你好');`, { allowInput: true });
  assert.equal(postedAt(calls), -1);
  assert.ok(headedAt(calls) >= 0);
});

test('a window of the same app that opens after the posted click is its effect; another app changing is not', async () => {
  const dialog = { ...WINDOW, id: 'w-9', title: '确认发送' };
  const opened = tools({ windows: state => (state.posted ? [WINDOW, dialog, OTHER] : [WINDOW, OTHER]) });
  const data = await opened.run(`return await desktop.click('自绘', '发送');`, { allowInput: true });
  assert.equal(data.result.background, true);
  assert.equal(headedAt(opened.calls), -1);
  const elsewhere = tools({ windows: state => [WINDOW, state.posted ? { ...OTHER, title: '别的程序 - 新标题' } : OTHER] });
  await assert.rejects(elsewhere.run(`return await desktop.click('自绘', '发送');`, { allowInput: true }), { code: 'CLICK_UNCONFIRMED' });
  assert.equal(headedAt(elsewhere.calls), -1);
});

test('an interrupted job checks the result without replaying its unconfirmed click', async () => {
  const { calls, run } = tools();
  const wait = Object.assign(() => assert.fail('must not replay on resume'), { cutShort: () => true });
  const fix = { fixes: [], ask: async info => {
    assert.equal(info.sent, true);
    return { action: 'do', source: 'return await desktop.read("自绘");' };
  } };
  const data = await run(`return await desktop.click('自绘', '发送');`, { hands: { wait }, fix });
  assert.match(data.result, /发送/);
  assert.equal(calls.filter(args => args.includes('mouse-click')).length, 1);
  assert.equal(headedAt(calls), -1);
});
