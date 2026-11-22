'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runScript } = require('../../npm/lib/script-run');
const { BACKGROUND_ONLY } = require('../../npm/lib/script-screen');

const PAGE = { page: 'handle-1', window: 'w-9', title: '会员注册', url: 'http://127.0.0.1:8790/register', instance: 'i1', instances: ['i1'], text: '会员注册\n已注册，会员号 M1042',
  controls: [{ ref: '@s1:e1', role: 'textfield', name: '姓名' }, { ref: '@s1:e2', role: 'checkbox', name: '我已阅读并同意会员条款' },
    { ref: '@s1:e3', role: 'combobox', name: '所在城市' }, { ref: '@s1:e4', role: 'button', name: '提交注册' }] };
const WINDOW = { complete: true, tree: { role: 'window', name: '会员注册 - Google Chrome', children: [] } };

/**
 * Runs a script the way --mode record does: on screen, at a human pace. `page` answers the workflow's current
 * command; the native stand-in answers the window commands desktop.sequence sends.
 */
function onScreen(source, { page = () => PAGE, opened = [], extra = {} } = {}) {
  const flows = [], calls = [];
  let ticked = false;
  const flow = async (command, options) => {
    flows.push([command, JSON.parse(JSON.stringify(options))]);
    if (command === 'current') {
      const now = page(flows);
      return { ...now, controls: now.controls.map(c => (c.role === 'checkbox' && ticked ? { ...c, checked: true } : c)) };
    }
    if (command === 'click' && options.role === 'checkbox') ticked = true;
    return { verified: true };
  };
  const call = async (binary, args) => {
    calls.push(args);
    if (args[0] === 'list-windows') return [{ id: 'w-9', app_name: 'chrome.exe', title: '会员注册 - Google Chrome', visible: true }];
    if (args.includes('snapshot')) return WINDOW;
    if (args.includes('batch')) return { results: [{ ok: true }], completed_entries: 1 };
    return {};
  };
  const result = runScript(source, { native: 'desktop', call, flow, allowInput: true, allowFinal: true, startPace: 'natural', screen: true,
    openUrl: url => opened.push(url), ...extra });
  return { result, flows, calls, opened };
}

test('on screen, a background-style script fills, ticks, picks and clicks in the Chrome window the user sees', async () => {
  const { result, flows } = onScreen(`
    await web.fill("姓名", "Gulnar 古丽娜尔");
    await web.check("我已阅读并同意会员条款");
    await web.select("所在城市", "乌鲁木齐");
    await web.click("提交注册");
    return await web.waitText("会员号");`);
  const done = await result;
  assert.equal(done.result, '已注册，会员号 M1042');
  const acts = flows.filter(([command]) => command !== 'current');
  assert.deepEqual(acts[0], ['type', { page: 'handle-1', field: '姓名', value: 'Gulnar 古丽娜尔', replace: true, visible: true, human: 'natural' }]);
  assert.deepEqual(acts[1], ['click', { page: 'handle-1', on: '我已阅读并同意会员条款', role: 'checkbox', visible: true, human: 'natural' }]);
  assert.deepEqual(acts[2], ['choose', { page: 'handle-1', field: '所在城市', value: '乌鲁木齐' }]);
  assert.deepEqual(acts[3], ['click', { page: 'handle-1', on: '提交注册', visible: true, human: 'natural' }]);
  assert.ok(done.steps.every(line => line.startsWith('visible.')), 'every step says it happened on screen: ' + done.steps.join(' | '));
});

test('on screen, open uses a new Chrome tab and waits until that new tab is the one shown', async () => {
  let reads = 0;
  const fresh = { ...PAGE, title: '新开的注册页', instance: 'i2', instances: ['i1', 'i2'] };
  const { result, opened } = onScreen('return (await web.open("http://127.0.0.1:8790/register")).title;', {
    page: () => (++reads < 4 ? PAGE : fresh),
  });
  assert.equal((await result).result, '新开的注册页', 'the tab that was open before, at the very same address, is not taken for the new one');
  assert.deepEqual(opened, ['http://127.0.0.1:8790/register']);
  assert.ok(reads >= 4, 'it read again until the new tab showed');
});

test('two orders that differ only in their number are never mixed up when one is opened', async () => {
  let reads = 0;
  const first = { ...PAGE, title: '订单 D6181', url: 'http://127.0.0.1:8790/orders?id=D6181', instance: 'i1', instances: ['i1'] };
  const second = { ...PAGE, title: '订单 D6182', url: 'http://127.0.0.1:8790/orders?id=D6182', instance: 'i2', instances: ['i1', 'i2'] };
  const { result } = onScreen('return (await web.open("http://127.0.0.1:8790/orders?id=D6182")).title;', {
    page: () => (++reads < 4 ? first : second),
  });
  assert.equal((await result).result, '订单 D6182');
});

test('on screen, open refuses anything but a web address, before anything starts', async () => {
  for (const address of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'http://a.example/x" --flag']) {
    const { result, opened } = onScreen('await web.open(' + JSON.stringify(address) + ');');
    await assert.rejects(result, { code: 'INVALID_ARGS' });
    assert.deepEqual(opened, []);
  }
});

test('on screen, keys go to the bound Chrome window through one native batch', async () => {
  const { result, calls } = onScreen('await web.read(); await web.press("enter"); return true;');
  assert.equal((await result).result, true);
  const batch = calls.find(args => args.includes('batch'));
  assert.ok(batch, 'a batch was sent');
  assert.deepEqual(JSON.parse(batch.at(-1)), [{ command: 'press', args: { combo: 'enter', window_id: 'w-9' } }]);
  assert.ok(batch.includes('--headed'), 'the key is real input');
});

test('on screen, helpers that only the background browser has are refused with a reason', async () => {
  for (const name of BACKGROUND_ONLY) {
    const { result, flows } = onScreen('await web.' + name + '("x");');
    await assert.rejects(result, error => error.code === 'INVALID_ARGS' && /background browser only/.test(error.message), name);
    assert.deepEqual(flows.filter(([command]) => command !== 'current'), [], name + ' sent nothing');
  }
  await assert.rejects(onScreen('await web.click("提交注册", {near: "会员"});').result, /\{near\} works in the background browser only/);
});

test('without the on-screen way, web steps stay in the background browser', async () => {
  const calls = [];
  const call = async (binary, args) => {
    calls.push([binary, ...args]);
    if (args.includes('snapshot')) return { snapshot: '- button "提交注册" [ref=e4]' };
    return { success: true };
  };
  await runScript('await web.click("提交注册");', { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call, flow: async () => { throw new Error('nothing on screen'); }, allowInput: true, allowFinal: true }).catch(() => {});
  assert.ok(calls.some(c => c[0] === 'browser'), 'the background browser was asked');
});
