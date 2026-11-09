'use strict';

const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const SESSION = 'agent-desktop-web';
const ROUTED = new Set(['click', 'type', 'edit', 'follow']);
const DESKTOP_ONLY = ['human', 'seed', 'visible', 'interval-ms', 'multiline', 'after', 'nth', 'stdin'];
const CONNECT_WAIT_MS = 120000;
const COMMAND_WAIT_MS = 20000;
const NAVIGATION_WAIT_MS = 7000;
const EXPECT_WAIT_MS = '3500';
const MISS = /not found|no element|no match|did not match|could not find|unable to find|found 0/i;

function routeFile() {
  // Beside the state root, never inside it: the CLI must be the one to create that private folder.
  return (process.env.AGENT_DESKTOP_HOME ?? join(homedir(), '.agent-desktop')) + '-web-route.json';
}

function savedRoute() {
  try { return JSON.parse(readFileSync(routeFile(), 'utf8')); } catch { return undefined; }
}

function call(binary, args, timeout) {
  let out;
  try {
    // An idle daemon that exits would cost the user another Chrome approval.
    const env = { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' };
    out = execFileSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout, env, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (!err.stdout) throw new Error('The browser connection did not answer.');
    out = err.stdout;
  }
  const reply = JSON.parse(out);
  if (!(reply.success ?? reply.ok)) throw new Error(String(reply.error?.message ?? reply.error ?? 'The browser refused the command.'));
  return reply.data;
}

function browser(binary, route) {
  return (...command) => call(binary, ['--session', route.session, ...route.flags, '--json', ...command], COMMAND_WAIT_MS);
}

/** Opens the one connection later commands reuse. Chrome may ask to allow it. */
function connect(binary, { cdp }) {
  const route = { session: SESSION, flags: cdp ? ['--cdp', cdp, '--pin-tab'] : ['--auto-connect'] };
  const { tabs } = call(binary, ['--session', route.session, ...route.flags, '--json', 'tab', 'list'], CONNECT_WAIT_MS);
  mkdirSync(dirname(routeFile()), { recursive: true });
  writeFileSync(routeFile(), JSON.stringify(route));
  return { connected: true, session: route.session, tabs: tabs.length };
}

function disconnect() {
  rmSync(routeFile(), { force: true });
  return { connected: false };
}

function decoded(page) {
  try { return JSON.parse(Buffer.from(page, 'base64url').toString()); } catch { return undefined; }
}

function encoded(saved) {
  return Buffer.from(JSON.stringify(saved)).toString('base64url');
}

function claim(ab, { url, title }) {
  if (title) {
    try { return ab('tab', 'claim', '--url', url, '--title', title); } catch { /* The title may have changed since it was read. */ }
  }
  return ab('tab', 'claim', '--url', url);
}

/** Marks a page handle as reachable over the connection when its tab can be bound. */
function withRoute(binary, data) {
  const route = savedRoute();
  if (!route || !binary) return { ...data, route: 'desktop' };
  try {
    claim(browser(binary, route), data);
    return { ...data, page: encoded({ ...decoded(data.page), route: 'web', title: data.title }), route: 'web' };
  } catch {
    return { ...data, route: 'desktop' };
  }
}

function plainText(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !/[\t\r\n]/.test(value);
}

function usable(command, values) {
  if (!ROUTED.has(command) || !values.page || DESKTOP_ONLY.some(key => values[key] !== undefined)) return false;
  if (command === 'type' || command === 'edit') return Boolean(values.field) && plainText(values.value);
  if (command === 'click') return Boolean(values.on) && !values.on.startsWith('-');
  return Boolean(values.link) !== Boolean(values.button) && !(values.link ?? values.button).startsWith('-');
}

function firstHit(attempts) {
  let last;
  for (const attempt of attempts) {
    try { return attempt(); } catch (err) {
      last = err;
      if (!MISS.test(err.message)) throw err;
    }
  }
  throw last;
}

function onField(ab, name, action, ...value) {
  return firstHit(['label', 'placeholder', 'near'].map(by => () => ab('find', by, name, action, ...value, '--exact')));
}

function press(ab, name, role) {
  const by = role ? [['role', role]] : [['text'], ['role', 'button'], ['role', 'link']];
  return firstHit(by.map(([kind, value]) => () => kind === 'text'
    ? ab('find', 'text', name, 'click', '--exact')
    : ab('find', 'role', value, 'click', '--name', name, '--exact')));
}

function delivery(receipt) {
  return receipt?.verified === true ? 'delivered_verified' : 'delivered_unverified';
}

function typeText(ab, { field, value, replace }) {
  onField(ab, field, 'click');
  if (replace) {
    ab('press', 'Control+a');
    ab('press', 'Delete');
  }
  ab('keyboard', 'type', value);
  const now = ab('eval', 'document.activeElement && document.activeElement.value').result;
  return typeof now === 'string' && (replace ? now === value : now.includes(value));
}

async function followControl(ab, saved, { page, link, button, 'expect-url': expected }) {
  const reply = press(ab, link ?? button, link ? 'link' : 'button');
  if (reply?.receipt?.effects?.new_tab) {
    throw Object.assign(new Error('Control already clicked. It opened a new tab. Run current to take it over.'),
      { code: 'ACTION_FAILED', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } });
  }
  const until = Date.now() + NAVIGATION_WAIT_MS;
  do {
    const { url } = ab('get', 'url');
    if (url !== saved.url && (!expected || url === expected)) {
      const { title } = ab('get', 'title');
      return { page: encoded({ ...saved, url, title }), url, title, navigation: 'same-tab', route: 'web' };
    }
    await delay(100);
  } while (Date.now() < until);
  throw Object.assign(new Error('Control already clicked. The expected destination was not observed. Inspect current before repeating.'),
    { code: 'ACTION_FAILED', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' }, page });
}

/**
 * Runs a page command over the connection. Returns undefined when this command
 * or this page has to use the desktop route instead.
 */
async function webPerform(binary, command, values) {
  if (!binary || !usable(command, values)) return undefined;
  const route = savedRoute();
  const saved = decoded(values.page);
  if (!route || saved?.route !== 'web') return undefined;
  const ab = browser(binary, route);
  try {
    claim(ab, saved);
  } catch {
    try { ab('tab', 'list'); } catch { return undefined; }
    throw new Error('The page navigated. Read it with current --page before acting.');
  }
  const { page, field, on, role } = values;
  switch (command) {
    case 'type':
      return { page, field, verified: typeText(ab, values), route: 'web' };
    case 'edit': {
      const reply = onField(ab, field, 'fill', values.value);
      return { page, url: saved.url, field, delivery: delivery(reply?.receipt), route: 'web' };
    }
    case 'click': {
      const reply = press(ab, on, role);
      const report = { page, on, delivery: delivery(reply?.receipt), route: 'web' };
      if (!values['expect-text']) return report;
      try {
        ab('wait', '--text', values['expect-text'], '--timeout', EXPECT_WAIT_MS);
        return { ...report, expected_text: values['expect-text'], verified: true };
      } catch {
        return { ...report, expected_text: values['expect-text'], verified: false };
      }
    }
    default:
      return followControl(ab, saved, values);
  }
}

module.exports = { connect, disconnect, webPerform, withRoute, usable };
