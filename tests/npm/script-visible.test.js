'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runScript } = require('../../npm/lib/script-run');
const { readingMs } = require('../../npm/lib/script-visible');
const { restingPoint, panelClip } = require('../../npm/lib/page-pointer');

const QUIZ = { page: 'handle-1', window: 'w-9', title: '练习', url: 'https://example.com/quiz', text: '第 1 题',
  controls: [{ ref: '@s1:e1', role: 'radiobutton', name: '选项甲' }, { ref: '@s1:e2', role: 'radiobutton', name: '选项乙', checked: true },
    { ref: '@s1:e3', role: 'checkbox', name: '我已阅读说明' }, { ref: '@s1:e4', role: 'button', name: '提交' }] };

const WINDOW = { complete: true, tree: { role: 'window', name: '登记', children: [
  { role: 'textfield', name: '备注', ref_id: '@s1:e1' }, { role: 'button', name: '保存', ref_id: '@s1:e2' }] } };

/** Runs a script with a stand-in for the workflow commands and for the native CLI. */
function run(source, flow, native = {}) {
  const flows = [], calls = [];
  const call = async (binary, args, options = {}) => {
    calls.push({ words: args, input: options.input });
    const answer = native[args.find(arg => Object.hasOwn(native, arg))];
    if (answer === undefined) throw new Error('unexpected command: ' + args.join(' '));
    return answer;
  };
  const result = runScript(source, { native: 'desktop', call, allowInput: true,
    flow: async (command, options) => { flows.push([command, JSON.parse(JSON.stringify(options))]); return flow(command, options, flows); } });
  return { result, flows, calls };
}

test('reading time grows with the text, counts Chinese by the character and stops at a ceiling', () => {
  const steady = () => 0.5;
  assert.equal(readingMs('', steady), 0);
  assert.equal(readingMs('好', steady), 480);
  assert.equal(readingMs('read this line', steady), 1100);
  assert.ok(readingMs('读'.repeat(40), steady) > readingMs('读'.repeat(10), steady));
  assert.equal(readingMs('读'.repeat(5000), steady), 12000);
});

test('readTime returns at once until human() is on, then waits for the text', async () => {
  const quick = Date.now();
  await run(`await readTime('这是一段需要读一会儿的说明文字');`, () => QUIZ).result;
  assert.ok(Date.now() - quick < 250);
  const slow = Date.now();
  await run(`human('natural'); await readTime('好');`, () => QUIZ).result;
  assert.ok(Date.now() - slow >= 380);
  await assert.rejects(run(`human('fast');`, () => QUIZ).result, { code: 'INVALID_ARGS' });
});

test('visible.choose ticks a choice with one click and confirms the page shows it selected', async () => {
  let clicked = false;
  const { result, flows } = run(`human('natural'); return await visible.choose('选项甲');`, command => {
    if (command === 'click') { clicked = true; return { delivery: 'delivered_unverified' }; }
    return { ...QUIZ, controls: QUIZ.controls.map(control => (control.name === '选项甲' && clicked ? { ...control, checked: true } : control)) };
  });
  assert.deepEqual((await result).result, { changed: true, checked: true });
  assert.deepEqual(flows.find(([command]) => command === 'click'), ['click', { page: 'handle-1', on: '选项甲', role: 'radiobutton', visible: true, human: 'natural' }]);
});

test('visible.choose leaves a choice that is already selected alone and refuses a name no choice has', async () => {
  const chosen = run(`return await visible.choose('选项乙');`, () => QUIZ);
  assert.deepEqual((await chosen.result).result, { changed: false, checked: true });
  assert.ok(!chosen.flows.some(([command]) => command === 'click'));
  await assert.rejects(run(`await visible.choose('提交');`, () => QUIZ).result, { code: 'ELEMENT_NOT_FOUND' });
  await assert.rejects(run(`await visible.choose('选项乙', { off: true });`, () => QUIZ).result, { code: 'INVALID_ARGS' });
});

test('a choice the page does not show as selected after the click is reported, not assumed', async () => {
  const { result } = run(`return await visible.choose('我已阅读说明');`, () => QUIZ);
  const data = await result;
  assert.deepEqual(data.result, { changed: false, checked: false });
  assert.match(data.warnings[0], /does not show it as selected/);
});

test('a page that changed is bound again before anything is sent, and an input that was sent is never repeated', async () => {
  let clicks = 0;
  const moved = run(`await visible.use(); await visible.click('提交'); return 'done';`, command => {
    if (command !== 'click') return QUIZ;
    if (++clicks === 1) throw new Error('The page navigated. Read the selected page again.');
    return { delivery: 'delivered_unverified' };
  });
  assert.equal((await moved.result).result, 'done');
  assert.deepEqual(moved.flows.map(([command]) => command), ['current', 'click', 'current', 'click']);
  assert.ok(moved.flows.every(([, options]) => options.visible === true), 'no step may be handed to the background connection');

  let sent = 0;
  const failed = run(`await visible.click('提交');`, command => {
    if (command !== 'click') return QUIZ;
    sent++;
    throw Object.assign(new Error('Control already clicked. The page navigated.'), { disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } });
  });
  await assert.rejects(failed.result, /already clicked/);
  assert.equal(sent, 1);
});

test('visible.scrollTo turns the wheel towards a text and fails when it never comes into view', async () => {
  const found = run(`human('careful'); return await visible.scrollTo('约束条件');`, command => (command === 'wheel' ? { verified: true } : QUIZ));
  assert.equal((await found.result).result, true);
  assert.deepEqual(found.flows.at(-1), ['wheel', { page: 'handle-1', until: '约束条件', visible: true, human: 'careful' }]);
  await assert.rejects(run(`await visible.scrollTo('不存在');`, command => (command === 'wheel' ? { verified: false, message: 'The named destination was not observed in this region.' } : QUIZ)).result,
    { code: 'ELEMENT_NOT_FOUND' });
});

test('human() makes desktop.click use the real mouse and desktop.type sends real keys at that pace', async () => {
  const native = { snapshot: WINDOW, click: { disposition: { delivery: 'delivered_unverified' } }, type: { disposition: { delivery: 'delivered_verified' } } };
  const plain = run(`await desktop.click('w-1', '保存');`, () => QUIZ, native);
  await plain.result;
  assert.deepEqual(plain.calls.at(-1).words, ['click', '@s1:e2']);
  const person = run(`human('natural'); await desktop.click('w-1', '保存'); return await desktop.type('w-1', '备注', '明天三点');`, () => QUIZ, native);
  assert.equal((await person.result).result, true);
  assert.deepEqual(person.calls.find(call => call.words.includes('click')).words, ['--headed', '--human', 'natural', 'click', '@s1:e2']);
  const typed = person.calls.at(-1);
  assert.deepEqual(typed.words, ['--headed', '--human', 'natural', 'type', '@s1:e1', '--stdin']);
  assert.equal(typed.input, '明天三点');
});

test('the cursor rests in the scrolled region where no smaller scrolling box lies under it', () => {
  const inner = { role: 'group', available_actions: ['Scroll'], bounds: { x: 400, y: 400, width: 200, height: 200 } };
  const doc = { role: 'document', bounds: { x: 0, y: 0, width: 1000, height: 1000 }, children: [
    { role: 'group', bounds: { x: 0, y: 0, width: 1000, height: 1000 }, children: [inner] }] };
  const fallback = { x: 1, y: 1 };
  assert.deepEqual(restingPoint({ ...doc, children: [] }, doc.bounds, fallback), { x: 500, y: 500 });
  assert.deepEqual(restingPoint(doc, doc.bounds, fallback), { x: 500, y: 350 }, 'the middle lies over a smaller scrolling box, so the next free place is used');
  const covered = { ...doc, children: [{ role: 'document', bounds: doc.bounds }] };
  assert.deepEqual(restingPoint(covered, doc.bounds, fallback), fallback);
  assert.deepEqual(panelClip(doc, [0, 0]), { x: 400, y: 400, width: 200, height: 200 });
});

test('a control further down the page is scrolled to with the wheel, then acted on once', async () => {
  let clicks = 0;
  const { result, flows } = run(`human('natural'); await visible.click('提交'); return 'clicked';`, command => {
    if (command === 'wheel') return { verified: true };
    if (command !== 'click') return QUIZ;
    if (++clicks === 1) throw Object.assign(new Error('提交 is on the page but outside the part that is on screen.'), { code: 'NOT_ON_SCREEN' });
    return { delivery: 'delivered_unverified' };
  });
  assert.equal((await result).result, 'clicked');
  assert.deepEqual(flows.map(([command]) => command), ['current', 'click', 'wheel', 'click']);
  assert.deepEqual(flows[2][1], { page: 'handle-1', until: '提交', lines: '4', visible: true, human: 'natural' });
});

test('a control that scrolling cannot bring onto the screen is reported, in both directions tried', async () => {
  const { result, flows } = run(`await visible.click('提交');`, command => {
    if (command === 'wheel') return { verified: false };
    if (command === 'click') throw Object.assign(new Error('not on screen'), { code: 'NOT_ON_SCREEN' });
    return QUIZ;
  });
  await assert.rejects(result, { code: 'ELEMENT_NOT_FOUND' });
  assert.deepEqual(flows.filter(([command]) => command === 'wheel').map(([, options]) => options.lines), ['4', '-4']);
});

test('typed text is reported by where it went in, and an append that landed elsewhere is not called verified', async () => {
  const { landing, typePage } = require('../../npm/lib/page-input');
  assert.equal(landing('abc', 'abcX', 'X'), 'end');
  assert.equal(landing('abc', 'Xabc', 'X'), 'start');
  assert.equal(landing('abc', 'aXbc', 'X'), 'middle');
  assert.equal(landing('abc', 'other', 'X'), undefined);
  await assert.rejects(typePage(() => ({}), () => ({}), { page: 'p', field: '代码', value: 'x', at: 'middle' }), /--at takes start or end/);
  await assert.rejects(typePage(() => ({}), () => ({}), { page: 'p', field: '代码', value: 'x', at: 'end', replace: true }), /--at takes start or end/);
});

test('a choice that leaves the page once it is clicked is reported as gone, not as a failed tick', async () => {
  let clicked = false;
  const { result } = run(`return await visible.choose('选项甲');`, command => {
    if (command === 'click') { clicked = true; return {}; }
    return clicked ? { ...QUIZ, controls: QUIZ.controls.filter(control => control.role === 'button') } : QUIZ;
  });
  const data = await result;
  assert.deepEqual(data.result, { changed: true, checked: null, gone: true });
  assert.equal(data.warnings, undefined);
});
