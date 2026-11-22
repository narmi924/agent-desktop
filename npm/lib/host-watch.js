'use strict';

const { spawn } = require('node:child_process');
const { statSync, existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

const TEXT_MIN_MS = 5000;
const TEXT_IDLE_MS = 60000;
const HASH_EVERY_MS = 2000;
const FILE_EVERY_MS = 500;
const FILE_STABLE_CHECKS = 2;
const RELIST_MS = 2000;
const PARTIAL = ['.crdownload', '.part', '.partial', '.download', '.tmp'];
/** Windows keeps every toast it shows in this database, also when the toast itself is hidden by Do Not Disturb. */
const NOTIFICATION_DB = () => join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The visible lines of a toast payload: the text of its <text> elements. */
function toastLines(payload) {
  const xml = Buffer.from(payload ?? '').toString('utf8');
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).trim()).filter(Boolean);
}

/**
 * The fewest single-character edits that turn `wanted` into some stretch of `line`. Text read from a picture gets a
 * character wrong or split now and then, and always in one place, so a short phrase is allowed one or two edits.
 */
function editsWithin(wanted, line) {
  const a = [...wanted.replace(/\s+/g, '')], b = [...line.replace(/\s+/g, '')];
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return Math.min(...previous);
}

const PICTURE_LINE = /\[picture \d+,\d+\]$/;

/** Edits allowed when text is read from a picture: one for up to six characters, two up to twelve, none beyond. */
function pictureSlack(wanted) {
  const length = [...wanted.replace(/\s+/g, '')].length;
  return length < 3 ? 0 : length <= 6 ? 1 : length <= 12 ? 2 : 0;
}

/** The line that shows the text: the exact text first, then, for a short phrase read from the picture, a line within its slack. */
function lineWith(text, wanted) {
  const lines = text.split('\n');
  const slack = pictureSlack(wanted);
  return lines.find(l => l.includes(wanted)) ?? (slack
    ? lines.find(l => PICTURE_LINE.test(l) && editsWithin(wanted, l.replace(PICTURE_LINE, '')) <= slack) : undefined);
}

function newId() {
  return 'w' + Date.now().toString(36).slice(-6) + randomBytes(2).toString('hex');
}

/** Replaces {match}, {title} and {file} in every string of an argument template. What was read on screen is data here, never a command. */
function fill(template, found) {
  const swap = value => typeof value === 'string' ? value.replace(/\{(match|title|file)\}/g, (_, key) => String(found[key] ?? '')) :
    Array.isArray(value) ? value.map(swap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)])) : value;
  return swap(template ?? {});
}

/**
 * The watches the host keeps: a window that opens or closes, text that shows or goes in a named window, a
 * notification whose text matches, a file that finishes growing. Window changes come from a WinEvent helper that costs
 * nothing while nothing changes; a window is read only after something in it changed, at most every five seconds.
 */
function createWatches({ helperPath, readWindow, startJob, onChange, now = () => Date.now(), onForeign = () => {},
  helperCommand = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath], notificationDb = NOTIFICATION_DB() }) {
  const watches = new Map();
  const windows = new Map();
  let helper, buffer = '', timer, ready;
  const pendingText = new Map();
  let notices, listedAt = 0;

  const active = () => [...watches.values()].filter(w => w.state === 'watching');
  const summary = w => ({ id: w.id, state: w.state, when: w.when, ...(w.then ? { then: w.then.routine } : {}), created: w.created,
    ...(w.fired ? { fired: w.fired } : {}), ...(w.job ? { job: w.job } : {}), ...(w.error ? { error: w.error } : {}) });

  function send(line) { if (helper && !helper.killed) helper.stdin.write(line + '\n'); }

  /** Starts the WinEvent helper once and keeps it while the host runs: it costs nothing while nothing changes, and a
   * restart would take two seconds in which a watch would miss what happened. Resolves once the window list is in. */
  function startHelper() {
    if (helper) return ready;
    let listed;
    ready = new Promise(resolve => { listed = resolve; });
    ready.resolve = listed;
    helper = spawn(helperCommand[0], helperCommand.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        try { onHelper(JSON.parse(line)); } catch { /* a malformed line is skipped */ }
      }
    });
    helper.on('exit', () => { helper = undefined; clearInterval(timer); if (active().length) setTimeout(() => { if (active().length) startHelper(); }, 1000); });
    timer = setInterval(tick, FILE_EVERY_MS);
    return ready;
  }

  function stopHelper() {
    clearInterval(timer);
    if (helper) { helper.kill(); helper = undefined; }
    windows.clear();
  }

  function remember(w) {
    if (w.op === 'gone' || w.visible === false) windows.delete(w.hwnd); else windows.set(w.hwnd, { hwnd: w.hwnd, title: w.title, cls: w.cls, pid: w.pid });
  }

  const titled = needle => [...windows.values()].filter(w => w.title && w.title.includes(needle));

  function onHelper(message) {
    if (message.e === 'ready') return send('list');
    if (message.e === 'list') {
      windows.clear();
      for (const w of message.windows) remember(w);
      for (const w of active()) evaluate(w, 'list');
      ready?.resolve?.();
      return;
    }
    if (message.e === 'win') {
      remember(message);
      for (const w of active()) {
        if (w.kind === 'window') evaluate(w, 'window');
        if (w.kind === 'text' && (message.title?.includes(w.spec.in) || titled(w.spec.in).some(win => win.pid === message.pid))) w.dirty = true;
      }
      return;
    }
    if (message.e === 'dirty') {
      for (const w of active()) if (w.kind === 'text' && titled(w.spec.in).some(win => win.pid === message.pid)) w.dirty = true;
      return;
    }
    if (message.e === 'foreign') return onForeign(message.what);
    if (message.e === 'lock') {
      for (const resolve of lockWaiters.splice(0)) resolve(message.locked);
      return;
    }
    if (message.e === 'hash') {
      const resolve = pendingText.get('hash:' + message.hwnd);
      if (resolve) { pendingText.delete('hash:' + message.hwnd); resolve(message.hash); }
    }
  }

  function hashOf(hwnd) {
    return new Promise(resolve => {
      pendingText.set('hash:' + hwnd, resolve);
      send('hash ' + hwnd);
      setTimeout(() => { if (pendingText.delete('hash:' + hwnd)) resolve(undefined); }, 3000).unref();
    });
  }

  function evaluate(w, why) {
    if (w.state !== 'watching') return;
    if (w.kind === 'window') {
      const open = titled(w.spec.title);
      if (open.length) w.seen = true;
      if (!w.spec.gone && open.length) fire(w, { title: open[0].title, match: open[0].title });
      if (w.spec.gone && !open.length && w.seen) fire(w, { title: w.spec.title, match: w.spec.title });
    }
    if (w.kind === 'text' && why === 'start') w.dirty = true;
  }

  /** One look at a text watch at a time: a picture comparison and a read never overlap for the same watch. */
  async function checkText(w) {
    if (w.busy) return;
    w.busy = true;
    try { await lookAtText(w); } finally { w.busy = false; }
  }

  async function lookAtText(w) {
    const t = now();
    const win = titled(w.spec.in)[0];
    if (!win) return;
    if (w.drawn && t - (w.hashedAt ?? 0) >= HASH_EVERY_MS) {
      w.hashedAt = t;
      const hash = await hashOf(win.hwnd);
      w.hashes = (w.hashes ?? 0) + 1;
      if (!hash) w.blankHashes = (w.blankHashes ?? 0) + 1;
      if (hash && hash !== w.hash) { if (w.hash !== undefined) w.dirty = true; w.hash = hash; }
    }
    const due = (w.dirty && t - (w.readAt ?? 0) >= w.spec.every) || t - (w.readAt ?? 0) >= TEXT_IDLE_MS;
    if (!due) return;
    w.dirty = false;
    w.readAt = t;
    try {
      const before = await hashOf(win.hwnd);
      if (before) { w.hash = before; w.hashedAt = now(); }
      w.hashes = (w.hashes ?? 0) + 1;
      const began = now();
      const read = await readWindow(win, w.spec);
      w.readMs = [...(w.readMs ?? []), now() - began].slice(-5);
      w.reads = (w.reads ?? 0) + 1;
      w.drawn = Boolean(read.drawn);
      const line = lineWith(read.text, w.spec.text);
      if (line) w.seen = true;
      if (!w.spec.gone && line) fire(w, { title: win.title, match: line.trim() });
      if (w.spec.gone && !line && w.seen) fire(w, { title: win.title, match: w.spec.text });
    } catch (err) {
      w.lastError = err.message;
    }
  }

  function checkFile(w) {
    const path = w.spec.file;
    let size;
    try { const s = statSync(path); size = s.isFile() ? s.size : undefined; } catch { size = undefined; }
    const partial = PARTIAL.some(ext => existsSync(path + ext));
    if (partial) w.partialSeen = true;
    if (size === undefined || partial) { w.stable = 0; w.size = size; return; }
    if (w.partialSeen) return fire(w, { file: path, match: path, size });
    w.stable = size === w.size ? (w.stable ?? 0) + 1 : 0;
    w.size = size;
    if (w.stable >= FILE_STABLE_CHECKS) fire(w, { file: path, match: path, size });
  }

  /** New toasts since the last look, read only when the notification database changed. */
  function checkNotifications() {
    const files = ['', '-wal'].map(end => { try { return statSync(notificationDb + end).mtimeMs; } catch { return 0; } }).join('/');
    if (files === notices.stamp) return;
    notices.stamp = files;
    const rows = notices.since.all(notices.last);
    for (const row of rows) {
      notices.last = row.Id > notices.last ? row.Id : notices.last;
      const lines = toastLines(row.Payload);
      for (const w of active()) {
        if (w.kind !== 'notification') continue;
        const line = lines.find(l => l.includes(w.spec.text)) ?? (lines.join(' ').includes(w.spec.text) ? lines.join(' ') : undefined);
        if (line) fire(w, { match: line });
      }
    }
  }

  function openNotifications() {
    if (notices) return;
    if (!existsSync(notificationDb)) throw Object.assign(new Error('Windows keeps no notification list for this user, so notifications cannot be watched.'), { code: 'NOTIFICATIONS_UNAVAILABLE' });
    const db = new DatabaseSync(notificationDb, { readOnly: true });
    const since = db.prepare("select Id, Payload from Notification where Type = 'toast' and Id > ? order by Id");
    since.setReadBigInts(true);
    const top = db.prepare('select max(Id) as last from Notification');
    top.setReadBigInts(true);
    notices = { db, since, last: top.get().last ?? 0n, stamp: '' };
  }

  function tick() {
    if (active().some(w => w.kind === 'window') && now() - listedAt >= RELIST_MS) {
      listedAt = now();
      send('list');
    }
    if (notices && active().some(w => w.kind === 'notification')) {
      try { checkNotifications(); } catch { /* a locked database is read on the next tick */ }
    }
    for (const w of active()) {
      if (w.kind === 'file') checkFile(w);
      if (w.kind === 'text') checkText(w);
    }
  }

  async function fire(w, found) {
    if (w.state !== 'watching') return;
    w.state = 'fired';
    w.fired = { at: new Date(now()).toISOString(), ...found };
    if (w.then) {
      try {
        const job = await startJob({ routine: w.then.routine, args: fill(w.then.args, found),
          values: { ...(w.then.values ?? {}), ...(w.then.allow_final ? { 'allow-final': true } : {}) } });
        w.job = job.id;
      } catch (err) { w.error = { code: err.code ?? 'ERROR', message: err.message }; }
    }
    onChange(w);
  }

  async function add(spec) {
    const kinds = ['window', 'text', 'notification', 'file'].filter(k => spec[k] !== undefined);
    if (kinds.length !== 1) throw Object.assign(new Error('Give exactly one of --window TITLE, --text TEXT --in WINDOW, --notification TEXT, --file PATH.'), { code: 'INVALID_ARGS' });
    const kind = kinds[0];
    if (kind === 'text' && !spec.in) throw Object.assign(new Error('--text needs --in WINDOW: the window, by part of its title, whose text to watch.'), { code: 'INVALID_ARGS' });
    const every = Math.max(TEXT_MIN_MS, Number(spec.every) || TEXT_MIN_MS);
    const when = kind === 'window' ? 'window "' + spec.window + '" ' + (spec.gone ? 'closes' : 'opens')
      : kind === 'text' ? '"' + spec.text + '" ' + (spec.gone ? 'goes from' : 'shows in') + ' window "' + spec.in + '"'
      : kind === 'notification' ? 'a notification shows "' + spec.notification + '"' : 'file "' + spec.file + '" is complete';
    const w = {
      id: newId(), kind, when, state: 'watching', created: new Date(now()).toISOString(),
      spec: kind === 'window' ? { title: spec.window, gone: Boolean(spec.gone) } : kind === 'text' ? { text: spec.text, in: spec.in, gone: Boolean(spec.gone), every }
        : kind === 'notification' ? { text: spec.notification } : { file: spec.file },
      ...(spec.then ? { then: { routine: spec.then, args: spec.args ?? {}, ...(spec.allowFinal ? { allow_final: true } : {}), ...(spec.values ? { values: spec.values } : {}) } } : {}),
    };
    if (kind === 'notification') openNotifications();
    await startHelper();
    watches.set(w.id, w);
    evaluate(w, 'start');
    onChange(w);
    return summary(w);
  }

  function remove(id) {
    const w = watches.get(id);
    if (!w) throw Object.assign(new Error('No watch is numbered "' + id + '".'), { code: 'WATCH_NOT_FOUND' });
    if (w.state === 'watching') w.state = 'removed';
    onChange(w);
    return summary(w);
  }

  function get(id) {
    const w = watches.get(id);
    if (!w) throw Object.assign(new Error('No watch is numbered "' + id + '".'), { code: 'WATCH_NOT_FOUND' });
    return { ...summary(w), ...(w.kind === 'text' ? { reads: w.reads ?? 0, drawn: Boolean(w.drawn), pictures_compared: w.hashes ?? 0, ...(w.blankHashes ? { pictures_not_taken: w.blankHashes } : {}), ...(w.readMs ? { read_ms: w.readMs } : {}), ...(w.lastError ? { last_error: w.lastError } : {}) } : {}) };
  }

  /** Whether input now goes to the lock screen; true when it cannot be told. */
  let lockAsked;
  const lockWaiters = [];
  /** Callers at the same moment share one question to the helper; the answer is good for half a second. */
  function locked() {
    if (lockAsked && now() - lockAsked.at < 500) return lockAsked.answer;
    const answer = startHelper().then(() => new Promise(resolve => {
      lockWaiters.push(resolve);
      send('lock');
      setTimeout(() => {
        const at = lockWaiters.indexOf(resolve);
        if (at >= 0) { lockWaiters.splice(at, 1); resolve(true); }
      }, 3000).unref();
    }));
    lockAsked = { at: now(), answer };
    return answer;
  }

  async function guard(on) {
    await startHelper();
    send(on ? 'guard on' : 'guard off');
  }

  return {
    add, remove, get, summary, locked, guard,
    list: () => ({ watches: [...watches.values()].map(summary) }),
    busy: () => active().length > 0,
    stopHelperNow: () => stopHelper(),
    stopAll: () => { for (const w of active()) w.state = 'removed'; stopHelper(); },
  };
}

module.exports = { createWatches, fill, toastLines, lineWith, editsWithin };
