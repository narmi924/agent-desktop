'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { pageLease } = require('../../npm/lib/page-lease');
const { runScript } = require('../../npm/lib/script-run');

let sessions = 0;
const fresh = () => 'slipwing-lease-test-' + process.pid + '-' + (++sessions);

/** A stand-in for agent-browser that keeps one page per session, as the real daemon does. */
function browserPerSession() {
  const pages = new Map();
  const used = [];
  const call = async (binary, args) => {
    const session = args[args.indexOf('--session') + 1];
    const words = args.slice(args.indexOf('--json') + 1);
    used.push(session);
    if (words[0] === 'open') { pages.set(session, words[1]); return { url: words[1], title: '' }; }
    if (words[0] === 'get' && words[1] === 'url') return { url: pages.get(session) ?? 'about:blank' };
    throw new Error('unexpected command: ' + words.join(' '));
  };
  return { call, used };
}

test('two runs at once never drive one page: the second gets a browser of its own and says so', async () => {
  const shared = fresh();
  const browser = browserPerSession();
  const run = source => runScript(source, { browser: 'browser', native: 'desktop', call: browser.call, lease: pageLease(['--session', shared], { own: true }) });
  const first = run(`await web.open('http://site/orders'); const before = await web.url(); await sleep(400); return { before, after: await web.url() };`);
  await delay(100);
  const second = await run(`await web.open('http://site/register'); return await web.url();`);
  const done = await first;
  assert.deepEqual(done.result, { before: 'http://site/orders', after: 'http://site/orders' }, 'the first run still reads its own page');
  assert.equal(done.browser_session, undefined, 'the first run had the shared browser');
  assert.equal(second.result, 'http://site/register');
  assert.match(second.browser_session, new RegExp('^' + shared + '-' + process.pid + '-\\d+$'));
  assert.match(second.browser_note, /run --session /);
  const again = await run(`return await web.url();`);
  assert.equal(again.result, 'http://site/orders', 'once the first run ended, the next one continues on the shared page');
  assert.equal(again.browser_session, undefined);
});

test('a browser that cannot be opened twice is refused while another run drives it, and free again after', async () => {
  const name = fresh();
  const holder = pageLease(['--session', name]);
  assert.deepEqual(await holder.flags(), ['--session', name]);
  const second = pageLease(['--session', name]);
  await assert.rejects(second.flags(), err => {
    assert.equal(err.code, 'BROWSER_BUSY');
    assert.match(err.message, new RegExp('process ' + process.pid));
    return true;
  });
  await holder.release();
  const third = pageLease(['--session', name]);
  assert.deepEqual(await third.flags(), ['--session', name]);
  await third.release();
});

test('a browser opened for one read is closed after it', async () => {
  const name = fresh();
  const holder = pageLease(['--session', name]);
  await holder.flags();
  const closed = [];
  const reader = pageLease(['--session', name], { own: true, close: async session => { closed.push(session); } });
  const flags = await reader.flags();
  assert.notEqual(flags[1], name);
  assert.ok(flags.includes('--idle-timeout'), 'a browser left behind by a crash closes itself');
  await reader.release();
  assert.deepEqual(closed, [flags[1]]);
  await holder.release();
});
