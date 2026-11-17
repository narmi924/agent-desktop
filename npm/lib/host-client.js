'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { pipePath, tokenPath } = require('./host-paths');

const START_WAIT_MS = 8000;

function readToken() {
  try { return readFileSync(tokenPath(), 'utf8').trim(); } catch { return undefined; }
}

/** Sends one request to the host and returns its data. A host that is not running fails with code HOST_NOT_RUNNING. */
function request(op, body = {}, { token = readToken(), timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath());
    let text = '';
    let timer;
    const fail = err => { clearTimeout(timer); socket.destroy(); reject(err); };
    if (timeout) timer = setTimeout(() => fail(Object.assign(new Error('The host did not answer within ' + timeout + ' ms.'), { code: 'TIMEOUT' })), timeout);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ token, op, ...body }) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.end();
      let reply;
      try { reply = JSON.parse(text.slice(0, end)); } catch { return reject(new Error('The host sent an unreadable reply.')); }
      if (reply.ok) return resolve(reply.data);
      reject(Object.assign(new Error(reply.error?.message ?? 'The host refused the request.'), { code: reply.error?.code, details: reply.error?.details }));
    });
    socket.on('error', err => fail(['ENOENT', 'ECONNREFUSED'].includes(err.code)
      ? Object.assign(new Error('The host is not running. host start starts it; run --detach starts it on its own.'), { code: 'HOST_NOT_RUNNING' })
      : err));
    socket.on('close', () => { if (!text.includes('\n')) fail(Object.assign(new Error('The host closed the connection.'), { code: 'HOST_NOT_RUNNING' })); });
  });
}

async function running() {
  try { return await request('status', {}, { timeout: 3000 }); } catch (err) {
    if (err.code === 'HOST_NOT_RUNNING') return undefined;
    throw err;
  }
}

/** Starts the host in the background, without a window, unless one is running; returns its status. */
async function ensureHost(workflowPath) {
  const now = await running();
  if (now) return now;
  const child = spawn(process.execPath, [workflowPath, 'host', 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  const until = Date.now() + START_WAIT_MS;
  for (;;) {
    const status = await running();
    if (status) return status;
    if (Date.now() > until) throw Object.assign(new Error('The host did not start within ' + START_WAIT_MS + ' ms.'), { code: 'TIMEOUT' });
    await delay(100);
  }
}

module.exports = { request, running, ensureHost, readToken };
