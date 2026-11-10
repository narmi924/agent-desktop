'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { invoke } = require('./script-call');

const SESSION = 'space';

/** The agent's own browser profile. Sign-ins made in it stay there between runs. */
function spaceDir() {
  // Beside the state root, never inside it: the CLI must be the one to create that private folder.
  return (process.env.AGENT_DESKTOP_HOME ?? join(homedir(), '.agent-desktop')) + '-space';
}

/** The installed Chrome is kept up to date; prefer it for a profile that holds sign-ins. */
function installedChrome(env = process.env) {
  if (env.AGENT_DESKTOP_SPACE_CHROME) return env.AGENT_DESKTOP_SPACE_CHROME;
  return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter(Boolean)
    .map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find(path => existsSync(path));
}

function spaceFlags(chrome = installedChrome()) {
  return ['--session', SESSION, '--profile', spaceDir(), ...(chrome ? ['--executable-path', chrome] : [])];
}

/**
 * `login` shows the agent's own browser window so the user can sign in to a site once.
 * The window stays open and usable until `close`; after that the same profile runs
 * in the background with the sign-in kept.
 */
async function space(binary, { login, close }, call = invoke) {
  const flags = spaceFlags();
  const ab = (args, timeout) => call(binary, [...flags, '--json', ...args], { timeout });
  if (login && close) throw new Error('Choose either --login URL or --close.');
  if (close) {
    await ab(['close'], 20000);
    return { window: 'closed', profile: spaceDir() };
  }
  if (login) {
    let url;
    try { url = new URL(login); } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('--login takes the http or https address of the sign-in page.');
    try { await ab(['close'], 20000); } catch { /* No browser was running. */ }
    const opened = await call(binary, [...flags, '--headed', '--json', 'open', url.href], { timeout: 60000 });
    return { window: 'visible', url: opened.url, title: opened.title, profile: spaceDir(),
      next: 'The user signs in in that window. Page commands with --space work on it meanwhile. Run space --close when the user is done.' };
  }
  const { sessions = [] } = await call(binary, ['--json', 'session', 'list'], { timeout: 20000 });
  const running = sessions.some(entry => (entry.name ?? entry.session ?? entry) === SESSION);
  return { running, profile: spaceDir(), signed_in_before: existsSync(spaceDir()) };
}

module.exports = { space, spaceFlags, spaceDir, installedChrome };
