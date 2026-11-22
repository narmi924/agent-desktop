'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, appendFileSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createWatches, fill, toastLines, lineWith } = require('../../npm/lib/host-watch');

const dir = mkdtempSync(join(tmpdir(), 'ad-watch-'));

/**
 * A stand-in for the WinEvent helper: it answers "list" with the windows in a JSON file, and every line written to
 * the events file (one JSON object each) is passed on as if Windows had reported it.
 */
function fakeHelper(windows) {
  const state = join(dir, 'helper-' + Math.random().toString(36).slice(2));
  writeFileSync(state + '.windows.json', JSON.stringify(windows));
  writeFileSync(state + '.events', '');
  const script = state + '.js';
  writeFileSync(script, [
    "const fs = require('fs');",
    'const base = ' + JSON.stringify(state) + ';',
    "console.log(JSON.stringify({ e: 'ready' }));",
    "let sent = 0;",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', d => { for (const line of d.split('\\n')) {",
    "  if (line.trim() === 'list') console.log(JSON.stringify({ e: 'list', windows: JSON.parse(fs.readFileSync(base + '.windows.json', 'utf8')) }));",
    "  if (line.startsWith('hash ')) console.log(JSON.stringify({ e: 'hash', hwnd: Number(line.slice(5)), hash: fs.existsSync(base + '.hash') ? fs.readFileSync(base + '.hash', 'utf8') : 'same' }));",
    "} });",
    "setInterval(() => { const lines = fs.readFileSync(base + '.events', 'utf8').split('\\n').filter(Boolean); for (; sent < lines.length; sent++) console.log(lines[sent]); }, 50);",
  ].join('\n'));
  return { command: [process.execPath, script], emit: event => appendFileSync(state + '.events', JSON.stringify(event) + '\n'),
    picture: hash => writeFileSync(state + '.hash', hash) };
}

function setup(windows = [], extra = {}) {
  const helper = fakeHelper(windows);
  const changes = [], jobs = [];
  const watches = createWatches({
    helperCommand: helper.command, onChange: w => changes.push({ id: w.id, state: w.state }),
    startJob: async body => { jobs.push(body); return { id: 'j-test' }; },
    readWindow: async () => ({ text: '' }), ...extra,
  });
  const fired = async (id, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const w = watches.get(id); if (w.state !== 'watching') return w; await delay(50); }
    return watches.get(id);
  };
  return { helper, watches, jobs, fired };
}

test('an argument template takes what was seen as plain data in every string, nested too', () => {
  assert.deepEqual(fill({ file: '{file}', note: '收到 {match}', list: ['{title}', 3], deep: { x: '{match}{match}' } }, { file: 'D:/a.pdf', match: '$(rm -rf) {title}', title: 'T' }),
    { file: 'D:/a.pdf', note: '收到 $(rm -rf) {title}', list: ['T', 3], deep: { x: '$(rm -rf) {title}$(rm -rf) {title}' } });
});

test('a toast payload gives its text lines with entities decoded', () => {
  assert.deepEqual(toastLines('<toast><visual><binding><text>下载完成</text><text hint-maxLines="2">a &amp; b &#25991;</text></binding></visual></toast>'), ['下载完成', 'a & b 文']);
});

test('text read from a picture matches when one character came out split, and an unrelated line does not', () => {
  const read = '- statictext "进度 50%"\n- text "冫且染完成 #3" [picture 396,154]';
  assert.match(lineWith(read, '渲染完成'), /冫且染完成/);
  assert.equal(lineWith(read, '导出完成'), undefined);
  assert.equal(lineWith('- text "崛渲染进度 label-1" [picture 1,2]', '渲染完成'), undefined, 'two characters apart is another phrase');
  assert.equal(lineWith('- text "崛渲染进度 label-mwkx-1" [picture 1,2]', '渲染完成 #label-mwkx-1'), undefined, 'a long phrase must match exactly');
  assert.equal(lineWith('- statictext "冫且染完成"', '渲染完成'), undefined, 'only picture lines are matched loosely');
  assert.match(lineWith('- statictext "已渲染完成 #3"', '渲染完成'), /已渲染完成/);
});

test('a window watch fires when the window shows, and a closing watch only after the window was seen', async () => {
  const { helper, watches, fired } = setup([{ hwnd: 1, title: '其他', cls: 'A', pid: 9 }]);
  try {
    const open = await watches.add({ window: '导出进度' });
    const gone = await watches.add({ window: '导出进度', gone: true });
    const typo = await watches.add({ window: '导出进渡', gone: true });
    helper.emit({ e: 'win', op: 'show', hwnd: 2, title: '导出进度 40%', cls: 'A', pid: 10, visible: true });
    assert.equal((await fired(open.id)).fired.match, '导出进度 40%');
    helper.emit({ e: 'win', op: 'gone', hwnd: 2, title: '', cls: '', pid: 0, visible: false });
    assert.equal((await fired(gone.id)).state, 'fired');
    await delay(300);
    assert.equal(watches.get(typo.id).state, 'watching', 'a window never seen is not reported as closed');
  } finally { watches.stopAll(); }
});

test('a file watch waits until a partial download is renamed, and a growing file until its size holds', async () => {
  const { watches, fired } = setup();
  try {
    const path = join(dir, 'report.pdf');
    const w = await watches.add({ file: path });
    writeFileSync(path + '.crdownload', 'x');
    await delay(1200);
    assert.equal(watches.get(w.id).state, 'watching');
    renameSync(path + '.crdownload', path);
    const done = await fired(w.id, 3000);
    assert.equal(done.state, 'fired');
    const placeholder = join(dir, 'video.mp4');
    const p = await watches.add({ file: placeholder });
    writeFileSync(placeholder, '');
    writeFileSync(placeholder + '.part', 'x');
    await delay(1800);
    assert.equal(watches.get(p.id).state, 'watching', 'an empty file beside its .part is still downloading, though its size holds');
    const growing = join(dir, 'log.txt');
    const g = await watches.add({ file: growing });
    for (let i = 0; i < 6; i++) { appendFileSync(growing, 'line\n'); await delay(300); }
    assert.equal(watches.get(g.id).state, 'watching', 'still growing');
    assert.equal((await fired(g.id, 4000)).state, 'fired');
  } finally { watches.stopAll(); }
});

test('a notification watch reads only toasts newer than itself and starts its routine with the text as data', async () => {
  const db = join(dir, 'wpn.db');
  const base = new DatabaseSync(db);
  base.exec("create table Notification (Id integer primary key, Type text, Payload blob)");
  base.prepare("insert into Notification (Type, Payload) values ('toast', ?)").run(Buffer.from('<toast><text>旧的 下载完成 x.pdf</text></toast>'));
  const { watches, jobs, fired } = setup([], { notificationDb: db });
  try {
    const w = await watches.add({ notification: '下载完成', then: 'upload-file', args: { note: '{match}' } });
    await delay(1200);
    assert.equal(watches.get(w.id).state, 'watching', 'an older toast does not count');
    base.prepare("insert into Notification (Type, Payload) values ('toast', ?)").run(Buffer.from('<toast><text>Chrome</text><text>下载完成 report.pdf</text></toast>'));
    const done = await fired(w.id, 3000);
    assert.equal(done.fired.match, '下载完成 report.pdf');
    assert.equal(done.job, 'j-test');
    assert.deepEqual(jobs, [{ routine: 'upload-file', args: { note: '下载完成 report.pdf' }, values: {} }], 'no --allow-final: the routine still stops before a final step');
    const agreed = await watches.add({ notification: '上传吧', then: 'upload-file', allowFinal: true });
    base.prepare("insert into Notification (Type, Payload) values ('toast', ?)").run(Buffer.from('<toast><text>上传吧</text></toast>'));
    await fired(agreed.id, 3000);
    assert.deepEqual(jobs[1].values, { 'allow-final': true }, 'the user agreed to the final step when the watch was set: the job goes through it');
  } finally { watches.stopAll(); base.close(); }
});

test('a text watch reads the window when something in it changed, and fires on the line that shows the text', async () => {
  let reads = 0;
  const { helper, watches, fired } = setup([{ hwnd: 5, title: '渲染进度', cls: 'A', pid: 50 }], {
    readWindow: async () => { reads++; return { text: reads < 2 ? '- statictext "进度 10%"' : '- statictext "渲染完成 #7"' }; },
  });
  try {
    const w = await watches.add({ text: '渲染完成', in: '渲染进度' });
    await watches.add({ window: '从不出现的窗口' });
    await delay(1000);
    assert.equal(reads, 1, 'read once when the watch starts');
    helper.emit({ e: 'dirty', pid: 51 });
    helper.emit({ e: 'win', op: 'title', hwnd: 9, title: '别的窗口', cls: 'A', pid: 52, visible: true });
    await delay(5200);
    assert.equal(reads, 1, 'a change in another process or another window, or the window list being read again, does not cause a read');
    helper.emit({ e: 'dirty', pid: 50 });
    const done = await fired(w.id, 3000);
    assert.equal(done.fired.match, '- statictext "渲染完成 #7"');
  } finally { watches.stopAll(); }
});

test('a drawn window whose picture changed while it was being read is read again', async () => {
  let reads = 0, helper;
  const made = setup([{ hwnd: 7, title: '自绘进度', cls: 'A', pid: 70 }], {
    readWindow: async () => {
      reads++;
      if (reads === 1) { helper.picture('done'); await delay(300); return { text: '- text "进度 90%" [picture 1,2]', drawn: true }; }
      return { text: '- text "渲染完成" [picture 1,2]', drawn: true };
    },
  });
  helper = made.helper;
  helper.picture('start');
  try {
    const w = await made.watches.add({ text: '渲染完成', in: '自绘进度' });
    const done = await made.fired(w.id, 9000);
    assert.equal(done.state, 'fired', 'the picture taken before the first read differs from the one after, so the window is read again');
    assert.equal(reads, 2);
  } finally { made.watches.stopAll(); }
});
