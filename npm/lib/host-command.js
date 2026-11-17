'use strict';

const { execFile } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { request, running, ensureHost } = require('./host-client');
const { jobsDir } = require('./host-paths');

const FIX_WAIT_MS = 10 * 60 * 1000;
const usage = 'job list | job show ID | job wait ID [--timeout-ms MS] | job stop ID | job report ID | job retry ID [--target NAME] [--options JSON] | job do ID --file PATCH.js | job skip ID [--value JSON]';

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
    return now ? request('stop') : { running: false };
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
    send({ type: 'waiting', reason: 'fix', info: { step: info.step, error: errorInfo(info.error), sent: info.sent, target: info.target, scene: info.scene,
      until: new Date(Date.now() + FIX_WAIT_MS).toISOString() } });
    execFile(nativeBinary, ['restore-cursor'], { windowsHide: true }, () => {});
    const timer = setTimeout(() => { pending = undefined; resolve({ action: 'stop' }); }, FIX_WAIT_MS);
    pending = decision => { clearTimeout(timer); send({ type: 'running' }); resolve(decision); };
  });
  const fix = { ask, fixes };
  try {
    const done = start.routine
      ? await routines.runRoutine(start.routine, start.args, (source, extra) => runner(source, { ...extra, fix }), { fixes })
      : await runner(start.source, { args: start.args, fix });
    send({ type: 'done', data: { ...done, ...(fixes.length ? { fixes, fixes_note: 'These steps needed a fix. If this was a routine, save the fixed script with run --save NAME --replace.' } : {}) } });
  } catch (err) {
    send({ type: 'failed', error: { ...errorInfo(err), ...(err.report ?? {}), ...(fixes.length ? { fixes } : {}) } });
  }
  setTimeout(() => process.exit(0), 200);
  return { keep: true };
}

module.exports = { hostCommand, job, detach, runJob };
