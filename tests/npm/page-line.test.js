'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { shows } = require('../../npm/lib/script-web');

/** Compact reads as agent-browser gives them for the test site's shop page and for common result markup. */
const SHOP = [
  '- heading "特产商城" [level=1, ref=e1]',
  '- table',
  '  - rowgroup',
  '    - row',
  '      - cell "吐鲁番葡萄干 Raisins 1kg" [ref=e15]',
  '      - cell "加入购物车" [ref=e18]',
  '        - button "加入购物车" [ref=e24] hint="in:吐鲁番葡萄干 Raisins 1kg 58.0"',
  '- paragraph',
  '  - StaticText "购物车："',
  '  - StaticText "1"',
  '  - StaticText " 件，合计 "',
  '  - StaticText "58.00"',
  '  - StaticText " 元"',
  '- button "保存购物车" [ref=e2]',
].join('\n');

const RESULTS = [
  '- heading "结果" [level=1, ref=e25]',
  '- paragraph',
  '  - StaticText "编号 "',
  '  - strong',
  '    - StaticText "D6177"',
  '- generic',
  '  - StaticText "订单 "',
  '  - link "D6178" [ref=e26]',
  '  - StaticText " 详情"',
  '- list',
  '  - listitem [level=1]',
  '    - ListMarker "• "',
  '    - StaticText "第一行 "',
  '    - emphasis',
  '      - StaticText "重点"',
  '    - StaticText " 结束"',
  '- LabelText',
  '  - StaticText "备注 "',
  '  - textbox "备注" [ref=e27]: x',
  '    - StaticText "x"',
].join('\n');

test('waitText returns the whole sentence its text is in, not the text node it starts in', () => {
  assert.equal(shows(SHOP, '合计'), '购物车：1 件，合计 58.00 元');
  assert.equal(shows(SHOP, '合计 58.00'), '购物车：1 件，合计 58.00 元', 'text that spans several nodes');
  assert.equal(shows(RESULTS, '编号'), '编号 D6177', 'a number in its own bold element stays in the line');
  assert.equal(shows(RESULTS, '订单'), '订单 D6178 详情', 'a link inside the line is part of it');
  assert.equal(shows(RESULTS, '第一行'), '第一行 重点 结束', 'a list item without its bullet');
  assert.equal(shows(RESULTS, '备注'), '备注', 'a field\'s value is not part of its label');
  assert.equal(shows(RESULTS, '结果'), '结果');
  assert.equal(shows(SHOP, '保存购物车'), '保存购物车', 'a control name when no plain text holds it');
  assert.equal(shows(SHOP, '没有这句'), undefined);
});

test('a long paragraph gives the sentence that holds the text', () => {
  const long = '- paragraph\n  - StaticText "' + '这是一段很长的说明文字，'.repeat(20) + '最后一句。订单号 D6190 已提交。感谢您的购买，' + '页面下方还有更多内容。'.repeat(10) + '"';
  assert.equal(shows(long, '订单号'), '订单号 D6190 已提交。');
});

test('a wait for any of several outcomes ends at the first that shows', async () => {
  const { runScript } = require('../../npm/lib/script-run');
  const call = async () => ({ snapshot: '- paragraph\n  - StaticText "没有找到订单 "\n  - strong\n    - StaticText "D9999"', origin: 'http://x/' });
  const started = Date.now();
  const done = await runScript(`return await web.waitText(['订单状态', '没有找到']);`, { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call });
  assert.equal(done.result, '没有找到订单 D9999');
  assert.ok(Date.now() - started < 2000, 'it does not wait out the time for the outcome that did not happen');
  await assert.rejects(runScript(`await web.waitText(['订单状态', '已发货'], 200);`, { browser: 'browser', native: 'desktop', flags: ['--session', 't'], call }),
    { code: 'TIMEOUT', message: /"订单状态" or "已发货"/ });
});
