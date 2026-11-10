'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { join } = require('node:path');
const { space, spaceFlags, spaceDir, installedChrome } = require('../../npm/lib/space');

function fakeBrowser(sessions = []) {
  const calls = [];
  const call = async (binary, args) => {
    calls.push(args);
    if (args.includes('list')) return { sessions };
    if (args.includes('open')) return { url: args.at(-1), title: '登录' };
    return { closed: true };
  };
  return { call, calls };
}

function withHome(home, run) {
  const before = process.env.AGENT_DESKTOP_HOME;
  process.env.AGENT_DESKTOP_HOME = home;
  try { return run(); } finally {
    if (before === undefined) delete process.env.AGENT_DESKTOP_HOME; else process.env.AGENT_DESKTOP_HOME = before;
  }
}

test('the profile sits beside the state root and page commands name it with the installed Chrome', () => withHome(join('X:', 'state'), () => {
  assert.equal(spaceDir(), join('X:', 'state') + '-space');
  assert.deepEqual(spaceFlags('C:/chrome.exe'), ['--session', 'space', '--profile', spaceDir(), '--executable-path', 'C:/chrome.exe']);
  assert.deepEqual(spaceFlags(null), ['--session', 'space', '--profile', spaceDir()]);
}));

test('an explicit Chrome path wins, and no installed Chrome leaves the choice to the browser tool', () => {
  assert.equal(installedChrome({ AGENT_DESKTOP_SPACE_CHROME: 'D:/c.exe', PROGRAMFILES: 'C:/none' }), 'D:/c.exe');
  assert.equal(installedChrome({ PROGRAMFILES: join('X:', 'no-such-folder') }), undefined);
});

test('login restarts the profile in a visible window on the sign-in page', async () => {
  const browser = fakeBrowser();
  const data = await withHome(join('X:', 'state'), () => space('ab', { login: 'https://example.com/login' }, browser.call));
  assert.equal(data.window, 'visible');
  assert.equal(data.url, 'https://example.com/login');
  assert.deepEqual(browser.calls.map(args => args.slice(args.indexOf('--json'))), [
    ['--json', 'close'],
    ['--json', 'open', 'https://example.com/login'],
  ]);
  assert.deepEqual(browser.calls.map(args => args.includes('--headed')), [false, true]);
  assert.ok(browser.calls.every(args => args.includes('--profile') && args[1] === 'space'));
});

test('login refuses anything but a web address and cannot be combined with close', async () => {
  const browser = fakeBrowser();
  await assert.rejects(space('ab', { login: 'file:///C:/secrets.html' }, browser.call), /http or https/);
  await assert.rejects(space('ab', { login: 'not a url' }, browser.call), /http or https/);
  await assert.rejects(space('ab', { login: 'https://a.example', close: true }, browser.call), /either/);
  assert.equal(browser.calls.length, 0);
});

test('close stops the window and no option reports whether the profile is running', async () => {
  const browser = fakeBrowser(['work', 'space']);
  assert.equal((await space('ab', { close: true }, browser.call)).window, 'closed');
  assert.equal((await space('ab', {}, browser.call)).running, true);
  assert.equal((await space('ab', {}, fakeBrowser(['work']).call)).running, false);
});
