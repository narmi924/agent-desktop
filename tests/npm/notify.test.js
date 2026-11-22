'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { showNotification, toastScript } = require('../../npm/lib/notify');

test('a notification carries Chinese text and quotes intact through an encoded command', { skip: process.platform !== 'win32' }, () => {
  const runs = [];
  showNotification('一个任务在等你确认', '停在“点击 提交订单”之前。<b> & it\'s', (...args) => runs.push(args));
  assert.equal(runs.length, 1);
  const [binary, args, options] = runs[0];
  assert.equal(binary, 'powershell.exe');
  assert.equal(options.windowsHide, true);
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /一个任务在等你确认/);
  assert.match(script, /停在“点击 提交订单”之前。&lt;b&gt; &amp; it&apos;s/, 'markup in the text cannot break the toast');
  assert.doesNotMatch(toastScript("a'b", 'c'), /'a'b'/, 'a quote cannot end the PowerShell string early');
});
