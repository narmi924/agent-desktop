'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const SCRIPT = join(__dirname, '..', '..', 'npm', 'lib', 'confirm-window.ps1');

test('a person\'s click on each choice reaches the answer the host reads', { skip: process.platform !== 'win32' }, () => {
  for (const choice of ['once', 'always', 'deny']) {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-What', '测试', '-Routine', 'r', '-Seconds', '15', '-SelfTest', choice],
      { encoding: 'utf8', timeout: 60000 });
    assert.equal(out.trim().split(/\r?\n/).at(-1), choice);
  }
});
