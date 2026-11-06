'use strict';

const { randomUUID } = require('node:crypto');
const { existsSync, statSync, writeFileSync } = require('node:fs');
const { basename, isAbsolute } = require('node:path');

// Attach to the specific CDP target once. Releasing a button via the session's
// current tab after another tab becomes active could leave the original held.
async function withPage(boundTab, args, fn) {
  if (!args.session) throw new Error('Specify a named Chromium session.');
  if (['AGENT_BROWSER_ALLOWED_DOMAINS','AGENT_BROWSER_ACTION_POLICY','AGENT_BROWSER_CONFIRM_ACTIONS'].some(k=>process.env[k]))
    throw new Error('Direct Chromium gestures require a dedicated unrestricted session.');
  const { original, ab, check } = boundTab(args.session, args.tab);
  const url = new URL(ab('get', 'cdp-url').cdpUrl);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('A local Chromium session is required.');
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chromium connection timed out.')), 4000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Chromium connection failed.')); };
    });
    ws.onmessage = ({data}) => {
      const m = JSON.parse(data), entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id); clearTimeout(entry.timer);
      if (m.error) entry.reject(new Error(m.error.message)); else entry.resolve(m.result);
    };
    ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Chromium disconnected.')); } pending.clear(); };
    const send = (method, params, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' did not reply.')); }, 4000);
      pending.set(id, {resolve, reject, timer}); ws.send(JSON.stringify({id, method, params, sessionId}));
    });
    check();
    const {sessionId} = await send('Target.attachToTarget', {targetId:original.targetId, flatten:true});
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async (fn, ...params) => {
      const out = await call('Runtime.evaluate', { expression:'(' + fn.toString() + ')(...' + JSON.stringify(params) + ')', returnByValue:true, awaitPromise:true });
      if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception?.description ?? out.exceptionDetails.text).split('\n')[0]);
      return out.result.value;
    };
    return await fn({original, call, check, evaluate});
  } finally { ws.close(); }
}

function trackSurface(key, css, object, url, watchDrop) {
  if (window !== top || location.href !== url) throw new Error('The original page changed.');
  const one = selector => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw new Error('Expected one element matching ' + selector);
    return nodes[0];
  };
  const surface = one(css), item = object ? one(object) : null;
  if (item && !surface.contains(item)) throw new Error('The object is outside the surface.');
  const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
  const bounds = rect(surface);
  const state = { cancelled:false, over:null, files:null };
  function read() {
    if (state.cancelled || url !== location.href || one(css) !== surface || (item && one(object) !== item)) throw new Error('Gesture cancelled or original target changed.');
    const live = rect(surface);
    if (!bounds.width || !bounds.height || Object.keys(bounds).some(k => live[k] !== bounds[k])) throw new Error('Surface moved or changed size.');
    const obj = item && rect(item);
    return { bounds, object:obj, clip:{...bounds, x:bounds.x+scrollX, y:bounds.y+scrollY, scale:1}, files:state.files, accepted:state.over?.defaultPrevented === true };
  }
  const keydown = e => { if (e.key === 'Escape') state.cancelled = true; };
  const observeDrop = e => {
    if (!e.isTrusted || !e.composedPath().includes(surface)) return;
    if (e.type === 'dragover') state.over = e;
    else state.files = Array.from(e.dataTransfer.files, ({name,size,lastModified}) => ({name,size,lastModified}));
  };
  const clear = () => {
    clearTimeout(timer); window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('dragover',observeDrop,true); window.removeEventListener('drop',observeDrop,true); delete globalThis[key];
  };
  const hit = (x,y,source) => {
    const el = document.elementFromPoint(x,y);
    if (!el || el.closest('iframe,frame,object,embed') || !surface.contains(el) || (source && item && !item.contains(el))) throw new Error('The intended point is offscreen, embedded or covered.');
  };
  const timer = setTimeout(clear, 20000);
  globalThis[key] = { read, clear, hit };
  window.addEventListener('keydown', keydown, true);
  if (watchDrop) { window.addEventListener('dragover', observeDrop, true); window.addEventListener('drop', observeDrop, true); }
  return read();
}

function readSurface(key, method, ...args) {
  const state = globalThis[key];
  if (method === 'clear') return state?.clear();
  if (!state) throw new Error('Original document is gone.');
  const current = state.read();
  if (method === 'hit') state.hit(...args);
  return current;
}

function point(value, bounds) {
  if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(value ?? '')) throw new Error('Expected local CSS pixels as X,Y.');
  const [x,y] = value.split(',').map(Number);
  if (x >= bounds.width || y >= bounds.height) throw new Error('Point outside the surface.');
  return {x:bounds.x + x, y:bounds.y + y};
}

async function browserMove(boundTab, args) {
  if (!args.surface) throw new Error('Specify --surface, --from and --to.');
  if (args.after && existsSync(args.after)) throw new Error('Use a new --after image path.');
  return withPage(boundTab,args,async ({original,call,check,evaluate}) => {
    const key = 'move-' + randomUUID();
    const mouse = (type, p, buttons) => call('Input.dispatchMouseEvent',{type,...p,buttons,button:type === 'mouseMoved' ? 'none' : 'left',clickCount:type === 'mouseMoved' ? 0 : 1});
    let held = false, started = false, last;
    try {
      const initial = await evaluate(trackSurface,key,args.surface,args.object,original.url,false);
      const from = point(args.from,initial.bounds), to = point(args.to,initial.bounds);
      if (from.x === to.x && from.y === to.y) throw new Error('The drag endpoints must differ.');
      await evaluate(readSurface,key,'hit',to.x,to.y,false);
      await evaluate(readSurface,key,'hit',from.x,from.y,true);
      check(); last = from;
      await mouse('mouseMoved',last,0); held = true; started = true; await mouse('mousePressed',last,1);
      for (let i=1;i<=8;i++) {
        const next = {x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8};
        await evaluate(readSurface,key,'hit',next.x,next.y,false);
        if (i === 4 || i === 8) check();
        await mouse('mouseMoved',next,1);
        last=next;
      }
      await mouse('mouseReleased',last,0); held = false;
      const after = await evaluate(readSurface,key,'read');
      if (args.after) {
        const png = await call('Page.captureScreenshot',{format:'png',clip:after.clip});
        await evaluate(readSurface,key,'read'); check();
        writeFileSync(args.after,Buffer.from(png.data,'base64'),{flag:'wx'});
      }
      check();
      const out = {tab:original.tabId, effect:'gesture_dispatched', ...(args.after ? {after:args.after} : {})};
      if (args.object) {
        if (Math.abs((after.object.x-initial.object.x)-(to.x-from.x)) > 1 || Math.abs((after.object.y-initial.object.y)-(to.y-from.y)) > 1)
          throw new Error('Gesture dispatched; the object did not move by the requested distance.' + (args.after ? ' Inspect ' + args.after : ''));
        Object.assign(out,{effect:'object_moved',before:initial.object,object:after.object});
      }
      return out;
    } catch (err) {
      if (started) markDispatched(err);
      throw err;
    } finally {
      if (held) try { await mouse('mouseReleased',last,0); } catch { /* target gone */ }
      try { await evaluate(readSurface,key,'clear'); } catch { /* target gone */ }
    }
  });
}

function markDispatched(err) {
  Object.assign(err,{code:'ACTION_FAILED',disposition:{delivery:'delivered_unverified',retry:'unsafe'}});
}

async function dropFile(boundTab, args) {
  if (!args.input || !args.file || !isAbsolute(args.file)) throw new Error('Specify the drop zone and an absolute file path.');
  const stat = statSync(args.file);
  if (!stat.isFile()) throw new Error('Expected a regular file.');
  return withPage(boundTab,args,async ({original,call,check,evaluate}) => {
    const key = 'drop-' + randomUUID();
    let entered = false, dropped = false, x, y;
    try {
      const {bounds} = await evaluate(trackSurface,key,args.input,null,original.url,true);
      x=bounds.x+bounds.width/2; y=bounds.y+bounds.height/2;
      const data = {items:[],files:[args.file],dragOperationsMask:1};
      const event = type => call('Input.dispatchDragEvent',{type,x,y,data});
      check(); await evaluate(readSurface,key,'hit',x,y,false);
      entered = true; await event('dragEnter'); await event('dragOver');
      if (!(await evaluate(readSurface,key,'hit',x,y,false)).accepted) throw new Error('The drop zone did not accept the file drag.');
      check(); dropped = true; await event('drop'); entered = false;
      const {files} = await evaluate(readSurface,key,'read'); check();
      if (files?.length !== 1 || files[0].name !== basename(args.file) || files[0].size !== stat.size || files[0].lastModified !== Math.trunc(stat.mtimeMs)) throw new Error('Drop dispatched; the requested file was not confirmed at this element.');
      return {tab:original.tabId, targetId:original.targetId, received:files[0]};
    } catch (err) {
      if (dropped) markDispatched(err);
      throw err;
    } finally {
      if (entered) try { await call('Input.dispatchDragEvent',{type:'dragCancel',x,y,data:{items:[],dragOperationsMask:0}}); } catch { /* target gone */ }
      try { await evaluate(readSurface,key,'clear'); } catch { /* target gone */ }
    }
  });
}

module.exports = { browserMove, dropFile };
