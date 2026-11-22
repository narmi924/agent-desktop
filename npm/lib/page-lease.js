'use strict';

const net = require('node:net');
const { createHash } = require('node:crypto');
const { rmSync } = require('node:fs');
const { tmpdir, userInfo } = require('node:os');
const { join } = require('node:path');

/** How long a browser a run opened for itself stays after its last command, so a next script can go on from its page. */
const OWN_IDLE = '10m';
const ASK_HOLDER_MS = 1500;

let opened = 0;

/** The pipe that marks a browser session as driven by one run. The system frees it when that process ends, crash or not. */
function leasePath(session, env = process.env) {
  const key = createHash('sha256').update(userInfo().username + '\0' + (env.AGENT_BROWSER_NAMESPACE ?? '') + '\0' + session).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? '\\\\.\\pipe\\slipwing-page-' + key : join(tmpdir(), 'slipwing-page-' + key + '.sock');
}

/** Holds the pipe and answers with its server, or with undefined when another live run holds it. */
function holdPipe(path) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end(String(process.pid)));
    server.once('error', err => {
      if (process.platform === 'win32') return ['EADDRINUSE', 'EACCES'].includes(err.code) ? resolve(undefined) : reject(err);
      if (err.code !== 'EADDRINUSE') return reject(err);
      const probe = net.connect(path);
      probe.once('connect', () => { probe.destroy(); resolve(undefined); });
      probe.once('error', () => { rmSync(path, { force: true }); holdPipe(path).then(resolve, reject); });
    });
    server.listen(path, () => { server.unref(); resolve(server); });
  });
}

/** The process id the holder of a pipe answers with, or undefined. */
function holderOf(path) {
  return new Promise(resolve => {
    const socket = net.connect(path);
    let text = '';
    const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(undefined), ASK_HOLDER_MS);
    socket.setEncoding('utf8');
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => done(Number(text) || undefined));
    socket.on('error', () => done(undefined));
  });
}

function busy(session, pid) {
  return Object.assign(new Error('Another run' + (pid ? ' (process ' + pid + ')' : '') + ' is working in this browser (' + session + '). ' +
    'Two runs never share a page: wait until that run ends (job wait ID for a job), or run this one in the clean browser.'), { code: 'BROWSER_BUSY' });
}

/**
 * One run drives a browser session at a time. The run takes its session at its first web step and keeps it until
 * it ends. When another live run holds the shared clean browser, this run opens a browser of its own instead and
 * says so in `browser_session`; it stays for OWN_IDLE after its last command, so a next script can continue on its page
 * with `run --session NAME`. A profile or a connection to the user's Chrome cannot be opened twice, so any other
 * session that another run holds is refused with BROWSER_BUSY.
 */
function pageLease(flags, { own = false, close, hold = holdPipe, holder = holderOf } = {}) {
  const at = flags.indexOf('--session');
  const session = at >= 0 ? flags[at + 1] : 'default';
  let taken, ownName, server;
  const take = async () => {
    server = await hold(leasePath(session));
    if (server) return flags;
    if (!own) throw busy(session, await holder(leasePath(session)));
    ownName = session + '-' + process.pid + '-' + (opened++);
    return ['--session', ownName, '--idle-timeout', OWN_IDLE];
  };
  return {
    flags: () => (taken ??= take()),
    own: () => ownName,
    async release() {
      await taken?.catch(() => undefined);
      server?.close();
      server = undefined;
      if (ownName && close) {
        try { await close(ownName); } catch { /* It closes itself after OWN_IDLE. */ }
      }
    },
  };
}

module.exports = { pageLease, leasePath, holdPipe, OWN_IDLE };
