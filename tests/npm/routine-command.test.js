'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-routine-'));

const { runScript } = require('../../npm/lib/script-run');
const routines = require('../../npm/lib/routine-command');
const store = require('../../npm/lib/routine-store');

const FORM = { complete: true, tree: { role: 'window', name: '客户登记', children: [
  { role: 'textfield', name: '客户姓名', ref_id: '@s1:e1' }, { role: 'button', name: '保存', ref_id: '@s1:e2' }] } };
const MAIN = { id: 'w-1', app_name: 'register.exe', title: '客户登记' };

/**
 * A stand-in desktop: the window list changes when 保存 is clicked, the way the app under test behaves.
 * `opens` is the window the click opens, or null when it opens none.
 */
function desk({ opens = { id: 'w-9', app_name: 'register.exe', title: '已保存' } } = {}) {
  let open = [MAIN];
  const calls = [];
  const call = async (binary, args, options = {}) => {
    calls.push({ words: args, input: options.input });
    if (args[0] === 'list-windows') return open;
    if (args[0] === 'snapshot') return FORM;
    if (args[0] === 'set-value') return { disposition: { delivery: 'delivered_verified' } };
    if (args[0] === 'click') { if (opens) open = [MAIN, opens]; return {}; }
    throw new Error('unexpected ' + args.join(' '));
  };
  const run = (source, extra) => runScript(source, { native: 'desktop', call, allowFinal: true, ...extra });
  return { calls, run };
}

const SCRIPT = `await desktop.fill('客户登记', '客户姓名', args.name);
await desktop.click('客户登记', '保存');
expect(true);`;

async function saveOne(name, options = {}) {
  const args = { name: 'Mehmet 买买提' };
  const done = await desk(options).run(SCRIPT, { args, watch: true });
  return routines.save({ name, about: '登记一位客户', params: ['name=客户姓名'], source: SCRIPT, args, done, replace: options.replace });
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('a script reads its arguments as args.name and a missing one is refused before any step runs', async () => {
  const tools = desk();
  const err = await tools.run(`await desktop.fill('客户登记', '客户姓名', args.name);\nawait desktop.fill('客户登记', '客户姓名', args.title);`, { args: { name: 'x' } }).catch(e => e);
  assert.equal(err.code, 'MISSING_ARGS');
  assert.deepEqual(err.details.needs, ['title']);
  assert.equal(tools.calls.length, 0, 'nothing ran');
  const done = await tools.run(`await desktop.fill('客户登记', '客户姓名', args.name); return args.name;`, { args: { name: '古丽 Gul' } });
  assert.equal(done.result, '古丽 Gul');
  assert.equal(tools.calls.find(c => c.words[0] === 'set-value').input, '古丽 Gul');
  assert.throws(() => routines.readArgs({ args: '[1]' }), { code: 'INVALID_ARGS' });
  assert.throws(() => routines.readArgs({ args: '{"a b": 1}' }), { code: 'INVALID_ARGS' });
});

test('a saved routine keeps the script, the parameter names and each step, and never an argument value', async () => {
  const saved = await saveOne('register-customer');
  assert.equal(saved.status, 'candidate');
  assert.deepEqual(saved.params, [{ name: 'name', about: '客户姓名' }]);
  const routine = store.load('register-customer');
  assert.equal(routine.script, SCRIPT);
  assert.deepEqual(routine.apps, ['register.exe']);
  assert.deepEqual(routine.steps.map(s => s.label), ['desktop.fill 客户姓名', 'desktop.click 保存']);
  assert.deepEqual(routine.steps[1].effects, [{ kind: 'window_opened', app: 'register.exe', title: '已保存' }]);
  for (const file of filesUnder(store.routinesDir())) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('Mehmet') && !text.includes('买买提'), file + ' holds an argument value');
  }
});

test('an argument value inside a label or a window title is stored as {name}', async () => {
  const { templateSteps } = require('../../npm/lib/routine-effects');
  const steps = templateSteps([{ label: 'web.open https://x.test/u/gulnar', effects: [{ kind: 'window_title', app: 'a.exe', title: 'gulnar - 记事本' }], ok: true, ms: 3 },
    { label: 'web.fill 数量 2', effects: [], ok: true, ms: 1 }], { user: 'gulnar', count: 2 });
  assert.equal(steps[0].label, 'web.open https://x.test/u/{user}');
  assert.equal(steps[0].effects[0].title, '{user} - 记事本');
  assert.equal(steps[1].label, 'web.fill 数量 {count}', 'a one-character value is replaced only as a whole word');
});

test('saving over a routine needs replace, keeps the old one as a version and starts counting again', async () => {
  await saveOne('replace-me');
  await assert.rejects(saveOne('replace-me'), { code: 'ROUTINE_EXISTS' });
  const again = await saveOne('replace-me', { replace: true });
  assert.equal(again.version, 2);
  assert.ok(readdirSync(join(store.routinesDir(), 'replace-me', 'versions')).includes('1'));
  assert.equal(store.load('replace-me').successes, 1);
});

test('a script whose last action is not followed by a check of its result is saved with a warning', async () => {
  const args = { name: 'a' };
  const source = `await desktop.fill('客户登记', '客户姓名', args.name);\nawait desktop.click('客户登记', '保存');`;
  const done = await desk().run(source, { args });
  const saved = routines.save({ name: 'no-check', source, args, done, params: [] });
  assert.match(saved.warnings[0], /not followed by a check of its result/);
  const checked = routines.save({ name: 'with-check', source: source + "\nawait desktop.waitText('客户登记', '已保存');", args, done, params: [] });
  assert.equal(checked.warnings, undefined);
});

test('a routine run stops with EFFECT_MISMATCH when the window it opened before does not open', async () => {
  await saveOne('missing-window');
  const tools = desk({ opens: null });
  const err = await routines.runRoutine('missing-window', { name: 'B' }, (source, extra) => tools.run(source, extra)).catch(e => e);
  assert.equal(err.code, 'EFFECT_MISMATCH');
  assert.equal(err.details.step, 2);
  assert.deepEqual(err.details.expected, [{ kind: 'window_opened', app: 'register.exe', title: '已保存' }]);
  assert.deepEqual(err.details.found, []);
  assert.equal(err.report.routine, 'missing-window');
  assert.equal(store.load('missing-window').failures, 1);
});

test('a routine run stops when a window it never saw opens, and passes when the same window opens', async () => {
  await saveOne('unseen-window');
  const surprise = desk({ opens: { id: 'w-8', app_name: 'updater.exe', title: '有新版本' } });
  const err = await routines.runRoutine('unseen-window', { name: 'B' }, (source, extra) => surprise.run(source, extra)).catch(e => e);
  assert.equal(err.code, 'EFFECT_MISMATCH');
  assert.ok(err.message.includes('expected window opened (register.exe "已保存"); found window opened (updater.exe "有新版本")'), err.message);
  const retitled = desk({ opens: { id: 'w-8', app_name: 'register.exe', title: '保存成功' } });
  await routines.runRoutine('unseen-window', { name: 'B' }, (source, extra) => retitled.run(source, extra));
  const same = desk();
  const done = await routines.runRoutine('unseen-window', { name: 'C' }, (source, extra) => same.run(source, extra));
  assert.equal(done.routine, 'unseen-window');
  assert.equal(done.successes, 3, 'before titles are pinned, the same kind of window from the same app passes');
});

test('window titles join the comparison only after two runs in a row showed the same one', async () => {
  const { effectChecker, learn, firstSeen } = require('../../npm/lib/routine-effects');
  const step = { label: 'desktop.click 保存', effects: [{ kind: 'window_opened', app: 'a.exe', title: '已保存' }] };
  let routine = { steps: [step], seen: firstSeen([step]), pinned: {}, successes: 1 };
  const found = title => ({ label: 'desktop.click 保存', effects: [{ kind: 'window_opened', app: 'a.exe', title }] });
  const loose = effectChecker(routine, {});
  loose.check(found('另存为'));
  routine = learn(routine, [{ index: 0, effects: [{ kind: 'window_opened', app: 'a.exe', title: '已保存' }] }]);
  assert.deepEqual(routine.pinned[0], { 'window_opened|a.exe': '已保存' });
  assert.throws(() => effectChecker(routine, {}).check(found('另存为')), { code: 'EFFECT_MISMATCH' });
  effectChecker(routine, {}).check(found('已保存'));
  assert.equal(routine.status, 'candidate');
  assert.equal(learn(routine, []).status, 'proven');
});

test('a routine that needs arguments says which, with their descriptions, before it runs', async () => {
  await saveOne('needs-args');
  let ran = false;
  const err = await routines.runRoutine('needs-args', {}, async () => { ran = true; }).catch(e => e);
  assert.equal(err.code, 'MISSING_ARGS');
  assert.match(err.message, /name \(客户姓名\)/);
  assert.equal(ran, false);
  await assert.rejects(routines.runRoutine('never-saved', {}, async () => {}), { code: 'ROUTINE_NOT_FOUND' });
});

test('list, show and remove read the saved routines; a run that touched their app names them', async () => {
  await saveOne('listed');
  const row = routines.list('客户').routines.find(r => r.startsWith('listed'));
  assert.match(row, /^listed \(name\): 登记一位客户 \[candidate, 1 ok\]$/);
  assert.equal(routines.list('no such thing').routines.length, 0);
  assert.deepEqual(routines.show('listed').steps, ['desktop.fill 客户姓名', 'desktop.click 保存 -> window_opened register.exe']);
  assert.ok(routines.knownRoutines({ apps: ['register.exe'], hosts: [], records: [] }).some(r => r.startsWith('listed')));
  assert.ok(routines.knownRoutines({ apps: ['other.exe'], hosts: [], records: [] }).length === 0);
  assert.ok(routines.knownRoutines({ apps: ['register.exe'], hosts: [] }).length <= 5);
  routines.remove('listed');
  assert.throws(() => store.load('listed'), { code: 'ROUTINE_NOT_FOUND' });
});

test('the routine index answers in under 50 ms with two hundred routines', async () => {
  const done = await desk().run(SCRIPT, { args: { name: 'x' } });
  for (let i = 0; i < 200; i++) routines.save({ name: 'bulk-' + i, about: 'bulk', source: SCRIPT, args: { name: 'x' }, done, params: [] });
  const started = process.hrtime.bigint();
  routines.list();
  routines.knownRoutines({ apps: ['register.exe'], hosts: [] });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, 'took ' + ms + ' ms');
});
