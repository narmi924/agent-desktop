'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_WAIT_MS = 30000;
const MAX_REPLY_BYTES = 96 * 1024 * 1024;

/** Runs one CLI command and returns the parsed `data` of its JSON reply. */
function invoke(binary, args, { input, timeout = DEFAULT_WAIT_MS, env, children } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, env: env ?? process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    children?.add(child);
    let out = '', size = 0, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children?.delete(child);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, Object.assign(new Error('No answer within ' + timeout + ' ms.'), { code: 'TIMEOUT' }));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES) { child.kill(); return finish(reject, new Error('The reply is too large.')); }
      out += chunk;
    });
    child.stderr.resume();
    child.on('error', err => finish(reject, new Error('Cannot run ' + binary + ' (' + (err.code ?? err.message) + ')')));
    child.on('close', () => {
      let reply;
      try { reply = JSON.parse(out); } catch { return finish(reject, new Error('The command printed no JSON reply.')); }
      if (reply.ok ?? reply.success) return finish(resolve, reply.data);
      const error = new Error(String(reply.error?.message ?? reply.error ?? 'Command refused'));
      if (reply.error?.code) Object.assign(error, { code: reply.error.code, details: reply.error.details, disposition: reply.error.disposition });
      finish(reject, error);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

module.exports = { invoke };
