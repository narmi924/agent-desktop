'use strict';

const net = require('node:net');
const { fork, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { hostDir, pipePath, tokenPath, jobsDir } = require('./host-paths');

const KEEP_JOBS = 50;
const ACTIVE = new Set(['running', 'waiting']);
const SETTLED = new Set(['done', 'failed', 'stopped', 'lost']);
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

function writeJson(path, value) {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 1));
  renameSync(temporary, path);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function newId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return 'j' + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '-' + randomBytes(2).toString('hex');
}

/** Jobs that were still running when the last host ended are marked lost, and listed once at the next start. */
function markLost() {
  const lost = [];
  let ids = [];
  try { ids = readdirSync(jobsDir()); } catch { return lost; }
  for (const id of ids) {
    const file = join(jobsDir(), id, 'job.json');
    const job = readJson(file);
    if (!job || !ACTIVE.has(job.state)) continue;
    writeJson(file, { ...job, state: 'lost', reason: undefined, waiting: undefined, ended: new Date().toISOString(), error: { code: 'HOST_ENDED', message: 'The host ended while this job ran; what it finished is in its steps.' } });
    lost.push(id);
  }
  return lost;
}

function prune() {
  let entries = [];
  try {
    entries = readdirSync(jobsDir()).map(id => ({ id, at: statSync(join(jobsDir(), id)).mtimeMs })).sort((a, b) => b.at - a.at);
  } catch { return; }
  for (const old of entries.slice(KEEP_JOBS)) {
    const job = readJson(join(jobsDir(), old.id, 'job.json'));
    if (!job || SETTLED.has(job.state)) rmSync(join(jobsDir(), old.id), { recursive: true, force: true });
  }
}

/** What `job list` shows for one job. */
function summary(job) {
  return { id: job.id, state: job.state, ...(job.reason ? { reason: job.reason } : {}), what: job.what, created: job.created, ...(job.ended ? { ended: job.ended } : {}) };
}

/**
 * The resident host: one per user, reached through a named pipe and a token in the state folder. It only records,
 * queues and relays; each job runs in a process of its own, so a script that never ends cannot hold up another job.
 */
function serve({ workflowPath, nativeBinary, idleMs = Number(process.env.AGENT_DESKTOP_HOST_IDLE_MS) || DEFAULT_IDLE_MS }) {
  mkdirSync(jobsDir(), { recursive: true });
  const token = randomBytes(24).toString('hex');
  const jobs = new Map();
  const children = new Map();
  const waiters = new Map();
  const started = new Date().toISOString();
  let lastBusy = Date.now();
  let closing = false;
  const lostOnStart = markLost();
  prune();

  const save = job => writeJson(join(jobsDir(), job.id, 'job.json'), job);
  const native = args => new Promise(resolve => execFile(nativeBinary, args, { windowsHide: true, timeout: 15000 }, (err, out) => {
    try { resolve(JSON.parse(out)); } catch { resolve(undefined); }
  }));

  function change(job, patch) {
    Object.assign(job, patch);
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete job[key];
    job.version = (job.version ?? 0) + 1;
    save(job);
    lastBusy = Date.now();
    for (const reply of waiters.get(job.id) ?? []) reply(job);
    waiters.delete(job.id);
  }

  function load(id) {
    const job = jobs.get(id) ?? readJson(join(jobsDir(), String(id), 'job.json'));
    if (!job) throw Object.assign(new Error('No job is numbered "' + id + '". job list shows them.'), { code: 'JOB_NOT_FOUND' });
    return job;
  }

  async function startJob(body) {
    if (closing) throw Object.assign(new Error('The host is stopping.'), { code: 'HOST_NOT_RUNNING' });
    const id = newId();
    const dir = join(jobsDir(), id);
    mkdirSync(dir, { recursive: true });
    const screenshots = Boolean(body.values?.['allow-input'] || body.values?.['allow-final']);
    const session = await native(['session', 'start', '--name', 'job-' + id, ...(screenshots ? ['--screenshots'] : [])]);
    const sessionId = session?.data?.session_id ?? session?.data?.id;
    writeJson(join(dir, 'start.json'), { routine: body.routine, source: body.source, args: body.args ?? {}, values: body.values ?? {} });
    const job = { id, what: body.routine ? 'routine ' + body.routine : 'script', state: 'running', created: new Date().toISOString(), ...(sessionId ? { session: sessionId } : {}), screenshots };
    jobs.set(id, job);
    change(job, {});
    const env = { ...process.env, ...(sessionId ? { AGENT_DESKTOP_SESSION: sessionId } : {}) };
    delete env.AGENT_DESKTOP_POINTER_HOLDER;
    const child = fork(workflowPath, ['job-run', dir], { cwd: body.cwd && existsSync(body.cwd) ? body.cwd : undefined, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    children.set(id, child);
    child.on('message', message => {
      if (message.type === 'waiting') change(job, { state: 'waiting', reason: message.reason, waiting: message.info });
      if (message.type === 'running') change(job, { state: 'running', reason: undefined, waiting: undefined });
      if (message.type === 'done') change(job, { state: 'done', reason: undefined, waiting: undefined, ended: new Date().toISOString(), result: message.data });
      if (message.type === 'failed') change(job, { state: job.stopping ? 'stopped' : 'failed', reason: undefined, waiting: undefined, ended: new Date().toISOString(), error: message.error, stopping: undefined });
    });
    child.on('exit', code => {
      children.delete(id);
      if (ACTIVE.has(job.state)) {
        change(job, { state: job.stopping ? 'stopped' : 'failed', reason: undefined, waiting: undefined, stopping: undefined, ended: new Date().toISOString(),
          ...(job.stopping ? {} : { error: { code: 'JOB_ENDED', message: 'The job process ended with code ' + code + ' before it reported.' } }) });
      }
    });
    return summary(job);
  }

  function fix(body) {
    const job = load(body.id);
    if (job.state !== 'waiting' || job.reason !== 'fix') throw Object.assign(new Error('Job ' + job.id + ' is ' + job.state + ', not waiting for a fix.'), { code: 'JOB_NOT_WAITING' });
    const decision = body.decision ?? {};
    if (decision.action === 'retry' && job.waiting?.sent && !body.force) {
      throw Object.assign(new Error('This step was already sent (' + (job.waiting.error?.code ?? '') + '); doing it again could send it twice. Use job skip, or job do with steps that check first.'),
        { code: 'STEP_ALREADY_SENT' });
    }
    children.get(job.id)?.send({ type: 'fix', decision });
    change(job, { state: 'running', reason: undefined, waiting: undefined });
    return summary(job);
  }

  function stop(body) {
    const job = load(body.id);
    if (!ACTIVE.has(job.state)) return summary(job);
    job.stopping = true;
    const child = children.get(job.id);
    child?.send({ type: 'stop' });
    setTimeout(() => { if (children.has(job.id)) child.kill(); }, 3000).unref();
    if (!child) change(job, { state: 'stopped', reason: undefined, waiting: undefined, ended: new Date().toISOString() });
    return { ...summary(job), state: job.state === 'stopped' ? 'stopped' : 'stopping', reason: undefined };
  }

  function wait(body, reply) {
    const job = load(body.id);
    if (!ACTIVE.has(job.state) || job.state === 'waiting' || (body.version !== undefined && job.version !== body.version)) return reply(job);
    const list = waiters.get(job.id) ?? [];
    list.push(reply);
    waiters.set(job.id, list);
    if (body.timeout_ms) setTimeout(() => {
      const left = (waiters.get(job.id) ?? []).filter(r => r !== reply);
      if (left.length) waiters.set(job.id, left); else waiters.delete(job.id);
      reply(job);
    }, Number(body.timeout_ms)).unref();
  }

  async function report(body) {
    const job = load(body.id);
    if (!job.session) throw Object.assign(new Error('Job ' + job.id + ' has no recorded session.'), { code: 'NO_RECORD' });
    const out = join(jobsDir(), job.id, 'report.html');
    const exported = await native(['trace', 'export', '--session', job.session, '--out', out, '--limit', '0']);
    if (!exported?.ok) throw Object.assign(new Error('The record could not be exported: ' + (exported?.error?.message ?? 'no reply')), { code: 'NO_RECORD' });
    return { id: job.id, report: out, screenshots: job.screenshots };
  }

  function status() {
    const list = [...jobs.values()];
    return { pid: process.pid, started, pipe: pipePath(), jobs: list.filter(j => ACTIVE.has(j.state)).map(summary), lost_on_start: lostOnStart };
  }

  function listJobs() {
    let ids = [];
    try { ids = readdirSync(jobsDir()); } catch { /* none yet */ }
    return { jobs: ids.map(id => jobs.get(id) ?? readJson(join(jobsDir(), id, 'job.json'))).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created)).map(summary) };
  }

  async function shutdown(why) {
    if (closing) return;
    closing = true;
    for (const [id, child] of children) {
      const job = jobs.get(id);
      child.send({ type: 'stop' });
      child.kill();
      if (job && ACTIVE.has(job.state)) change(job, { state: 'lost', reason: undefined, waiting: undefined, ended: new Date().toISOString(), error: { code: 'HOST_ENDED', message: 'The host stopped (' + why + ') while this job ran.' } });
    }
    await native(['restore-cursor']);
    rmSync(tokenPath(), { force: true });
    server.close();
    setTimeout(() => process.exit(0), 200).unref();
  }

  const ops = {
    status: () => status(),
    stop: () => { setImmediate(() => shutdown('host stop')); return { stopping: true, pid: process.pid }; },
    start_job: body => startJob(body),
    list: () => listJobs(),
    show: body => load(body.id),
    fix: body => fix(body),
    stop_job: body => stop(body),
    report: body => report(body),
  };

  const server = net.createServer(socket => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      const send = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
      let body;
      try { body = JSON.parse(line); } catch { return send({ ok: false, error: { code: 'INVALID_ARGS', message: 'Unreadable request.' } }); }
      if (body.token !== token) return send({ ok: false, error: { code: 'TOKEN_REFUSED', message: 'Wrong or missing host token.' } });
      lastBusy = Date.now();
      try {
        if (body.op === 'wait') return wait(body, job => send({ ok: true, data: job }));
        const handler = ops[body.op];
        if (!handler) throw Object.assign(new Error('Unknown host request "' + body.op + '".'), { code: 'INVALID_ARGS' });
        send({ ok: true, data: await handler(body) });
      } catch (err) {
        send({ ok: false, error: { code: err.code ?? 'INTERNAL', message: err.message, ...(err.details ? { details: err.details } : {}) } });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE'
      ? Object.assign(new Error('A host is already running for this user.'), { code: 'HOST_RUNNING' }) : err));
    server.listen(pipePath(), () => {
      writeJson(tokenPath(), token);
      writeFileSync(tokenPath(), token);
      const idle = setInterval(() => {
        const busy = [...jobs.values()].some(j => ACTIVE.has(j.state));
        if (!busy && Date.now() - lastBusy >= idleMs) { clearInterval(idle); shutdown('idle'); }
      }, Math.min(30000, Math.max(200, idleMs / 4)));
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => shutdown(signal));
      resolve({ pid: process.pid, pipe: pipePath(), lost_on_start: lostOnStart });
    });
  });
}

module.exports = { serve, hostDir };
