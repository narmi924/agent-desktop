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
