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
    assert.match(err.message, /desktop\.tick is not a helper\. desktop has: check, click, cmd, fill,/);
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
