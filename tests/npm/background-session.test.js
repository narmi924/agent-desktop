'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');

/** A stand-in agent-browser: a small program that writes its arguments to a log and answers success. */
function fakeBrowser(dir) {
  const source = join(dir, 'Fake.cs');
  const exe = join(dir, 'fake-agent-browser.exe');
  writeFileSync(source, [
    'using System; using System.IO;',
    'public static class Fake { public static void Main(string[] args) {',
    '  File.AppendAllText(Environment.GetEnvironmentVariable("FAKE_LOG"), string.Join(" ", args) + "\\n");',
    '  Console.WriteLine("{\\"success\\":true,\\"data\\":{\\"url\\":\\"http://127.0.0.1:1/x\\",\\"title\\":\\"x\\",\\"snapshot\\":\\"\\"}}");',
    '} }',
  ].join('\n'));
  const built = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw '${source}') -OutputAssembly '${exe}' -OutputType ConsoleApplication`], { encoding: 'utf8' });
  if (!existsSync(exe)) throw new Error('could not build the stand-in: ' + built.stderr);
  return exe;
}

test('background web steps use their own session, whatever AGENT_BROWSER_SESSION says', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-session-'));
  const log = join(dir, 'calls.log');
  const env = { ...process.env, AGENT_DESKTOP_HOME: dir, AGENT_BROWSER_BIN: fakeBrowser(dir), FAKE_LOG: log, AGENT_BROWSER_SESSION: 'work' };
  const script = join(dir, 'task.js');
  writeFileSync(script, 'await web.open("http://127.0.0.1:1/x"); return 1;');
  spawnSync(process.execPath, [workflow, 'run', '--file', script], { env, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call, /--session agent-desktop-background\b/, 'a session someone connected to their own Chrome is never used: ' + call);
  }
  writeFileSync(log, '');
  spawnSync(process.execPath, [workflow, 'run', '--file', script, '--session', 'named'], { env, encoding: 'utf8' });
  assert.match(readFileSync(log, 'utf8').split('\n')[0], /--session named\b/, 'a session the caller names on the command line still wins');
});
