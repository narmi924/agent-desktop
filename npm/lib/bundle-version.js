'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/** The bundle's own version and the official releases each part is built on, from bundle.json. */
function bundle() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'bundle.json'), 'utf8'));
}

function installed(binary) {
  if (!binary) return undefined;
  try { return execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim().split(/\s+/).pop(); } catch { return undefined; }
}

const base = part => part.tag + (part.commits_after_tag ? '+' + part.commits_after_tag : '') + ' (' + part.commit.slice(0, 8) + ')';

/**
 * What `agent-desktop-workflow --version` prints: the bundle version, and for each program the version it reports and
 * the official release it is built on, so a report of a problem says which build it came from.
 */
function versionReport({ nativeBinary, browserBinary } = {}) {
  const info = bundle();
  return {
    version: info.version, platform: info.platform,
    'agent-desktop': { installed: installed(nativeBinary), based_on: base(info.upstream['agent-desktop']), repository: info.upstream['agent-desktop'].repository },
    'agent-browser': { installed: installed(browserBinary), based_on: base(info.upstream['agent-browser']), repository: info.upstream['agent-browser'].repository },
  };
}

module.exports = { bundle, versionReport, base };
