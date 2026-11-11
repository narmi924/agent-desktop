'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runScript } = require('../../npm/lib/script-run');
const { parseControls, shows } = require('../../npm/lib/script-web');
const { renderTree } = require('../../npm/lib/script-desktop');
const { pick } = require('../../npm/lib/script-match');

const FORM = [
  '- heading "会员注册" [level=1, ref=e1]',
  '- textbox "姓名" [required, ref=e2]',
  '- textbox [near="邮箱：", ref=e3]',
  '- combobox "所在城市" [expanded=false, ref=e4]: 请选择',
  '  - option "北京" [ref=e5]',
  '- button "提交注册" [ref=e6]',
].join('\n');

/** A stand-in for both CLIs: answers by command name and records every call. */
function fakeTools(answers) {
  const calls = [];
  const call = async (binary, args, options = {}) => {
    const words = binary === 'browser' ? args.slice(args.indexOf('--json') + 1) : args;
    calls.push({ binary, words, input: options.input });
    const answer = answers[binary + ' ' + words[0]];
    if (answer === undefined) throw new Error('unexpected command: ' + binary + ' ' + words.join(' '));
    return typeof answer === 'function' ? answer(words, options, calls) : answer;
  };
  return { call, calls, run: (source, extra) => runScript(source, { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call, ...extra }) };
}

test('a page read becomes controls with a role, a name, a ref and nearby text', () => {
  const controls = parseControls(FORM);
  assert.deepEqual(controls[1], { role: 'textbox', name: '姓名', near: '', ref: '@e2', value: undefined, depth: 0 });
  assert.equal(parseControls('- button "加载更多" [disabled, ref=e7]')[0].disabled, true);
  assert.deepEqual(controls[2], { role: 'textbox', name: '', near: '邮箱：', ref: '@e3', value: undefined, depth: 0 });
  assert.equal(controls[4].depth, 2);
  assert.equal(controls[3].value, '请选择');
});

test('a name picks the exact control, then the trimmed name, then the text beside an unnamed one', () => {
  const controls = parseControls(FORM);
  assert.equal(pick(controls, '姓名').ref, '@e2');
  assert.equal(pick(controls, '邮箱').ref, '@e3');
  assert.equal(pick(controls, '提交').ref, '@e6');
  assert.equal(pick(controls, '不存在'), undefined);
});

test('a repeated name is refused until nth or role settles it, and buttons win over headings', () => {
  const controls = parseControls('- heading "保存" [ref=e1]\n- button "保存" [ref=e2]\n- button "删除" [ref=e3]\n- button "删除" [ref=e4]');
  assert.equal(pick(controls, '保存').ref, '@e2');
  assert.equal(pick(controls, '保存', { role: 'heading' }).ref, '@e1');
  assert.throws(() => pick(controls, '删除'), { code: 'AMBIGUOUS_TARGET' });
  assert.equal(pick(controls, '删除', { nth: 2 }).ref, '@e4');
  assert.throws(() => pick(controls, '删除', { nth: 3 }), { code: 'INVALID_ARGS' });
});

const SHOP = [
  '- table',
  '  - rowgroup',
  '    - row',
  '      - cell "天山雪菊茶 250g" [ref=e1]',
  '      - cell "279.0" [ref=e2]',
  '      - cell',
  '        - button "加入购物车" [ref=e3]',
  '    - row',
  '      - cell "和田大枣 500g" [ref=e4]',
  '      - cell "86.5" [ref=e5]',
  '      - cell',
  '        - button "加入购物车" [ref=e6]',
  '- button "加入购物车" [ref=e7]',
].join('\n');

test('near picks the control that shares a row or card with a piece of visible text', () => {
  const lines = parseControls(SHOP);
  assert.throws(() => pick(lines, '加入购物车'), { code: 'AMBIGUOUS_TARGET' });
  assert.equal(pick(lines, '加入购物车', { near: '和田大枣' }).ref, '@e6');
  assert.equal(pick(lines, '加入购物车', { near: '天山雪菊茶 250g' }).ref, '@e3');
  assert.equal(pick(lines, '加入购物车', { near: '不存在的商品' }), undefined);
});

test('a script resolves near from a full read of the page', async () => {
  const tools = fakeTools({
    'browser snapshot': words => ({ snapshot: words[1] === '-c' ? SHOP : '- button "加入购物车" [ref=e3]\n- button "加入购物车" [ref=e6]' }),
    'browser click': { receipt: { verified: true } },
  });
  await tools.run(`await web.click('加入购物车', { near: '和田大枣 500g' });`);
  assert.equal(tools.calls.at(-1).words.join(' '), 'click @e6');
});

test('text is found inside a frame line and across split text nodes', () => {
  const page = '- Iframe [ref=e1]\n  - StaticText "留言已发布，楼层 #75"\n- StaticText "合计 "\n- StaticText "128 元"';
  assert.equal(shows(page, '留言已发布'), '留言已发布，楼层 #75');
  assert.equal(shows(page, '合计 128 元'), '合计 128 元');
  assert.equal(shows(page, '失败'), undefined);
  assert.equal(shows('- button "保存" [ref=e1]\n- StaticText "已保存：古丽"', '保存'), '已保存：古丽', 'plain text wins over a control name');
});

test('a script fills and clicks by name in one run and reports every step', async () => {
  const tools = fakeTools({
    'browser open': { url: 'http://x/', title: '会员注册' },
    'browser snapshot': { snapshot: FORM },
    'browser fill': { receipt: { verified: true } },
    'browser select': { receipt: { verified: true } },
    'browser click': { receipt: { verified: true } },
  });
  const data = await tools.run(`
    await web.open('http://x/');
    await web.fill('姓名', '艾力');
    await web.fill('邮箱', 'a@example.com');
    await web.select('所在城市', '北京');
    await web.click('提交注册');
    return 'done';`);
  assert.equal(data.result, 'done');
  assert.deepEqual(tools.calls.filter(c => c.words[0] !== 'snapshot').map(c => c.words.join(' ')), [
    'open http://x/', 'fill @e2 艾力', 'fill @e3 a@example.com', 'select @e4 北京', 'click @e6',
  ]);
  assert.equal(tools.calls.filter(c => c.words[0] === 'snapshot').length, 2, 'one read serves the fills; the select changes the page, so the click reads again');
  assert.equal(data.steps.length, 5);
  assert.match(data.steps[1], /^web\.fill 姓名 \d+ms$/);
});

test('a ref that went stale is looked up again by name and the step is retried once', async () => {
  let reads = 0;
  const tools = fakeTools({
    'browser snapshot': () => ({ snapshot: reads++ ? '- button "保存" [ref=e9]' : '- button "保存" [ref=e2]' }),
    'browser click': words => {
      if (words[1] === '@e2') throw new Error('Unknown ref: e2');
      return { receipt: { verified: true } };
    },
  });
  await tools.run(`await web.click('保存');`);
  assert.deepEqual(tools.calls.map(c => c.words.join(' ')), ['snapshot -i', 'click @e2', 'snapshot -i', 'click @e9']);
});

test('a control that shows up late or is still disabled is waited for, as a person would', async () => {
  let reads = 0, clicks = 0;
  const tools = fakeTools({
    'browser snapshot': () => ({ snapshot: ++reads < 3 ? '- heading "加载中" [ref=e1]' : '- button "加入购物车" [ref=e2]' }),
    'browser click': () => {
      if (++clicks === 1) throw new Error("Element '@e2' is disabled, so the click would not reach it");
      return { receipt: { verified: true } };
    },
    'browser find': () => { throw new Error('No element found by text'); },
  });
  await tools.run(`await web.click('加入购物车');`);
  assert.equal(clicks, 2);
  assert.ok(reads >= 3);
});

test('has() is true for a control that can be used and waits out a disabled one', async () => {
  let reads = 0;
  const tools = fakeTools({
    'browser snapshot': () => ({ snapshot: ++reads < 3 ? '- button "加载更多" [disabled, ref=e1]' : '- heading "完" [ref=e2]' }),
  });
  const data = await tools.run(`return [await web.has('加载更多'), await web.has('完')];`);
  assert.deepEqual(data.result, [false, true]);
});

test('a failing step stops the script and the error carries the step and a fresh view', async () => {
  const tools = fakeTools({
    'browser snapshot': words => ({ snapshot: words[1] === '-c' ? '- StaticText "请填写 11 位手机号"' : FORM, origin: 'http://x/' }),
    'browser fill': { receipt: { verified: true } },
    'browser find': () => { throw new Error('No element found by label'); },
  });
  await assert.rejects(tools.run(`
    await web.fill('姓名', '艾力');
    await web.fill('详细地址', '解放北路', { timeout: 0 });
    await web.fill('姓名', '不应执行');`), err => {
    assert.equal(err.code, 'ELEMENT_NOT_FOUND');
    assert.equal(err.report.step, 'web.fill 详细地址');
    assert.equal(err.report.steps.length, 2);
    assert.match(err.report.steps[1], /FAILED$/);
    assert.equal(err.report.scene.view, '- StaticText "请填写 11 位手机号"');
    return true;
  });
  assert.equal(tools.calls.filter(c => c.words[0] === 'fill').length, 1);
});

test('a name the read does not show falls back to the label, and a hidden field is reported as missing', async () => {
  const tools = fakeTools({
    'browser snapshot': { snapshot: FORM, origin: 'http://x/' },
    'browser find': words => {
      if (words[2] === '出生日期') return { receipt: { verified: true } };
      throw new Error("Element [data-agent-browser-located='true'] cannot take focus (hidden, disabled or not a field), so nothing was filled");
    },
  });
  await tools.run(`await web.fill('出生日期', '1998-03-15');`);
  assert.equal(tools.calls.at(-1).words.join(' '), 'find label 出生日期 fill 1998-03-15 --exact');
  await assert.rejects(tools.run(`await web.fill('隐藏地址', 'x', { timeout: 0 });`), { code: 'ELEMENT_NOT_FOUND' });
});

test('an unconfirmed action becomes a warning and waitText returns the text it found', async () => {
  const tools = fakeTools({
    'browser snapshot': words => ({ snapshot: words[1] === '-c' ? '- StaticText "注册成功，会员编号 M8573"' : FORM }),
    'browser click': { receipt: { verified: false } },
  });
  const data = await tools.run(`await web.click('提交注册'); return await web.waitText('会员编号');`);
  assert.equal(data.result, '注册成功，会员编号 M8573');
  assert.deepEqual(data.warnings, ['web.click "提交注册" was sent, but the page did not confirm it.']);
});

test('waitText gives up with a timeout and names what it waited for', async () => {
  const tools = fakeTools({ 'browser snapshot': { snapshot: '- StaticText "提交中"', origin: 'http://x/' } });
  await assert.rejects(tools.run(`await web.waitText('注册成功', 150);`), { code: 'TIMEOUT', message: /注册成功/ });
});

const WINDOW = {
  complete: true,
  tree: { role: 'window', name: '记事本', children: [
    { role: 'group', children: [
      { role: 'textfield', name: '文件名', value: 'a.txt', ref_id: '@s1:e1' },
      { role: 'button', name: '保存', ref_id: '@s1:e2', states: ['disabled'] },
    ] },
    { role: 'statictext', name: '共 3 行' },
  ] },
};

test('a window tree renders one line per named node and skips unnamed wrappers', () => {
  const { text, controls } = renderTree(WINDOW);
  assert.equal(text, ['- window "记事本"', '  - textfield "文件名" [@s1:e1]: a.txt', '  - button "保存" [disabled, @s1:e2]', '  - statictext "共 3 行"'].join('\n'));
  assert.deepEqual(controls.filter(c => c.ref).map(c => [c.ref, c.depth]), [["@s1:e1", 2], ["@s1:e2", 2]]);
});

test('desktop steps find the window by name and the control by name, and text goes through stdin', async () => {
  const tools = fakeTools({
    'desktop list-windows': [
      { id: 'w-1', app_name: 'notepad.exe', title: '无标题 - 记事本' },
      { id: 'w-2', app_name: 'chrome.exe', title: 'Chrome', minimized: true },
    ],
    'desktop snapshot': WINDOW,
    'desktop set-value': { disposition: { delivery: 'delivered_verified' } },
    'desktop click': { disposition: { delivery: 'delivered_unverified' } },
    'desktop get': { value: '报告.txt' },
  });
  const data = await tools.run(`
    await desktop.fill('notepad', '文件名', '报告.txt');
    const value = await desktop.value('notepad', '文件名');
    await desktop.click('notepad', '保存');
    return value;`);
  assert.equal(data.result, '报告.txt');
  const fill = tools.calls.find(c => c.words[0] === 'set-value');
  assert.deepEqual([fill.words.join(' '), fill.input], ['set-value @s1:e1 --stdin', '报告.txt']);
  assert.equal(data.warnings, undefined, 'a click has nothing to read back, so it is not reported as unconfirmed');
  assert.equal(tools.calls.filter(c => c.words[0] === 'list-windows').length, 1, 'the window is looked up once per script');
  await assert.rejects(tools.run(`await desktop.read('chrome');`), { code: 'WINDOW_NOT_FOUND' });
  assert.equal((await tools.run(`return await desktop.waitText('notepad', '共 3');`)).result, '共 3 行');
});

test('desktop.check clicks a box only when it is not ticked yet and confirms the new state', async () => {
  let ticked = false, clicks = 0;
  const tools = fakeTools({
    'desktop snapshot': () => ({ complete: true, tree: { role: 'window', name: '登记', children: [{ role: 'checkbox', name: '已核对', ref_id: '@s1:e1', states: ticked ? ['checked'] : [] }] } }),
    'desktop click': () => { clicks++; ticked = !ticked; return {}; },
  });
  const data = await tools.run(`return [await desktop.check('w-1', '已核对'), await desktop.check('w-1', '已核对'), await desktop.uncheck('w-1', '已核对')];`);
  assert.deepEqual(data.result, [true, true, true]);
  assert.equal(clicks, 2, 'the second check finds the box ticked and leaves it alone');
});

test('near works in a window too: the button in the list row that shows a file name', async () => {
  const row = (name, ref) => ({ role: 'listitem', children: [{ role: 'statictext', name }, { role: 'button', name: '删除', ref_id: ref }] });
  const tools = fakeTools({
    'desktop snapshot': { complete: true, tree: { role: 'window', name: '文件', children: [row('报告.txt', '@s1:e1'), row('草稿.txt', '@s1:e2')] } },
    'desktop click': {},
  });
  await tools.run(`await desktop.click('w-9', '删除', { near: '草稿.txt' });`);
  assert.equal(tools.calls.at(-1).words.join(' '), 'click @s1:e2');
  await assert.rejects(tools.run(`await desktop.click('w-9', '删除', { timeout: 0 });`), { code: 'AMBIGUOUS_TARGET' });
});

test('a script can mix page and desktop steps and pass values between them', async () => {
  const tools = fakeTools({
    'desktop list-windows': [{ id: 'w-1', app_name: 'notepad.exe', title: '记事本' }],
    'desktop snapshot': WINDOW,
    'desktop get': { value: 'a.txt' },
    'browser snapshot': { snapshot: FORM },
    'browser fill': { receipt: { verified: true } },
  });
  await tools.run(`await web.fill('姓名', await desktop.value('w-1', '文件名'));`);
  assert.equal(tools.calls.at(-1).words.join(' '), 'fill @e2 a.txt');
});

test('a script that does not parse, does not finish or fails an expectation is reported as such', async () => {
  const tools = fakeTools({});
  await assert.rejects(tools.run('await web.open('), { code: 'INVALID_ARGS' });
  await assert.rejects(tools.run('await new Promise(() => {});', { timeout: 60 }), { code: 'TIMEOUT' });
  await assert.rejects(tools.run(`log('a', { b: 1 }); expect(1 === 2, '数量不对');`), err => {
    assert.equal(err.code, 'EXPECTATION_FAILED');
    assert.deepEqual(err.report.logs, ['a {"b":1}']);
    return true;
  });
});

test('a helper that does not exist names the ones that do', async () => {
  await assert.rejects(fakeTools({}).run(`await desktop.tick('w-1', '已核对');`), err => {
    assert.equal(err.code, 'INVALID_ARGS');
    assert.match(err.message, /desktop\.tick is not a helper\. desktop has: apps, check, click, cmd, fill,/);
    return true;
  });
});

test('helpers report a missing tool instead of failing to spawn', async () => {
  await assert.rejects(runScript(`await web.open('http://x/');`, { native: 'desktop', call: async () => ({}) }), /agent-browser is not installed/);
});

test('flow() hands any other workflow command its options and refuses to nest a script', async () => {
  const seen = [];
  const tools = fakeTools({});
  const data = await tools.run(`return await flow('view', { window: 'w-1', output: 'a.png' });`, {
    flow: async (command, options) => { seen.push([command, options]); return { saved: options.output }; },
  });
  assert.deepEqual(data.result, { saved: 'a.png' });
  assert.deepEqual(seen, [['view', { window: 'w-1', output: 'a.png' }]]);
  await assert.rejects(tools.run(`await flow('run', {});`, { flow: async () => ({}) }), /cannot run "run"/);
});

test('desktop.apps lists installed apps and desktop.launch opens one and reports its window', async () => {
  const tools = fakeTools({
    'desktop list-apps': { installed_apps: [{ name: '计算器', id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', kind: 'packaged' }] },
    'desktop launch': { app: 'CalculatorApp.exe', pid: 14720, window: { id: 'w-7', title: '计算器' } },
  });
  const data = await tools.run(`return [await desktop.apps('计算'), await desktop.launch('计算器', { args: ['-x'] })];`);
  assert.equal(data.result[0][0].kind, 'packaged');
  assert.deepEqual(data.result[1], { app: 'CalculatorApp.exe', pid: 14720, window: 'w-7', title: '计算器' });
  assert.deepEqual(tools.calls.map(c => c.words.join(' ')), ['list-apps --installed --app 计算', 'launch 计算器 --arg=-x']);
});

test('desktop.selection reads the selection of the focused control and is null without one', async () => {
  const focusedTree = {
    complete: true,
    tree: { role: 'window', name: '记事本', children: [{ role: 'textfield', name: '正文', ref_id: '@s1:e1', states: ['focused'] }] },
  };
  const tools = fakeTools({
    'desktop snapshot': focusedTree,
    'desktop get': words => ({ property: words[3], value: '选中的一段' }),
  });
  const data = await tools.run(`return [await desktop.focused('w-1'), await desktop.selection('w-1')];`);
  assert.deepEqual(data.result, [{ role: 'textfield', name: '正文', ref: '@s1:e1' }, '选中的一段']);
  assert.equal(tools.calls.at(-1).words.join(' '), 'get @s1:e1 --property selection');

  const unfocused = fakeTools({ 'desktop snapshot': WINDOW, 'desktop get': words => ({ value: words[1] === '@s1:e1' ? 'a.t' : null }) });
  assert.equal((await unfocused.run(`return await desktop.selection('w-1');`)).result, 'a.t', 'a background window reports no focus, so its text fields are asked');
  const nothing = fakeTools({ 'desktop snapshot': WINDOW, 'desktop get': { value: null } });
  assert.equal((await nothing.run(`return await desktop.selection('w-1');`)).result, null);
});

test('web.selection runs one page read and returns null for nothing selected', async () => {
  const tools = fakeTools({ 'browser eval': (words, options) => ({ result: options.input.includes('getSelection') ? null : 'x' }) });
  assert.equal((await tools.run(`return await web.selection();`)).result, null);
  assert.equal(tools.calls.length, 1);
});

const { choose } = require('../../npm/lib/script-picture');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { deflateSync, crc32 } = require('node:zlib');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-script-'));

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

const DRAWN = {
  complete: true,
  tree: { role: 'window', name: '自绘窗口示例', children: [
    { role: 'group', ref_id: '@s9:e1', native_id: { kind: 'automation_id', value: 'TitleBar' }, children: [
      { role: 'button', name: '关闭', ref_id: '@s9:e2' },
    ] },
  ] },
};

const SPOT = (text, x, y, whole = true) => ({ text, bounds: { x: x - 20, y: y - 10, width: 40, height: 20 }, center: { x, y }, whole_line: whole });

/** A self-drawn window: its tree has only a title bar, and `places` says where its picture shows each text. */
function drawnTools(places, { tree = DRAWN, typed } = {}) {
  const shown = { ...places };
  return fakeTools({
    'desktop list-windows': [{ id: 'w-7', app_name: 'pwsh.exe', title: '自绘窗口示例', visible: true, process_instance: 'p-7', bounds: { width: 100, height: 80 } }],
    'desktop snapshot': tree,
    'desktop click': { disposition: { delivery: 'delivered_verified' } },
    'desktop screenshot': { data: tinyPng().toString('base64'), width: 1, height: 1, scale_factor: 2.25 },
    'desktop ocr': words => {
      const find = words.indexOf('--find');
      const lines = Object.entries(shown).map(([text, spots]) => ({ text, bounds: spots[0].bounds }));
      return find < 0 ? { lines } : { lines, matches: shown[words[find + 1]] ?? [] };
    },
    'desktop --headed': (words, options) => {
      if (words[1] === 'type') {
        if (typed) shown[options.input] = [SPOT(options.input, 600, 600)];
        return { disposition: { delivery: 'delivered_unverified' } };
      }
      return { disposition: { delivery: 'delivered_unverified' }, x: 1, y: 1 };
    },
  });
}

test('a window with nothing but a title bar is clicked by its picture, with the real mouse', async () => {
  const tools = drawnTools({ 发送: [SPOT('发送', 1012, 716)] });
  const data = await tools.run(`return await desktop.click('自绘', '发送');`);
  assert.deepEqual(data.result, { via: 'picture', text: '发送', x: 1012, y: 716, delivery: 'delivered_unverified' });
  const headed = tools.calls.filter(c => c.words[0] === '--headed').map(c => c.words.slice(1, 3).join(' '));
  assert.deepEqual(headed, ['focus-window --window-id', '--when-idle 600'], 'the window comes forward before it is captured and clicked');
  const click = tools.calls.find(c => c.words.includes('mouse-click'));
  assert.equal(click.words[click.words.indexOf('--xy') + 1], '1012,716');
  assert.match(click.words[click.words.indexOf('--frame') + 1], /scene-.*\.png$/);
  const ocr = tools.calls.find(c => c.words[0] === 'ocr');
  assert.equal(ocr.words[ocr.words.indexOf('--scale') + 1], '2.25', 'the picture is read at the scale it was captured at');
  assert.match(data.steps[0], /^desktop\.click 发送 \(by picture at 1012,716\) \d+ms$/);
});

test('a name no control has is looked for in the picture at once, not after the wait', async () => {
  const tools = drawnTools({ 发送: [SPOT('发送', 50, 60)] }, { tree: WINDOW });
  const started = Date.now();
  const data = await tools.run(`return await desktop.click('自绘', '发送');`);
  assert.equal(data.result.via, 'picture');
  assert.ok(Date.now() - started < 1000, 'no four-second wait before the picture');
});

test('a name a control has never touches the picture, and picture:false keeps a step to controls', async () => {
  const tools = drawnTools({ 保存: [SPOT('保存', 50, 60)] }, { tree: WINDOW });
  await tools.run(`await desktop.click('自绘', '文件名');`);
  assert.deepEqual(tools.calls.map(c => c.words[0]), ['list-windows', 'snapshot', 'click']);
  await assert.rejects(tools.run(`await desktop.click('自绘', '发送', { picture: false, timeout: 50 });`), { code: 'ELEMENT_NOT_FOUND' });
  assert.ok(!tools.calls.some(c => c.words[0] === 'ocr'), 'the picture is captured for the failure scene only, never read');
});

test('the same text in several places is refused with the places, and nth or near picks one', () => {
  const places = [SPOT('产品讨论组', 120, 220), SPOT('产品讨论组', 600, 40)];
  assert.throws(() => choose(places, '产品讨论组'), err => err.code === 'AMBIGUOUS_TARGET' && /\(120,220\).*\(600,40\)/.test(err.message));
  assert.equal(choose(places, '产品讨论组', { nth: 2 }).center.x, 600);
  assert.throws(() => choose(places, '产品讨论组', { nth: 3 }), { code: 'INVALID_ARGS' });
  assert.equal(choose(places, '产品讨论组', { near: '王磊' }, [SPOT('王磊: 明天', 130, 250)]).center.x, 120);
  assert.equal(choose(places, '产品讨论组', { near: '不存在' }, []), undefined);
  assert.throws(() => choose(places, 'x', { near: 'y' }, [SPOT('y', 360, 130)]), { code: 'AMBIGUOUS_TARGET' });
});

test('fill by picture clicks the text, types into the window and checks the text shows', async () => {
  const tools = drawnTools({ 输入消息: [SPOT('输入消息', 330, 660)] }, { typed: true });
  const data = await tools.run(`return await desktop.fill('自绘', '输入消息', '你好 Build 1482');`);
  assert.equal(data.result, true);
  const type = tools.calls.find(c => c.words[1] === 'type');
  assert.deepEqual([type.words.join(' '), type.input], ['--headed type --window-id w-7 --stdin', '你好 Build 1482']);
  const silent = drawnTools({ 输入消息: [SPOT('输入消息', 330, 660)] });
  const unseen = await silent.run(`return await desktop.fill('自绘', '输入消息', '看不见');`);
  assert.equal(unseen.result, false);
  assert.match(unseen.warnings[0], /does not show it/);
});

test('reading a drawn window adds the picture text, marked as such', async () => {
  const tools = drawnTools({ 产品讨论组: [SPOT('产品讨论组', 120, 220)], 'Build 1482 passed': [SPOT('Build 1482 passed', 120, 380)] });
  const data = await tools.run(`return await desktop.read('自绘');`);
  assert.match(data.result, /- picture \(text read from the screen, not from controls\):/);
  assert.match(data.result, /- text "Build 1482 passed" \[picture 120,380\]/);
  assert.match(data.steps[0], /\(with picture text\)/);
  const controls = drawnTools({ 发送: [SPOT('发送', 1, 1)] }, { tree: WINDOW });
  assert.doesNotMatch((await controls.run(`return await desktop.read('自绘');`)).result, /picture/, 'a window with controls reads as before');
});

test('has, waitFor and waitText see text that only the picture shows', async () => {
  const tools = drawnTools({ '已发送 3 条': [SPOT('已发送 3 条', 400, 500)] });
  const data = await tools.run(`
    const has = await desktop.has('自绘', '已发送 3 条');
    const missing = await desktop.has('自绘', '不存在', { picture: false });
    const at = await desktop.waitFor('自绘', '已发送 3 条', { timeout: 100 });
    const line = await desktop.waitText('自绘', '已发送 3 条', 100);
    return { has, missing, at, line };`);
  assert.deepEqual(data.result, { has: true, missing: false, at: { via: 'picture', text: '已发送 3 条', x: 400, y: 500 }, line: '已发送 3 条' });
  assert.ok(data.steps.every(s => /in the picture|has 不存在/.test(s)));
});

test('a failed desktop step leaves a screenshot path in the scene', async () => {
  const tools = drawnTools({});
  const err = await tools.run(`await desktop.click('自绘', '不存在', { timeout: 50 });`).catch(e => e);
  assert.equal(err.code, 'ELEMENT_NOT_FOUND');
  assert.match(err.report.scene.screenshot, /scene-.*\.png$/);
});

test('every command a script starts holds the agent pointer for the whole script', async () => {
  const seen = [];
  const call = async (binary, args, options) => { seen.push(options.env?.AGENT_DESKTOP_POINTER_HOLDER); return []; };
  await runScript(`await desktop.windows();`, { native: 'desktop', call, env: { PATH: 'x' } });
  assert.deepEqual(seen, [String(process.pid)]);
  await runScript(`await desktop.windows();`, { native: 'desktop', call, env: { AGENT_DESKTOP_POINTER_HOLDER: '77' } });
  assert.equal(seen.at(-1), '77', 'an outer holder is kept');
});

test('a script that times out ends its process at once, so nothing it started keeps holding the pointer', () => {
  const { spawnSync } = require('node:child_process');
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js'), 'run', '--timeout-ms', '300'],
    { input: 'await sleep(20000);', encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /did not finish within 300 ms/);
  assert.ok(Date.now() - started < 5000, 'the process ended with the reply, not after the script\'s own timer');
});
