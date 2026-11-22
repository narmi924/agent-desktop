'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runScript } = require('../../npm/lib/script-run');
const { typedSoFar } = require('../../npm/lib/script-desktop');

const WINDOW = { complete: true, tree: { role: 'window', name: '登记', children: [{ role: 'textfield', name: '备注', ref_id: '@s1:e1' }] } };
const TEXT = '明天下午三点到仓库取货，带上发票。';

/** A field that a person interrupts once: typing stops after `stopAt` characters plus `slip`, and the tool is told it cut that short. */
function field({ stopAt, slip = '', start = '' }) {
  let value = start, cut = false, typed = 0;
  const calls = [];
  const call = async (binary, args, options = {}) => {
    calls.push(args.join(' '));
    if (args[0] === 'snapshot') return WINDOW;
    if (args[0] === 'list-windows') return [{ id: 'w-1', app_name: 'register.exe', title: '登记' }];
    if (args[0] === 'get') return { value };
    if (args[0] === 'set-value') { value = options.input; return {}; }
    if (args.includes('type')) {
      typed++;
      if (typed === 1) { value += options.input.slice(0, stopAt) + slip; cut = true; throw new Error('the process was killed'); }
      value += options.input;
      return { disposition: { delivery: 'delivered_verified' } };
    }
    throw new Error('unexpected ' + args.join(' '));
  };
  const hands = { bind() {}, using() {}, cutShort: () => cut, wait: async () => { cut = false; return 'retry'; } };
  const fix = { ask: async () => ({ action: 'stop' }), fixes: [] };
  return { calls, value: () => value, run: source => runScript(source, { native: 'desktop', call, allowInput: true, hands, fix }) };
}

test('typing a person interrupted goes on from where it stopped, so the field ends up with the text once', async () => {
  const f = field({ stopAt: 6 });
  await f.run(`human('natural'); await desktop.type('登记', '备注', ${JSON.stringify(TEXT)});`);
  assert.equal(f.value(), TEXT);
  assert.equal(f.calls.filter(c => c.includes(' type ')).length, 2);
});

test('a slip not yet taken back when the person came in is removed before the rest goes in', async () => {
  const f = field({ stopAt: 4, slip: 'q', start: '已有：' });
  await f.run(`human('natural'); await desktop.type('登记', '备注', ${JSON.stringify(TEXT)});`);
  assert.equal(f.value(), '已有：' + TEXT);
});

test('what went in is counted only when the field still starts with what it held', () => {
  assert.deepEqual(typedSoFar('', '明天下', '明天下午'), { done: 3, stray: 0 });
  assert.deepEqual(typedSoFar('a', 'a明天x', '明天下午'), { done: 2, stray: 1 });
  assert.equal(typedSoFar('原文', '明天原文', '明天'), undefined);
  assert.equal(typedSoFar('', '完全不同的一长串文字', '明天'), undefined);
});
