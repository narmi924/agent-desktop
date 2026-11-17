'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { deflateSync } = require('node:zlib');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-final-'));

const { runScript } = require('../../npm/lib/script-run');
const { finalWord, scanFinals } = require('../../npm/lib/script-final');
const { markBox, decode, encode } = require('../../npm/lib/png-mark');

function blankPng(width, height) {
  const stride = width * 4;
  return encode({ width, height, color: 6, channels: 4, stride, pixels: Buffer.alloc(stride * height, 255) });
}

const PAGE = '- textbox "姓名" [ref=e1]\n- button "提交注册" [ref=e2]\n- button "保存草稿" [ref=e3]';

/** A stand-in browser that records every command; a screenshot writes a small white picture. */
function browser(extra = {}) {
  const calls = [];
  const call = async (binary, args, options = {}) => {
    const words = args.slice(args.indexOf('--json') + 1);
    calls.push(words);
    if (words[0] === 'snapshot') return { snapshot: PAGE };
    if (words[0] === 'screenshot') { writeFileSync(words[1], blankPng(200, 100)); return { path: words[1] }; }
    if (words[0] === 'get' && words[1] === 'box') return { x: 20, y: 30, width: 60, height: 20 };
    if (words[0] === 'eval') return extra.eval ? extra.eval(options.input) : { result: 100 };
    if (['click', 'fill'].includes(words[0])) return { receipt: { verified: true } };
    throw new Error('unexpected ' + words.join(' '));
  };
  const run = (source, options) => runScript(source, { browser: 'browser', flags: ['--session', 't'], call, ...options });
  return { calls, run };
}

test('final words match a control name in Chinese anywhere and in English as whole words only', () => {
  const cases = { '提交注册': '提交', '确认删除': '删除', '发送文件': '发送', 'Send': 'Send', 'Submit order': 'Submit', 'Place Order': 'Place order',
    'Postal code': undefined, 'Resend': undefined, '下一步': undefined, 'Deleted items': undefined, '保存': undefined, '': undefined };
  for (const [name, word] of Object.entries(cases)) assert.equal(finalWord(name), word, name);
});

test('a script whose text shows a final click is refused whole, and {final: false} clears a name', async () => {
  const tools = browser();
  const err = await tools.run(`await web.fill('姓名', 'a'); await web.click('提交注册');`).catch(e => e);
  assert.equal(err.code, 'FINAL_NOT_ALLOWED');
  assert.deepEqual(err.details.finals, [{ what: 'web.click 提交注册', why: 'the name contains "提交"' }]);
  assert.equal(tools.calls.length, 0, 'nothing ran, not even the fill before it');
  assert.deepEqual(scanFinals(`await desktop.click("登记", "删除", { final: false });`), []);
  assert.deepEqual(scanFinals(`await web.click("保存草稿", { final: "保存后对方能看到" });`), [{ what: '保存后对方能看到', why: 'marked final' }]);
});

test('a final click only known at run time stops before it is sent and shows the target framed in red', async () => {
  const tools = browser();
  const err = await tools.run(`await web.fill('姓名', 'a'); await web.click(args.button);`, { args: { button: '提交注册' } }).catch(e => e);
  assert.equal(err.code, 'FINAL_NOT_ALLOWED');
  assert.equal(err.step, undefined, 'the refusal comes before the step starts');
  assert.ok(!tools.calls.some(c => c[0] === 'click'), 'the click was not sent');
  assert.ok(tools.calls.some(c => c[0] === 'fill'), 'the steps before it ran');
  const picture = err.details.picture;
  assert.ok(picture && existsSync(picture), 'a picture of the target');
  const image = decode(readFileSync(picture));
  const at = (x, y) => [...image.pixels.subarray(y * image.stride + x * 4, y * image.stride + x * 4 + 3)];
  assert.deepEqual(at(37, 70), [220, 30, 30], 'the frame sits just left of the box (CSS 20 at scale 2)');
  assert.deepEqual(at(60, 70), [255, 255, 255], 'inside the box stays as it was');
  rmSync(picture);
});

test('a step marked final is refused without --allow-final; with it, the run lists the final steps it took', async () => {
  const marked = await browser().run(`await web.click('保存草稿', { final: '对方会看到草稿' });`).catch(e => e);
  assert.equal(marked.code, 'FINAL_NOT_ALLOWED');
  const tools = browser();
  const done = await tools.run(`await web.click(args.b);`, { args: { b: '提交注册' }, allowFinal: true });
  assert.deepEqual(done.finals, [{ what: 'web.click 提交注册', why: 'the name contains "提交"' }]);
  assert.ok(tools.calls.some(c => c[0] === 'click'));
});

test('the user\'s own word list under the state folder replaces the shipped one', async () => {
  const own = join(process.env.AGENT_DESKTOP_HOME, 'final-words.json');
  writeFileSync(own, JSON.stringify({ words: ['保存草稿'] }));
  try {
    assert.equal(finalWord('保存草稿'), '保存草稿');
    assert.equal(finalWord('提交注册'), undefined);
  } finally { rmSync(own); }
});

test('while effects are watched, a click that opens a modal on the page records a dialog', async () => {
  let reads = 0;
  const tools = browser({ eval: () => ({ result: reads++ ? ['请确认注册信息 继续 返回修改'] : [] }) });
  const records = [];
  await tools.run(`await web.click('保存草稿');`, { watch: true, onStep: record => records.push(record) });
  assert.deepEqual(records[0].effects, [{ kind: 'dialog_opened', app: 'web' }]);
  assert.equal(tools.calls.filter(c => c[0] === 'eval').length, 2, 'one read of the open dialogs before the click and one after');
  const quiet = browser();
  await quiet.run(`await web.click('保存草稿');`);
  assert.equal(quiet.calls.filter(c => c[0] === 'eval').length, 0, 'a plain run reads no dialogs');
});

test('a click that waits behind a dialog it opened ends once the dialog shows, and the window is its effect', async () => {
  let opened = false;
  const calls = [];
  const call = (binary, args, options = {}) => {
    calls.push(args[0]);
    if (args[0] === 'list-windows') return Promise.resolve([{ id: 'w-1', app_name: 'a.exe', title: '登记' }, ...(opened ? [{ id: 'w-2', app_name: 'a.exe', title: '确认' }] : [])]);
    if (args[0] === 'snapshot') return Promise.resolve({ complete: true, tree: { role: 'window', name: '登记', children: [{ role: 'button', name: '保存', ref_id: '@s1:e1' }] } });
    if (args[0] === 'click') {
      setTimeout(() => { opened = true; }, 200);
      return new Promise((resolve, reject) => {
        const gaveUp = setTimeout(() => reject(Object.assign(new Error('Invoke returned UIA_E_TIMEOUT'), { code: 'TIMEOUT' })), 6000);
        options.signal?.addEventListener('abort', () => { clearTimeout(gaveUp); reject(options.signal.reason); });
      });
    }
    return Promise.reject(new Error('unexpected ' + args.join(' ')));
  };
  const records = [];
  const started = Date.now();
  const done = await runScript(`await desktop.click('w-1', '保存'); return 'next';`, { native: 'desktop', call, onStep: r => records.push(r) });
  assert.equal(done.result, 'next');
  assert.ok(Date.now() - started < 5000, 'the step ended within seconds, not at the command timeout');
  assert.match(done.warnings[0], /opened "确认" and the app waits for it/);
  assert.deepEqual(records[0].effects, [{ kind: 'window_opened', app: 'a.exe', title: '确认' }]);
});

test('a framed picture keeps the image and draws only the frame', () => {
  const png = blankPng(40, 30);
  const out = decode(markBox(png, { x: 10, y: 10, width: 10, height: 5 }, 2));
  assert.equal(out.width, 40);
  const px = (x, y) => out.pixels[y * out.stride + x * 4 + 1];
  assert.equal(px(8, 12), 30, 'left edge');
  assert.equal(px(15, 12), 255, 'inside');
  assert.equal(px(0, 0), 255, 'far corner');
  assert.throws(() => decode(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), deflateSync(Buffer.alloc(4))])), /Only 8-bit|not/i);
});
