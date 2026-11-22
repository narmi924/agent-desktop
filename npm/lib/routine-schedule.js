'use strict';

const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const store = require('./routine-store');
const { showNotification } = require('./notify');

const TASK_FOLDER = 'AgentDesktop';
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const WAIT_SLICE_MS = 10 * 60 * 1000;
const WAIT_LIMIT_MS = 6 * 60 * 60 * 1000;

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGS' });
const schedulesPath = () => join(store.routinesDir(), 'schedules.json');
const taskName = name => '\\' + TASK_FOLDER + '\\routine-' + name;

function schedules() {
  try { return JSON.parse(readFileSync(schedulesPath(), 'utf8')); } catch { return {}; }
}

function writeSchedules(all) {
  mkdirSync(store.routinesDir(), { recursive: true });
  const temporary = schedulesPath() + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(all, null, 2));
  renameSync(temporary, schedulesPath());
}

/** `--at 09:00` and `--every day|weekdays|hour|mon,wed,fri` as the Task Scheduler arguments that mean the same. */
function when({ at, every = 'day' }) {
  const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at ?? ''));
  if (!time) throw invalid('--at takes a time of day as HH:MM, for example --at 09:00.');
  const start = time[1].padStart(2, '0') + ':' + time[2];
  const value = String(every).trim().toLowerCase();
  if (value === 'day') return { start, every: 'day', trigger: ['/SC', 'DAILY'] };
  if (value === 'hour') return { start, every: 'hour', trigger: ['/SC', 'HOURLY'] };
  if (value === 'weekdays') return { start, every: 'weekdays', trigger: ['/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI'] };
  const days = value.split(',').map(day => day.trim().slice(0, 3).toUpperCase());
  if (!days.length || days.some(day => !DAYS.includes(day))) throw invalid('--every takes day, weekdays, hour, or days such as mon,wed,fri.');
  return { start, every: days.join(',').toLowerCase(), trigger: ['/SC', 'WEEKLY', '/D', days.join(',')] };
}

/**
 * The command the task runs: the same workflow, through conhost --headless, so no console window flashes on the
 * user's screen when it fires.
 */
function taskCommand(name, workflowPath) {
  const quote = text => '"' + text + '"';
  return ['conhost.exe', '--headless', quote(process.execPath), quote(workflowPath), 'routine', 'run-scheduled', name].join(' ');
}

/**
 * Runs a saved routine at set times through the Windows Task Scheduler, under the user's own account and only while
 * they are signed in, since the desktop exists only then. The arguments are kept beside the routines, because the
 * run has nobody to ask; a saved routine itself still keeps none.
 */
function schedule(name, { at, every, args, allowFinal = false }, { workflowPath, schtasks = runSchtasks }) {
  store.checkName(name);
  if (!store.exists(name)) throw Object.assign(new Error('No routine is named "' + name + '". routine list shows them.'), { code: 'ROUTINE_NOT_FOUND' });
  const plan = when({ at, every });
  const command = taskCommand(name, workflowPath);
  if (command.length > 261) throw invalid('The command for the task is longer than Task Scheduler allows (' + command.length + ' characters); install agent-desktop under a shorter path.');
  schtasks(['/Create', '/F', '/TN', taskName(name), '/TR', command, ...plan.trigger, '/ST', plan.start, '/RL', 'LIMITED', '/IT']);
  const all = schedules();
  all[name] = { at: plan.start, every: plan.every, ...(args && Object.keys(args).length ? { args } : {}), ...(allowFinal ? { allow_final: true } : {}),
    task: taskName(name), set: new Date().toISOString() };
  writeSchedules(all);
  return { scheduled: name, at: plan.start, every: plan.every, task: taskName(name), ...(allowFinal ? { allow_final: true } : {}),
    note: 'Runs while you are signed in. A run that stops before a send, submit, pay or delete step without allow_final, needs the mouse and keyboard, fails or finishes shows a notification.' };
}

function unschedule(name, { schtasks = runSchtasks } = {}) {
  const all = schedules();
  if (!all[name]) throw Object.assign(new Error('"' + name + '" has no schedule.'), { code: 'ROUTINE_NOT_FOUND' });
  const task = all[name].task ?? taskName(name);
  let present = true;
  try { schtasks(['/Query', '/TN', task]); } catch { present = false; }
  if (present) schtasks(['/Delete', '/F', '/TN', task]);
  delete all[name];
  writeSchedules(all);
  return { unscheduled: name };
}

function runSchtasks(args) {
  const out = spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw Object.assign(new Error('schtasks ' + args[0] + ' failed: ' + (out.stderr || out.stdout || '').trim()), { code: 'ACTION_FAILED' });
  return out.stdout;
}

/**
 * What a scheduled task runs: the routine as a detached job with the stored arguments, then a wait in slices until the
 * job ends or needs someone, and one notification saying which. Nobody is in a chat when it fires, so anything that
 * needs a person is told through the notification and left waiting in the job, where an agent can pick it up.
 */
async function runScheduled(name, { start, wait, notify = showNotification }) {
  const record = schedules()[name];
  if (!record) throw Object.assign(new Error('"' + name + '" has no schedule.'), { code: 'ROUTINE_NOT_FOUND' });
  const job = await start({ args: record.args ?? {}, allowFinal: Boolean(record.allow_final) });
  const until = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const now = await wait(job.id, WAIT_SLICE_MS);
    const state = now?.state;
    if (state === 'done') { notify('定时动作做完了', '“' + name + '”已完成。' + brief(now.result)); return { job: job.id, state }; }
    if (['failed', 'stopped', 'lost'].includes(state)) { notify('定时动作没做成', '“' + name + '”' + (now.error?.message ? '：' + brief(now.error.message) : '没有完成。')); return { job: job.id, state }; }
    if (state === 'waiting' && now.reason !== 'user') {
      const why = now.reason === 'approval' ? '停在发送或提交之前，等你确认。' : now.reason === 'hands' ? '下一步要用键盘鼠标，等你同意。' : '有一步出错，等人处理。';
      notify('定时动作在等你', '“' + name + '”' + why + '回到和 agent 的对话里说一声，任务号 ' + job.id + '。');
      return { job: job.id, state, reason: now.reason };
    }
    if (Date.now() >= until) { notify('定时动作还没做完', '“' + name + '”跑了很久还没结束，任务号 ' + job.id + '。'); return { job: job.id, state }; }
  }
}

function brief(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

module.exports = { schedule, unschedule, runScheduled, schedules, when, taskCommand, taskName, schedulesPath };
