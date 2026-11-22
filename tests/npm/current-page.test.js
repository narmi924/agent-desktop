'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { current } = require('../../npm/lib/current-page');

const WINDOW = { id: 'w-1', visible: true, minimized: false, is_focused: true, process_instance: 'p-1' };
const page = (doc, field) => ({ role: 'document', name: '会员注册', value: 'http://127.0.0.1:8790/register', ref_id: doc,
  children: [{ role: 'textfield', name: '姓名', ref_id: field, available_actions: ['SetValue'] }] });
const tabs = { role: 'tablist', children: [{ role: 'tab', name: '会员注册', tab_instance: 't-1', states: ['selected'], ref_id: '@s1:e9' }] };

function chrome(tree) {
  return (...args) => {
    if (args[0] === 'list-windows') return [WINDOW];
    if (args[0] === 'snapshot') return { window: { id: 'w-1' }, complete: true, tree };
    throw new Error('unexpected ' + args.join(' '));
  };
}

test('a page Chrome lists twice counts as one, read from where it is drawn', async () => {
  const twice = { role: 'window', name: '会员注册 - Google Chrome', children: [
    { role: 'group', name: 'Chrome Legacy Window', children: [page('@s1:e2', '@s1:e3')] },
    { role: 'group', name: '会员注册 - Google Chrome - E', children: [tabs,
      { role: 'group', children: [{ role: 'group', children: [{ role: 'group', name: 'Chrome Legacy Window', children: [page('@s1:e93', '@s1:e94')] }] }] }] }] };
  const seen = await current(chrome(twice), {});
  assert.equal(seen.url, 'http://127.0.0.1:8790/register');
  assert.deepEqual(seen.controls.map(c => c.ref), ['@s1:e94']);
});

test('two different pages in one window are still refused', async () => {
  const other = page('@s1:e50', '@s1:e51');
  other.value = 'http://127.0.0.1:8790/orders';
  const split = { role: 'window', name: 'Chrome', children: [tabs, page('@s1:e2', '@s1:e3'), other] };
  await assert.rejects(current(chrome(split), {}), /Expected one visible web document/);
});
