'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.AGENT_DESKTOP_HOME = mkdtempSync(join(tmpdir(), 'ad-approvals-'));

const grants = require('../../npm/lib/routine-approvals');
const routines = require('../../npm/lib/routine-command');
const store = require('../../npm/lib/routine-store');
const { runScript } = require('../../npm/lib/script-run');

const FORM = { complete: true, tree: { role: 'window', name: '网银', children: [{ role: 'button', name: '确认转账', ref_id: '@s1:e1' }] } };

function desk() {
  const calls = [];
  const call = async (binary, args) => {
    calls.push(args[0]);
    if (args[0] === 'list-windows') return [{ id: 'w-1', app_name: 'bank.exe', title: '网银' }];
    if (args[0] === 'snapshot') return FORM;
    if (args[0] === 'click') return {};
    throw new Error('unexpected ' + args.join(' '));
  };
  return { calls, run: (source, extra) => runScript(source, { native: 'desktop', call, ...extra }) };
}

test('a standing approval holds for the script it was given to and ends when the script changes or is revoked', () => {
  grants.approve('pay-rent', 'await desktop.click("网银", "确认转账");');
  assert.equal(grants.approved('pay-rent', 'await desktop.click("网银", "确认转账");'), true);
  assert.equal(grants.approved('pay-rent', 'await desktop.click("网银", "确认转账"); await desktop.click("网银", "再转一笔");'), false);
  assert.equal(grants.approved('other', 'x'), false);
  assert.equal(grants.revoke('pay-rent'), true);
  assert.equal(grants.approved('pay-rent', 'await desktop.click("网银", "确认转账");'), false);
});

test('protected apps and sites come from the user\'s own file, sites with their subdomains', () => {
  writeFileSync(grants.protectedPath(), JSON.stringify({ apps: ['Bank.exe'], hosts: ['bank.example'] }));
  assert.equal(grants.surfaceRefused({ app: 'bank.exe' }).code, 'SURFACE_PROTECTED');
  assert.equal(grants.surfaceRefused({ host: 'www.bank.example' }).code, 'SURFACE_PROTECTED');
  assert.equal(grants.surfaceRefused({ host: 'notbank.example' }), undefined);
  assert.equal(grants.surfaceRefused({ app: 'notepad.exe' }), undefined);
});

test('a script on a protected app stops before anything is sent; an approved routine may act there', async () => {
  writeFileSync(grants.protectedPath(), JSON.stringify({ apps: ['bank.exe'] }));
  const loose = desk();
  const err = await loose.run('await desktop.click("网银", "确认转账", { final: false });', { allowFinal: true }).catch(e => e);
  assert.equal(err.code, 'SURFACE_PROTECTED');
  assert.ok(!loose.calls.includes('click'), 'no click was sent');
  const source = 'await desktop.click("网银", "确认转账");\nexpect(true);';
  store.save({ name: 'pay-rent', about: '', params: [], status: 'candidate', successes: 1, failures: 0, updated: new Date().toISOString(),
    input: false, finals: [], apps: ['bank.exe'], hosts: [], steps: [], seen: {}, pinned: {} }, source);
  const before = await routines.runRoutine('pay-rent', {}, (src, extra) => desk().run(src, extra)).catch(e => e);
  assert.equal(before.code, 'FINAL_NOT_ALLOWED', 'without a standing approval the final click is refused');
  assert.equal(routines.allow('pay-rent').allowed, 'pay-rent', 'the user said so in the chat: routine allow records it');
  assert.deepEqual(routines.permissions().approved.map(a => [a.name, a.current]), [['pay-rent', true]]);
  const tools = desk();
  const after = await routines.runRoutine('pay-rent', {}, (src, extra) => tools.run(src, extra));
  assert.equal(after.routine, 'pay-rent');
  assert.ok(tools.calls.includes('click'), 'approved for good: the routine acts on the protected app and its final step goes');
});
