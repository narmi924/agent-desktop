'use strict';

const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { homedir } = require('node:os');

const WINDOW_MS = 15 * 60 * 1000;

function recordPath() {
  return join(process.env.AGENT_DESKTOP_HOME || join(homedir(), '.agent-desktop'), 'scripts', 'last-failure.json');
}

function readRecord() {
  try { return JSON.parse(readFileSync(recordPath(), 'utf8')); } catch { return undefined; }
}

/**
 * A script step that fails the same way as the run before it is marked: the reply counts the
 * repeats and says to change the approach, because the same script will fail the same way again.
 */
function markRepeat(err, now = Date.now()) {
  if (!err?.report?.step) return err;
  const key = err.report.step + ' | ' + (err.code ?? 'ERROR');
  const last = readRecord();
  const count = last && last.key === key && now - last.at < WINDOW_MS ? last.count + 1 : 1;
  try {
    mkdirSync(dirname(recordPath()), { recursive: true });
    writeFileSync(recordPath(), JSON.stringify({ key, count, at: now }));
  } catch { /* A failure to remember never hides the failure itself. */ }
  if (count >= 2) {
    err.report.repeat = count;
    err.report.advice = 'This step failed the same way ' + count + ' times in a row. Do not run it again as it is, and do not add waits, ' +
      'nudge coordinates or reopen the app: read data.scene, then reach the target another way (a name from read(), {near}, {nth}, ' +
      'a ref, the picture), or ask the user.';
  }
  return err;
}

function clearRepeat() {
  try { rmSync(recordPath(), { force: true }); } catch { /* Nothing to clear. */ }
}

module.exports = { markRepeat, clearRepeat };
