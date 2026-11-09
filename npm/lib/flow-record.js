'use strict';

const { appendFileSync, readFileSync, statSync } = require('node:fs');

const RECORDED = new Set(['follow', 'type', 'wheel', 'point', 'click', 'edit', 'choose', 'tap', 'move']);
const MAX_GAP_MS = 5000;

function lastStepTime(path) {
  try { return statSync(path).mtimeMs; } catch { return undefined; }
}

function recordStep(path, command, values) {
  if (!RECORDED.has(command)) return;
  const { page, stdin, ...options } = values;
  const previous = lastStepTime(path);
  const wait_ms = previous === undefined ? 0 : Math.min(MAX_GAP_MS, Math.max(0, Math.round(Date.now() - previous)));
  appendFileSync(path, JSON.stringify({ command, options, needs_page: page !== undefined, wait_ms }) + '\n');
}

function readSteps(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const step = JSON.parse(line);
      if (!RECORDED.has(step.command)) throw new Error('unknown command');
      return step;
    } catch (error) {
      throw new Error('Flow line ' + (index + 1) + ' is invalid: ' + error.message);
    }
  });
}

module.exports = { recordStep, readSteps };