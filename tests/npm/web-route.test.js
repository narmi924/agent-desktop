'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromeFlags } = require('../../npm/lib/web-page');

function withHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'agent-desktop-route-test-'));
  const before = process.env.AGENT_DESKTOP_HOME;
  process.env.AGENT_DESKTOP_HOME = join(root, 'state');
  try { return run(join(root, 'state-web-route.json')); } finally {
    if (before === undefined) delete process.env.AGENT_DESKTOP_HOME; else process.env.AGENT_DESKTOP_HOME = before;
    rmSync(root, { recursive: true, force: true });
  }
}

test('a script in the running Chrome reuses the connection that connect opened', () => withHome(routeFile => {
  writeFileSync(routeFile, JSON.stringify({ session: 'agent-desktop-web', flags: ['--cdp', 'http://127.0.0.1:9222', '--pin-tab'] }));
  assert.deepEqual(chromeFlags(), ['--session', 'agent-desktop-web', '--cdp', 'http://127.0.0.1:9222', '--pin-tab']);
}));

test('without a saved connection it connects to the running Chrome on the same session connect would use', () => withHome(() => {
  assert.deepEqual(chromeFlags(), ['--session', 'agent-desktop-web', '--auto-connect']);
}));

test('reading a page gives a silent connection one short try and says how to restore it', () => withHome(routeFile => {
  const { withRoute } = require('../../npm/lib/web-page');
  writeFileSync(routeFile, JSON.stringify({ session: 'agent-desktop-web', flags: ['--auto-connect'] }));
  const tries = [];
  const silent = (binary, args, wait) => { tries.push(wait); throw new Error('The browser connection did not answer.'); };
  const page = withRoute('browser', { page: 'e30', url: 'https://example.com/', title: 'Example' }, silent);
  assert.equal(page.route, 'desktop');
  assert.match(page.route_note, /Run connect/);
  assert.deepEqual(tries, [4000], 'one try, a few seconds long');

  const answers = [];
  const missing = (binary, args) => { answers.push(args.includes('--title')); throw new Error('No tab matches that title.'); };
  const other = withRoute('browser', { page: 'e30', url: 'https://example.com/', title: 'Example' }, missing);
  assert.equal(other.route, 'desktop');
  assert.equal(other.route_note, undefined);
  assert.deepEqual(answers, [true, false], 'a tab that was not found by title is looked for by address');
}));
