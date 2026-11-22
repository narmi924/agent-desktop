'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { withOptions } = require('../../npm/lib/script-fix');
const { runScript } = require('../../npm/lib/script-run');

const within = (ms, work) => Promise.race([work, delay(ms).then(() => { throw new Error('still waiting after ' + ms + ' ms'); })]);

test('a retry\'s timeout reaches a wait helper wherever it takes it, and the longer of the two times applies', () => {
  assert.deepEqual(withOptions(['订单号'], { timeout: 15000 }, 'web.waitText'), ['订单号', 15000]);
  assert.deepEqual(withOptions(['订单号', 2000], { timeout: 15000 }, 'web.waitText'), ['订单号', 15000]);
  assert.deepEqual(withOptions(['订单号', 30000], { timeout: 15000 }, 'web.waitText'), ['订单号', 30000]);
  assert.deepEqual(withOptions(['订单号', { timeout: 2000 }], { timeout: 15000 }, 'visible.waitText'), ['订单号', { timeout: 15000 }]);
  assert.deepEqual(withOptions(['登记', '已保存'], { timeout: 15000 }, 'desktop.waitText'), ['登记', '已保存', 15000]);
  assert.deepEqual(withOptions(['登记', '已保存', 2000, { picture: false }], { timeout: 15000 }, 'desktop.waitText'), ['登记', '已保存', 15000, { picture: false }]);
  assert.deepEqual(withOptions(['保存'], { timeout: 9000 }, 'web.click'), ['保存', { timeout: 9000 }]);
  assert.deepEqual(withOptions(['保存', { near: '底部', timeout: 20000 }], { timeout: 9000 }, 'web.waitFor'), ['保存', { near: '底部', timeout: 20000 }]);
});

test('a waitText retried with --options waits that long and then ends, so job wait ends too', async () => {
  const asked = [];
  const answers = [{ action: 'retry', options: { timeout: 400 } }, { action: 'stop' }];
  const call = async (binary, args) => {
    const words = args.slice(args.indexOf('--json') + 1);
    if (words[0] === 'snapshot') return { snapshot: '- StaticText "提交中"', origin: 'http://x/' };
    throw new Error('unexpected command: ' + words.join(' '));
  };
  const started = Date.now();
  const run = runScript(`return await web.waitText('订单号');`, {
    browser: 'browser', native: 'desktop', flags: ['--session', 't'], call, timeout: 60000,
    fix: { fixes: [], ask: async info => { asked.push({ info, at: Date.now() }); return answers.shift(); } },
  });
  const waited = Date.now();
  await within(30000, assert.rejects(run, { code: 'TIMEOUT', message: /within 400 ms/ }));
  assert.equal(asked.length, 2);
  assert.ok(asked[0].at - started >= 9000, 'the first wait used the default 10 s');
  const second = asked[1].at - asked[0].at;
  assert.ok(second >= 350 && second < 3000, 'the retried wait took the time the retry gave it: ' + second + ' ms');
  assert.ok(Date.now() - waited < 30000);
});

test('a wait given its time as an options object ends at that time instead of never', async () => {
  const call = async () => ({ snapshot: '- StaticText "提交中"', origin: 'http://x/' });
  const run = runScript(`await web.waitText('订单号', { timeout: 300 });`, { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call });
  await within(5000, assert.rejects(run, { code: 'TIMEOUT', message: /within 300 ms/ }));
});
