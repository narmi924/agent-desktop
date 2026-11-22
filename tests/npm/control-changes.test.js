'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { describeChanges } = require('../../npm/lib/control-changes');
const { runScript } = require('../../npm/lib/script-run');

test('a changed control says what changed, and a value the step wrote is never printed', () => {
  const lines = describeChanges({
    changed: [
      { role: 'textfield', name: '手机号', before: { value: '', states: ['focused'] }, after: { value: '13899001234', states: [] } },
      { role: 'edit', name: '手机号', before: { value: '' }, after: { value: '13899001234' } },
      { role: 'statictext', name: '合计', before: { value: '0.00', states: [] }, after: { value: '231.00', states: [] } },
      { role: 'checkbox', name: '需要发票', before: { value: null, states: [] }, after: { value: null, states: ['checked', 'focused'] } },
      { role: 'button', name: '更多', before: { states: ['collapsed'] }, after: { states: ['expanded'] } },
      { role: 'textfield', name: '密码', before: { value: '' }, after: { value: '••••', states: ['protected'] } },
      { role: 'button', name: '提交', before: { states: ['focused'] }, after: { states: [] } },
    ],
    added: [{ role: 'button', name: '确定' }, { role: 'button', name: '取消' }, { role: 'link', name: '帮助' }, { role: 'link', name: '' }],
    removed: [{ role: 'button', name: '下一步' }],
  }, { hidden: '手机号', written: '13899001234' }).map(([text]) => text);
  assert.deepEqual(lines, [
    '"手机号" value changed',
    '"合计" value "0.00" -> "231.00"',
    '"需要发票" checked',
    '"更多" expanded',
    '"密码" value changed',
    '4 controls appeared: "确定", "取消", "帮助" and 1 more',
    '1 control went away: "下一步"',
  ]);
  assert.ok(!lines.join(' ').includes('13899001234'), 'the typed phone number is not in the record');
});

test('text typed through a ref is still kept out of the record by what was written', () => {
  const [[text]] = describeChanges({ changed: [{ role: 'textfield', name: '备注', before: { value: '旧的' }, after: { value: '旧的 明天三点' } }] }, { written: ['明天三点'] });
  assert.equal(text, '"备注" value changed');
});

/** A window that answers snapshot --since with the changes the test sets, and counts the reads. */
function window({ changes, delivery = 'delivered_verified' }) {
  const calls = [];
  let read = 0;
  const tree = { complete: true, tree: { role: 'window', name: '登记', children: [
    { role: 'textfield', name: '手机号', ref_id: '@s1:e1' }, { role: 'button', name: '计算', ref_id: '@s1:e2' }, { role: 'button', name: '保存', ref_id: '@s1:e3' }] } };
  const call = async (binary, args, options = {}) => {
    calls.push({ args, input: options.input });
    if (args[0] === 'list-windows') return [{ id: 'w-1', app_name: 'register.exe', title: '登记' }];
    if (args.includes('snapshot')) {
      read++;
      const since = args.includes('--since');
      return { ...tree, snapshot_id: 's' + read, ...(since ? { changes: changes.shift() ?? { added: [], removed: [], changed: [] } } : {}) };
    }
    if (args[0] === 'set-value') return { disposition: { delivery } };
    return { disposition: { delivery: 'delivered_verified' } };
  };
  return { calls, call, reads: () => read };
}

test('a click reports what it changed, a confirmed fill costs no read, and the next click reports only its own change', async () => {
  const w = window({ changes: [
    { changed: [{ role: 'statictext', name: '合计', before: { value: '0.00' }, after: { value: '231.00' } }] },
    { added: [{ role: 'button', name: '确定' }] },
  ] });
  const done = await runScript(`
    await desktop.click("w-1", "计算");
    await desktop.fill("w-1", "手机号", "13899001234");
    await desktop.click("w-1", "保存");
    return true;`, { native: 'desktop', call: w.call, allowInput: true, allowFinal: true });
  assert.match(done.steps[0], /desktop\.click 计算 \("合计" value "0\.00" -> "231\.00"\)/);
  assert.match(done.steps[1], /^desktop\.fill 手机号 \d+ms$/, 'the fill was confirmed by its own read-back, so the window is not read again');
  assert.match(done.steps[2], /desktop\.click 保存 \(1 control appeared: "确定"\)/);
  assert.ok(!done.steps.join(' ').includes('13899001234'), 'the typed value stays out of the steps');
  const since = w.calls.filter(c => c.args.includes('--since')).map(c => c.args[c.args.indexOf('--since') + 1]);
  assert.deepEqual(since, ['s1', 's3'], 'the second click compares against a read taken after the fill, so the fill is not counted as its change');
  assert.equal(w.reads(), 4, 'before and after each click; the fill itself reads nothing');
});

test('a fill the app did not confirm reports what the window shows now', async () => {
  const w = window({ delivery: 'delivered_unverified', changes: [
    { changed: [{ role: 'textfield', name: '手机号', before: { value: '' }, after: { value: '1389900' } }] },
  ] });
  const done = await runScript('await desktop.fill("w-1", "手机号", "13899001234"); return true;', { native: 'desktop', call: w.call, allowInput: true, allowFinal: true });
  assert.match(done.steps[0], /desktop\.fill 手机号 \("手机号" value changed\)/);
  assert.ok(done.warnings?.some(text => /did not confirm/.test(text)));
});

test('a click that changes nothing says so after looking twice', async () => {
  const w = window({ changes: [] });
  const done = await runScript('await desktop.click("w-1", "保存"); return true;', { native: 'desktop', call: w.call, allowInput: true, allowFinal: true });
  assert.match(done.steps[0], /\(no control changed\)/);
  assert.equal(w.calls.filter(c => c.args.includes('--since')).length, 2, 'it looked once more after a short wait');
});
