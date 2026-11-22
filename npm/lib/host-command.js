'use strict';

const { execFile } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { request, running, ensureHost } = require('./host-client');
const { jobsDir } = require('./host-paths');

const { FIX_WAIT_MS, APPROVAL_WAIT_MS } = require('./host-waits');

const usage = 'job list | job show ID | job wait ID [--timeout-ms MS] | job stop ID | job report ID | job retry ID [--target NAME] [--options JSON] | job do ID --file PATCH.js | job skip ID [--value JSON] | job approve ID | job grant (ID | --all) --for SECONDS';

async function hostCommand([action], { workflowPath, nativeBinary }) {
  if (action === 'serve') {
    const { serve } = require('./host-server');
    const started = await serve({ workflowPath, nativeBinary });
    return { serving: true, ...started, keep: true };
  }
  if (action === 'start') return ensureHost(workflowPath);
  if (action === 'status') return (await running()) ?? { running: false };
  if (action === 'stop') {
    const now = await running();
    if (!now) return { running: false };
    const stopping = await request('stop');
    const until = Date.now() + 8000;
    while (await running()) {
      if (Date.now() > until) throw Object.assign(new Error('The host did not stop within 8 s.'), { code: 'TIMEOUT' });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ...stopping, stopped: true };
  }
  throw Object.assign(new Error('host start | host stop | host status'), { code: 'INVALID_ARGS' });
}

/** Hands a script or routine to the host and answers with the job at once. */
async function detach(start, { workflowPath }) {
  await ensureHost(workflowPath);
  const job = await request('start_job', { ...start, cwd: process.cwd() });
  return { ...job, next: 'job wait ' + job.id + ' returns when it finishes or needs you; job show ' + job.id + ' shows it now.' };
}

function parseJson(text, what) {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch (err) {
    throw Object.assign(new Error(what + ' takes JSON: ' + err.message), { code: 'INVALID_ARGS' });
  }
}

/** With no host running, job list and job show read the job records on disk. */
function offline(action, id) {
  const read = name => { try { return JSON.parse(readFileSync(join(jobsDir(), name, 'job.json'), 'utf8')); } catch { return undefined; } };
  if (action === 'show') {
    const found = read(String(id));
    if (!found) throw Object.assign(new Error('No job is numbered "' + id + '".'), { code: 'JOB_NOT_FOUND' });
    return found;
  }
  let names = [];
  try { names = readdirSync(jobsDir()); } catch { /* none yet */ }
  return { jobs: names.map(read).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created))
    .map(j => ({ id: j.id, state: j.state, what: j.what, created: j.created, ...(j.ended ? { ended: j.ended } : {}) })), host: 'not running' };
}

async function job([action, id, ...rest], values, readText) {
  if (rest.length) throw Object.assign(new Error(usage), { code: 'INVALID_ARGS' });
  if (action === 'grant' && values.all) return request('grant', { all: true, seconds: Number(values.for) });
  if (action === 'list' || action === 'show') {
    try { return await request(action, { id }); } catch (err) {
      if (err.code !== 'HOST_NOT_RUNNING') throw err;
      if (action === 'list' || id) return offline(action, id);
    }
  }
  if (!id) throw Object.assign(new Error(usage), { code: 'INVALID_ARGS' });
  const fix = decision => request('fix', { id, decision, force: Boolean(values.force) });
  switch (action) {
    case 'wait': return request('wait', { id, ...(values['timeout-ms'] ? { timeout_ms: Number(values['timeout-ms']) } : {}) });
    case 'stop': return request('stop_job', { id });
    case 'report': return request('report', { id });
    case 'retry': return fix({ action: 'retry', ...(values.target !== undefined ? { target: values.target } : {}), ...(values.options ? { options: parseJson(values.options, '--options') } : {}) });
    case 'do':
      if (!values.file) throw Object.assign(new Error('job do ID --file PATCH.js'), { code: 'INVALID_ARGS' });
      return fix({ action: 'do', source: readText(values.file).replace(/^﻿/, '') });
    case 'skip': return fix({ action: 'skip', ...(values.value !== undefined ? { value: parseJson(values.value, '--value') } : {}) });
    case 'approve': return fix({ action: 'approve' });
    case 'grant': return request('grant', { id, seconds: Number(values.for) });
    default: throw Object.assign(new Error(usage), { code: 'INVALID_ARGS' });
  }
}

function errorInfo(err) {
  return { code: err?.code ?? 'ERROR', message: String(err?.message ?? err) };
}

/**
 * Runs one job in this process, which the host started. A failed step reports `waiting: fix` with the scene and
 * waits up to ten minutes for a fix; the pointer goes back to the user meanwhile. The host ending ends this process.
 */
async function runJob(start, { runner, routines, nativeBinary }) {
  process.on('disconnect', () => process.exit(1));
  const send = message => { try { process.send?.(message); } catch { /* the host is gone */ } };
  let pending;
  process.on('message', message => {
    if (message?.type === 'fix' && pending) { const resolve = pending; pending = undefined; resolve(message.decision); }
    if (message?.type === 'stop') { if (pending) { const resolve = pending; pending = undefined; resolve({ action: 'stop' }); } else process.exit(1); }
  });
  const fixes = [];
  const ask = info => new Promise(resolve => {
    const waitMs = info.approval ? APPROVAL_WAIT_MS : FIX_WAIT_MS;
    send({ type: 'waiting', reason: info.approval ? 'approval' : 'fix', info: { step: info.step, error: errorInfo(info.error), sent: info.sent, target: info.target, scene: info.scene,
      ...(info.approval ? { final: info.error.details, picture: info.error.details?.picture, need: 'the user agreeing in the chat: then job approve ' + start.id } : {}),
      until: new Date(Date.now() + waitMs).toISOString() } });
    execFile(nativeBinary, ['restore-cursor'], { windowsHide: true }, () => {});
    const timer = setTimeout(() => { pending = undefined; resolve({ action: 'stop' }); }, waitMs);
    pending = decision => { clearTimeout(timer); send({ type: 'running' }); resolve(decision); };
  });
  const fix = { ask, fixes };
  const held = { until: 0, yielded: false, cutShort: false, abort: () => {}, resume: undefined, told: false };
  const allowInput = () => Boolean(start.values?.['allow-input']) || (!held.yielded && Date.now() < held.until);
  const hands = {
    bind: ({ abort }) => { held.abort = abort; },
    using: () => { if (!held.told) { held.told = true; send({ type: 'hands_used' }); } },
    cutShort: () => held.cutShort,
    /** A step that needs the hands waits for a grant; one a person interrupted waits until they stop. */
    wait: info => new Promise(resolve => {
      const reason = held.yielded || info.reason === 'user' ? 'user' : 'hands';
      send({ type: 'waiting', reason, info: { step: info.step, at: new Date().toISOString(), error: errorInfo(info.error), ...(info.uncertain ? { uncertain: true } : {}),
        need: reason === 'hands' ? 'the real mouse and keyboard: job grant ' + start.id + ' --for SECONDS' : 'nobody touching the mouse or keyboard for 3 seconds' } });
      execFile(nativeBinary, ['restore-cursor'], { windowsHide: true }, () => {});
      held.resume = () => { held.yielded = false; held.cutShort = false; send({ type: 'running' }); resolve(info.uncertain ? 'fix' : 'retry'); };
    }),
  };
  process.on('message', message => {
    if (message?.type === 'grant') { held.until = message.until; held.resume?.(); held.resume = undefined; }
    if (message?.type === 'resume') { held.resume?.(); held.resume = undefined; }
    if (message?.type === 'yield' && !held.yielded) { held.yielded = true; held.cutShort = held.abort(); }
  });
  try {
    const done = start.routine
      ? await routines.runRoutine(start.routine, start.args, (source, extra) => runner(source, { ...extra, fix, finalsAtRunTime: true, hands, allowInput }), { fixes })
      : await runner(start.source, { args: start.args, fix, finalsAtRunTime: true, hands, allowInput });
    send({ type: 'done', data: { ...done, ...(fixes.length ? { fixes, fixes_note: 'These steps needed a fix. If this was a routine, save the fixed script with run --save NAME --replace.' } : {}) } });
  } catch (err) {
    send({ type: 'failed', error: { ...errorInfo(err), ...(err.report ?? {}), ...(fixes.length ? { fixes } : {}) } });
  }
  setTimeout(() => process.exit(0), 200);
  return { keep: true };
}

const watchUsage = 'watch add (--window TITLE [--gone] | --text TEXT --in WINDOW [--gone] [--every-ms MS] | --notification TEXT | --file PATH) [--then ROUTINE [--args JSON | --args-file FILE] [--allow-final]] | watch list | watch show ID | watch wait ID [--timeout-ms MS] | watch remove ID';

/** Watches live in the host: adding one starts the host if needed. */
async function watch([action, id, ...rest], values, { workflowPath, readText }) {
  if (rest.length) throw Object.assign(new Error(watchUsage), { code: 'INVALID_ARGS' });
  if (action === 'add') {
    await ensureHost(workflowPath);
    const args = values['args-file'] !== undefined ? parseJson(readText(values['args-file']).replace(/^\uFEFF/, ''), '--args-file') : parseJson(values.args, '--args');
    if (args !== undefined && !values.then) throw Object.assign(new Error('--args goes with --then ROUTINE.'), { code: 'INVALID_ARGS' });
    if (values['allow-final'] && !values.then) throw Object.assign(new Error('--allow-final goes with --then ROUTINE.'), { code: 'INVALID_ARGS' });
    return request('watch_add', { spec: { window: values.window, text: values.text, in: values.in, gone: values.gone, every: values['every-ms'],
      notification: values.notification, file: values.file, then: values.then, args, allowFinal: Boolean(values['allow-final']) } });
  }
  if (action === 'list') {
    try { return await request('watch_list'); } catch (err) { if (err.code === 'HOST_NOT_RUNNING') return { watches: [], host: 'not running' }; throw err; }
  }
  if (!id) throw Object.assign(new Error(watchUsage), { code: 'INVALID_ARGS' });
  if (action === 'show') return request('watch_show', { id });
  if (action === 'remove') return request('watch_remove', { id });
  if (action === 'wait') return request('watch_wait', { id, ...(values['timeout-ms'] ? { timeout_ms: Number(values['timeout-ms']) } : {}) });
  throw Object.assign(new Error(watchUsage), { code: 'INVALID_ARGS' });
}

module.exports = { hostCommand, job, detach, runJob, watch };
