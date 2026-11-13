'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { deflateSync, crc32 } = require('node:zlib');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-input-'));

const { runScript } = require('../../npm/lib/script-run');
const { markRepeat, clearRepeat } = require('../../npm/lib/script-repeat');

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

const NOTEPAD = { id: 'w-1', app_name: 'notepad.exe', title: '无标题 - 记事本', visible: true, process_instance: 'p-1', bounds: { width: 100, height: 80 } };
const WINDOW = { complete: true, tree: { role: 'window', name: '记事本', children: [
  { role: 'textfield', name: '文本编辑器', ref_id: '@s1:e1' }, { role: 'button', name: '保存', ref_id: '@s1:e2' }] } };
const DRAWN = { complete: true, tree: { role: 'window', name: '自绘窗口示例', children: [
  { role: 'group', ref_id: '@s9:e1', native_id: { kind: 'automation_id', value: 'TitleBar' }, children: [{ role: 'button', name: '关闭', ref_id: '@s9:e2' }] }] } };

/** A stand-in for both CLIs that answers by command name and records every call. */
function tools(answers, extra = {}) {
  const calls = [];
  const call = async (binary, args, options = {}) => {
    const words = binary === 'browser' ? args.slice(args.indexOf('--json') + 1) : args;
    calls.push(words);
    const answer = answers[binary + ' ' + words[0]];
    if (answer === undefined) throw new Error('unexpected command: ' + binary + ' ' + words.join(' '));
    return typeof answer === 'function' ? answer(words, options, calls) : answer;
  };
  const run = (source, options) => runScript(source, { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call, ...extra, ...options });
  return { calls, run };
}

test('a script that names a real-input helper is refused whole, before any step runs', async () => {
  for (const [source, named] of [
    [`await web.open('https://example.com'); await visible.click('提交');`, 'visible.click'],
    [`human('natural'); await desktop.click('记事本', '保存');`, 'human("natural")'],
    [`await desktop.type('记事本', '文本编辑器', 'ok');`, 'desktop.type'],
    [`await desktop.cmd('click', '@s1:e2', '--headed');`, '"--headed"'],
    [`await flow('tap', { frame: 'a.png', at: '1,1' });`, 'flow("tap")'],
  ]) {
    const { calls, run } = tools({});
    const err = await run(source).catch(e => e);
    assert.equal(err.code, 'INPUT_NOT_ALLOWED', source);
    assert.ok(err.message.includes(named), err.message);
    assert.match(err.message, /run it again with --allow-input/);
    assert.deepEqual(calls, [], 'nothing was sent: ' + source);
    assert.deepEqual(err.report.steps, []);
  }
});

test('human(false) and the read-only visible helpers are not real input', async () => {
  const { run } = tools({ 'desktop list-windows': [NOTEPAD], 'desktop snapshot': WINDOW });
  const data = await run(`human(false); return await desktop.read('记事本');`);
  assert.match(data.result, /文本编辑器/);
  assert.equal(data.input_used, undefined);
});

test('a name only the picture shows is refused with where it shows, and the window never comes forward', async () => {
  const { calls, run } = tools({
    'desktop list-windows': [{ ...NOTEPAD, id: 'w-7', title: '自绘窗口示例' }],
    'desktop snapshot': DRAWN,
    'desktop screenshot': { data: tinyPng().toString('base64'), width: 1, height: 1, scale_factor: 1 },
    'desktop ocr': words => ({ lines: [], matches: words.includes('发送') ? [{ text: '发送', bounds: { x: 1000, y: 700, width: 24, height: 32 }, center: { x: 1012, y: 716 } }] : [] }),
  });
  const err = await run(`await desktop.click('自绘', '发送');`).catch(e => e);
  assert.equal(err.code, 'INPUT_NOT_ALLOWED');
  assert.match(err.message, /picture shows it at 1012,716/);
  assert.match(err.message, /run the steps that are left with run --allow-input/);
  assert.equal(err.report.step, 'desktop.click 发送');
  assert.ok(!calls.some(words => words.includes('--headed')), 'no real input and no focus change was sent');
});

test('a real-input command built at run time is refused when it is sent, and allowed with allowInput', async () => {
  const answers = { 'desktop list-windows': [NOTEPAD], 'desktop snapshot': WINDOW, 'desktop click': {} };
  const source = `const flag = '--hea' + 'ded'; await desktop.cmd('click', '@s1:e2', flag); return 1;`;
  const refused = tools(answers);
  const err = await refused.run(source).catch(e => e);
  assert.equal(err.code, 'INPUT_NOT_ALLOWED');
  assert.ok(!refused.calls.some(words => words[0] === 'click'), 'the click was not sent');
  const allowed = await tools(answers).run(source, { allowInput: true });
  assert.equal(allowed.input_used, true);
  assert.match(allowed.steps[0], /real mouse and keyboard/);
});

test('a workflow command a script hands on is checked by the same gate', async () => {
  const seen = [];
  const flow = async (command, options, gate) => { gate(['mouse-click', '--headed', '--xy=1,1']); seen.push(command); return {}; };
  const err = await runScript(`await flow('click', { page: 'p', on: '提交' });`, { native: 'desktop', call: async () => [], flow }).catch(e => e);
  assert.equal(err.code, 'INPUT_NOT_ALLOWED');
  assert.deepEqual(seen, []);
  await runScript(`await flow('click', { page: 'p', on: '提交' });`, { native: 'desktop', call: async () => [], flow, allowInput: true });
  assert.deepEqual(seen, ['click']);
});

test('a desktop click names the windows it opened and the title it changed', async () => {
  let clicked = false;
  const { run } = tools({
    'desktop list-windows': () => (clicked
      ? [{ ...NOTEPAD, title: '报告.txt - 记事本' }, { id: 'w-2', app_name: 'notepad.exe', title: '另存为', visible: true }]
      : [NOTEPAD]),
    'desktop snapshot': WINDOW,
    'desktop click': () => { clicked = true; return {}; },
  });
  const data = await run(`await desktop.click('记事本', '保存');`);
  assert.match(data.steps[0], /opened window "另存为" w-2/);
  assert.match(data.steps[0], /window title "无标题 - 记事本" -> "报告\.txt - 记事本"/);
  const quiet = tools({ 'desktop list-windows': [NOTEPAD], 'desktop snapshot': WINDOW, 'desktop click': {} });
  assert.match((await quiet.run(`await desktop.click('记事本', '保存');`)).steps[0], /^desktop\.click 保存 \d+ms$/);
});

test('a page click names what its receipt saw happen', async () => {
  const { run } = tools({
    'browser snapshot': { snapshot: '- button "下一页" [ref=e1]' },
    'browser click': { receipt: { verified: null, effects: { url_changed: true, new_tab: false, dialog_opened: false, dom_changed: true, target_removed: true } } },
  });
  const data = await run(`await web.click('下一页');`);
  assert.match(data.steps[0], /^web\.click 下一页 \(the page went to another address, the control is gone from the page\) \d+ms$/);
});

test('waitIdle returns the read once it stops changing, and warns instead of failing when it never does', async () => {
  let reads = 0;
  const growing = n => ({ complete: true, tree: { role: 'window', name: '日志', children: [{ role: 'text', name: '第 ' + n + ' 行' }] } });
  const { run } = tools({ 'desktop list-windows': [NOTEPAD], 'desktop snapshot': () => growing(Math.min(++reads, 3)) });
  const data = await run(`return await desktop.waitIdle('记事本', { quiet: 100 });`);
  assert.match(data.result, /第 3 行/);
  assert.equal(data.warnings, undefined);
  let ticks = 0;
  const busy = tools({ 'desktop list-windows': [NOTEPAD], 'desktop snapshot': () => growing(++ticks) });
  const late = await busy.run(`return await desktop.waitIdle('记事本', { timeout: 300, quiet: 100 });`);
  assert.match(late.warnings[0], /still changing after 300 ms/);
  let page = 0;
  const web = tools({ 'browser snapshot': () => ({ snapshot: '- text "已加载 ' + Math.min(++page, 2) + '"' }) });
  assert.match((await web.run(`return await web.waitIdle({ quiet: 100 });`)).result, /已加载 2/);
});

test('the same step failing the same way twice in a row is marked with a count and advice', () => {
  clearRepeat();
  const fail = (step, code) => Object.assign(new Error('x'), { code, report: { step, steps: [] } });
  assert.equal(markRepeat(fail('desktop.click 保存', 'ELEMENT_NOT_FOUND')).report.repeat, undefined);
  const second = markRepeat(fail('desktop.click 保存', 'ELEMENT_NOT_FOUND'));
  assert.equal(second.report.repeat, 2);
  assert.match(second.report.advice, /Do not run it again as it is/);
  assert.equal(markRepeat(fail('desktop.click 打开', 'ELEMENT_NOT_FOUND')).report.repeat, undefined, 'another step starts a new count');
  clearRepeat();
  assert.equal(markRepeat(fail('desktop.click 打开', 'ELEMENT_NOT_FOUND')).report.repeat, undefined, 'a run that succeeded in between resets it');
  const stale = Date.now() + 16 * 60 * 1000;
  assert.equal(markRepeat(fail('desktop.click 打开', 'ELEMENT_NOT_FOUND'), stale).report.repeat, undefined, 'an old failure does not count');
});
