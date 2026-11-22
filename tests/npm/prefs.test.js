'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const home = mkdtempSync(join(tmpdir(), 'ad-prefs-'));
process.env.AGENT_DESKTOP_HOME = home;
delete process.env.AGENT_DESKTOP_POINTER;

const prefs = require('../../npm/lib/prefs');
const { runScript } = require('../../npm/lib/script-run');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');
const WINDOW = { complete: true, tree: { role: 'window', name: '登记', children: [{ role: 'button', name: '保存', ref_id: '@s1:e2' }] } };

function saved(data) {
  return { everywhere: {}, projects: {}, routines: {}, ...data };
}

function cli(args, { cwd, homeDir = home, input } = {}) {
  const env = { ...process.env, AGENT_DESKTOP_HOME: homeDir };
  delete env.AGENT_DESKTOP_POINTER;
  const out = spawnSync(process.execPath, [workflow, ...args], { cwd, env, input, encoding: 'utf8' });
  const text = out.stdout.trim() || out.stderr.trim();
  return JSON.parse(text.split('\n').at(-1));
}

test('with nothing saved the work stays in the background and nothing takes the mouse', () => {
  const settings = prefs.resolveSettings({ cwd: 'E:/work', env: {}, data: saved({}) });
  assert.deepEqual(settings.mode, { value: 'background', from: 'built-in' });
  assert.deepEqual(settings.browser, { value: 'clean', from: 'built-in' });
  const options = prefs.runnerOptions(settings, {});
  assert.equal(options['allow-input'], undefined);
  assert.equal(options.pace, undefined);
  assert.equal(options.pointer, undefined);
});

test('the most specific layer wins: this run, then the routine, then the deepest project folder, then everywhere', () => {
  const data = saved({
    everywhere: { mode: 'direct', pointer: 'red' },
    projects: { 'E:/Projects': { mode: 'watch' }, 'E:/Projects/demo': { mode: 'record', browser: 'space' } },
    routines: { weekly: { mode: 'background' } },
  });
  const at = (cwd, extra = {}) => prefs.resolveSettings({ cwd, env: {}, data, ...extra });
  assert.deepEqual(at('D:/elsewhere').mode, { value: 'direct', from: 'everywhere' });
  assert.deepEqual(at('E:/Projects/other').mode, { value: 'watch', from: 'project' });
  assert.deepEqual(at('e:\\projects\\DEMO\\src').mode, { value: 'record', from: 'project' }, 'a Windows folder matches without case and below the saved folder');
  assert.equal(at('E:/Projects/demo/src').project, 'E:/Projects/demo');
  assert.deepEqual(at('E:/ProjectsOld').mode, { value: 'direct', from: 'everywhere' }, 'a folder that only starts with the same letters is not inside it');
  assert.deepEqual(at('E:/Projects/demo', { routine: 'weekly' }).mode, { value: 'background', from: 'routine' });
  assert.deepEqual(at('E:/Projects/demo', { routine: 'weekly', request: { mode: '看着做' } }).mode, { value: 'watch', from: 'request' });
  assert.deepEqual(at('E:/Projects/demo').pointer, { value: 'red', from: 'everywhere' });
  assert.deepEqual(prefs.resolveSettings({ cwd: 'E:/Projects/demo', env: { AGENT_DESKTOP_POINTER: 'green' }, data }).pointer, { value: 'green', from: 'request' },
    'a pointer the environment sets is said for this run');
});

test('each way turns into the runner options it stands for, and the caller\'s own flags stay', () => {
  const settingsFor = (mode, browser = 'background') => prefs.resolveSettings({ cwd: 'E:/x', env: {}, request: { mode }, data: saved({ everywhere: { browser } }) });
  const record = prefs.runnerOptions(settingsFor('录屏'), {});
  assert.equal(record['allow-input'], true);
  assert.equal(record.pace, 'natural');
  assert.equal(record.pointer, 'off', 'a recording keeps the user\'s own pointer');
  const watch = prefs.runnerOptions(settingsFor('watch'), {});
  assert.equal(watch.pace, 'natural');
  assert.equal(watch.pointer, 'amber');
  const direct = prefs.runnerOptions(settingsFor('direct'), {});
  assert.equal(direct['allow-input'], true);
  assert.equal(direct.pace, undefined);
  assert.equal(record.screen, true, 'a recording shows web steps on screen');
  assert.equal(watch.screen, true, 'watching shows web steps on screen');
  assert.equal(direct.screen, undefined, 'direct keeps web steps in the faster background browser');
  assert.equal(prefs.runnerOptions(settingsFor('background', 'chrome'), {}).chrome, true,
    'background is how the work is done, not which browser: the user\'s own Chrome works in the background way');
  assert.equal(prefs.runnerOptions(settingsFor('background', '我的浏览器'), {}).chrome, true);
  const clean = prefs.runnerOptions(settingsFor('background', '无痕'), {});
  assert.equal(clean.chrome, undefined);
  assert.equal(clean.space, undefined);
  assert.deepEqual(settingsFor('background', 'background').browser, { value: 'clean', from: 'everywhere' }, 'the old name still reads as the clean browser');
  assert.equal(prefs.runnerOptions(settingsFor('background', 'space'), {}).space, true);
  const own = prefs.runnerOptions(settingsFor('background', 'chrome'), { session: 'work' });
  assert.equal(own.chrome, undefined, 'a session the caller named wins over the saved browser');
  assert.equal(own.session, 'work');
});

test('prefs set and unset write the scope they name and refuse a missing or doubled scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-project-'));
  const set = prefs.prefsCommand(['set', 'mode=录屏', 'browser=space'], { project: true }, dir);
  assert.deepEqual(set.set, { mode: 'record', browser: 'space' });
  assert.deepEqual(set.now.mode, { value: 'record', from: 'project' });
  prefs.prefsCommand(['set', 'pointer=off'], { always: true }, dir);
  prefs.prefsCommand(['set', 'mode=watch'], { routine: 'weekly' }, dir);
  const data = JSON.parse(readFileSync(prefs.prefsPath(), 'utf8'));
  assert.equal(data.everywhere.pointer, 'off');
  assert.equal(data.routines.weekly.mode, 'watch');
  assert.equal(Object.values(data.projects)[0].mode, 'record');
  assert.throws(() => prefs.prefsCommand(['set', 'mode=record'], {}, dir), { code: 'INVALID_ARGS' });
  assert.throws(() => prefs.prefsCommand(['set', 'mode=record'], { project: true, always: true }, dir), { code: 'INVALID_ARGS' });
  assert.throws(() => prefs.prefsCommand(['set', 'mode=fast'], { always: true }, dir), { code: 'INVALID_ARGS' });
  assert.throws(() => prefs.prefsCommand(['set', 'colour=red'], { always: true }, dir), { code: 'INVALID_ARGS' });
  prefs.prefsCommand(['unset', 'mode', 'browser'], { project: true }, dir);
  assert.deepEqual(JSON.parse(readFileSync(prefs.prefsPath(), 'utf8')).projects, {}, 'a project with nothing left is dropped');
  assert.deepEqual(prefs.prefsCommand([], {}, dir).mode, { value: 'background', from: 'built-in' });
});

test('a start pace makes desktop steps move like a person without the script calling human()', async () => {
  const calls = [];
  const call = async (binary, args) => {
    calls.push(args);
    if (args.includes('snapshot')) return WINDOW;
    if (args.includes('list-windows')) return [];
    return { disposition: { delivery: 'delivered_unverified' } };
  };
  await runScript(`await desktop.click('w-1', '保存');`, { native: 'desktop', call, allowInput: true, startPace: 'natural' });
  assert.deepEqual(calls.find(args => args.includes('click')), ['--headed', '--human', 'natural', 'click', '@s1:e2']);
});

test('the first script on a computer carries the note on ways of working once, and the reply says which way it worked', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'ad-first-'));
  const first = cli(['run'], { homeDir: fresh, input: 'return 1;' });
  assert.equal(first.ok, true);
  assert.match(first.data.welcome, /background/);
  assert.deepEqual(first.data.mode, { name: 'background', from: 'built-in' });
  assert.ok(existsSync(join(fresh, 'preferences.json')));
  const second = cli(['run'], { homeDir: fresh, input: 'return 2;' });
  assert.equal(second.data.welcome, undefined);
});

test('a project set to record runs its scripts on screen with the user\'s pointer, from that folder only', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'ad-record-'));
  const project = join(fresh, 'demo');
  mkdirSync(project);
  writeFileSync(join(fresh, 'preferences.json'), JSON.stringify(saved({})));
  assert.equal(cli(['prefs', 'set', 'mode=record', '--project'], { cwd: project, homeDir: fresh }).ok, true);
  const inside = cli(['run'], { cwd: project, homeDir: fresh, input: 'human(false); return 1;' });
  assert.deepEqual(inside.data.mode, { name: 'record', from: 'project' });
  const outside = cli(['run'], { cwd: fresh, homeDir: fresh, input: `human('natural'); return 1;` });
  assert.equal(outside.ok, false, 'outside the project the mouse still needs the user\'s word');
  assert.equal(outside.code, 'INPUT_NOT_ALLOWED');
  const asked = cli(['run', '--mode', 'watch'], { cwd: fresh, homeDir: fresh, input: `human('natural'); return 1;` });
  assert.deepEqual(asked.data.mode, { name: 'watch', from: 'request' });
});
