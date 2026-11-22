'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const home = mkdtempSync(join(tmpdir(), 'ad-schedule-'));
process.env.AGENT_DESKTOP_HOME = home;

const store = require('../../npm/lib/routine-store');
const plan = require('../../npm/lib/routine-schedule');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');

function saveRoutine(name) {
  store.save({ name, about: 'export the weekly orders', params: [{ name: 'shop', about: 'shop name' }], input: false, finals: [], status: 'candidate',
    successes: 1, failures: 0, last_success: new Date().toISOString(), updated: new Date().toISOString(), apps: [], hosts: [], steps: [], seen: {}, pinned: {} },
  'return args.shop;');
}

test('times and repeats become the Task Scheduler arguments that mean the same', () => {
  assert.deepEqual(plan.when({ at: '9:05' }), { start: '09:05', every: 'day', trigger: ['/SC', 'DAILY'] });
  assert.deepEqual(plan.when({ at: '18:30', every: 'weekdays' }).trigger, ['/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI']);
  assert.deepEqual(plan.when({ at: '07:00', every: 'Monday, wed,FRI' }), { start: '07:00', every: 'mon,wed,fri', trigger: ['/SC', 'WEEKLY', '/D', 'MON,WED,FRI'] });
  assert.deepEqual(plan.when({ at: '00:15', every: 'hour' }).trigger, ['/SC', 'HOURLY']);
  for (const bad of [{ at: '25:00' }, { at: '9' }, { at: '09:00', every: 'fortnight' }, { at: '09:00', every: 'mon,funday' }]) {
    assert.throws(() => plan.when(bad), { code: 'INVALID_ARGS' }, JSON.stringify(bad));
  }
});

test('a schedule creates one task for the signed-in user, keeps the arguments, and unscheduling removes both', () => {
  saveRoutine('weekly-orders');
  const sent = [];
  const done = plan.schedule('weekly-orders', { at: '09:00', every: 'weekdays', args: { shop: '和田大枣店' }, allowFinal: true },
    { workflowPath: 'C:\\npm\\workflow.js', schtasks: args => sent.push(args) });
  assert.equal(done.task, '\\AgentDesktop\\routine-weekly-orders');
  const create = sent[0];
  assert.deepEqual(create.slice(0, 4), ['/Create', '/F', '/TN', '\\AgentDesktop\\routine-weekly-orders']);
  const command = create[create.indexOf('/TR') + 1];
  assert.match(command, /^conhost\.exe --headless ".*node(\.exe)?" "C:\\npm\\workflow\.js" routine run-scheduled weekly-orders$/i, 'no console window flashes when it fires');
  assert.ok(create.includes('/IT'), 'it runs only while the user is signed in, where the desktop is');
  assert.equal(create[create.indexOf('/RL') + 1], 'LIMITED');
  assert.equal(create[create.indexOf('/ST') + 1], '09:00');
  const saved = JSON.parse(readFileSync(plan.schedulesPath(), 'utf8'))['weekly-orders'];
  assert.deepEqual(saved.args, { shop: '和田大枣店' });
  assert.equal(saved.allow_final, true);
  assert.throws(() => plan.schedule('no-such', { at: '09:00' }, { workflowPath: 'x', schtasks: () => {} }), { code: 'ROUTINE_NOT_FOUND' });
  plan.unschedule('weekly-orders', { schtasks: args => sent.push(args) });
  assert.deepEqual(sent.slice(1), [['/Query', '/TN', '\\AgentDesktop\\routine-weekly-orders'], ['/Delete', '/F', '/TN', '\\AgentDesktop\\routine-weekly-orders']],
    'it looks the task up first, since a missing task answers in the system language');
  assert.equal(plan.schedules()['weekly-orders'], undefined);
});

test('routine list shows when routines run but never the arguments kept for them', () => {
  saveRoutine('daily-report');
  plan.schedule('daily-report', { at: '08:00', args: { shop: '私人店铺名' } }, { workflowPath: 'x', schtasks: () => {} });
  const out = spawnSync(process.execPath, [workflow, 'routine', 'list'], { env: { ...process.env, AGENT_DESKTOP_HOME: home }, encoding: 'utf8' });
  const reply = JSON.parse(out.stdout.trim());
  assert.deepEqual(reply.data.schedules, [{ routine: 'daily-report', at: '08:00', every: 'day' }]);
  assert.ok(!out.stdout.includes('私人店铺名'));
  plan.unschedule('daily-report', { schtasks: () => {} });
});

test('removing a routine also drops its schedule, so no task fires for a routine that is gone', { skip: process.platform !== 'win32' }, () => {
  saveRoutine('gone-soon');
  plan.schedule('gone-soon', { at: '07:30' }, { workflowPath: 'x', schtasks: () => {} });
  const out = spawnSync(process.execPath, [workflow, 'routine', 'remove', 'gone-soon'], { env: { ...process.env, AGENT_DESKTOP_HOME: home }, encoding: 'utf8' });
  assert.equal(JSON.parse(out.stdout.trim()).data.unscheduled, 'gone-soon', out.stderr);
  assert.equal(plan.schedules()['gone-soon'], undefined);
});

async function fired(states, { allowFinal = false } = {}) {
  saveRoutine('fired-' + states.length + '-' + states[states.length - 1].state);
  const name = 'fired-' + states.length + '-' + states[states.length - 1].state;
  plan.schedule(name, { at: '09:00', args: { shop: 'A' }, allowFinal }, { workflowPath: 'x', schtasks: () => {} });
  const started = [], waits = [], notes = [];
  const result = await plan.runScheduled(name, {
    start: given => { started.push(given); return { id: 'j-7' }; },
    wait: id => { waits.push(id); return states.shift(); },
    notify: (title, body) => notes.push([title, body]),
  });
  plan.unschedule(name, { schtasks: () => {} });
  return { result, started, waits, notes };
}

test('a fired schedule runs the routine as a job with the kept arguments and tells the user how it ended', async () => {
  const ok = await fired([{ state: 'running' }, { state: 'waiting', reason: 'user' }, { state: 'done', result: '导出 12 条' }], { allowFinal: true });
  assert.deepEqual(ok.started, [{ args: { shop: 'A' }, allowFinal: true }]);
  assert.equal(ok.waits.length, 3, 'it keeps waiting while the job runs or yields to a person at the mouse');
  assert.equal(ok.notes[0][0], '定时动作做完了');
  assert.match(ok.notes[0][1], /导出 12 条/);

  const held = await fired([{ state: 'waiting', reason: 'approval' }]);
  assert.equal(held.result.reason, 'approval');
  assert.match(held.notes[0][1], /停在发送或提交之前/, 'nobody is in a chat, so the notification is how the user hears of it');
  assert.match(held.notes[0][1], /j-7/);

  const broken = await fired([{ state: 'failed', error: { message: 'No control is named "导出".' } }]);
  assert.equal(broken.notes[0][0], '定时动作没做成');
});
