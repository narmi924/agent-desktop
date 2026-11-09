'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { readFileSync } = require('node:fs');

function webUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) || (url.protocol==='file:' && !url.hostname && /^\/[A-Za-z]:\//.test(url.pathname))) return url.href;
  } catch { /* Windows controls may contain plain text. */ }
}

function pending(message) {
  return Object.assign(new Error(message), {code:'PAGE_NOT_READY'});
}

function browserWindow(ad, id, owner) {
  const windows = (id ? ad('list-windows') : ad('list-windows', '--app', 'chrome.exe'))
    .filter(w => w.visible && !w.minimized && (!id || w.id === id));
  const win = windows.find(w => w.is_focused) ?? (windows.length === 1 && windows[0]);
  if (!win || !win.process_instance) throw new Error('Select a visible Chrome window or pass --window from list-windows.');
  if (owner && win.process_instance !== owner) throw new Error('The original browser window closed.');
  return win;
}

function readPage(ad, win, bounds=false) {
  let snapshot;
  try { snapshot = ad('snapshot', '--window-id', win.id, '--compact', '--max-depth', '50', ...(bounds ? ['--include-bounds'] : [])); }
  catch (err) {
    if (err.code === 'ACTION_FAILED' && err.details?.faults?.length) throw pending(err.message);
    throw err;
  }
  if (snapshot.window?.id !== win.id || !ad('list-windows').some(w => w.id === win.id && w.process_instance === win.process_instance)) throw new Error('The browser window changed.');
  if (!snapshot.complete) throw pending('The page tree is incomplete.');
  const documents = [], groups = [];
  function visit(node) {
    if (node.role === 'document' && webUrl(node.value)) { documents.push(node); return; }
    if (node.role === 'tablist') {
      const tabs = (node.children ?? []).filter(n => n.role === 'tab' && n.tab_instance);
      for (const tab of tabs.filter(n => n.states?.includes('selected'))) groups.push({tab,tabs});
      for (const child of node.children ?? []) if(child.role!=='tab') visit(child);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(snapshot.tree);
  if (documents.length !== 1) throw pending('Expected one visible web document in this window.');
  const doc = documents[0];
  const matching = groups.length === 1 ? groups : groups.filter(({tab}) => doc.name && tab.name?.startsWith(doc.name) &&
    (tab.name.length === doc.name.length || /^[\s\p{P}]/u.test(tab.name.slice(doc.name.length))));
  if (matching.length !== 1) throw pending('Cannot identify the selected browser tab for this document.');
  const {tab,tabs} = matching[0];
  const controls = [], text = [];
  function collect(node) {
    if (node.role === 'document') return;
    if (node.name && ['heading','statictext'].includes(node.role) && !(node.children ?? []).length) text.push(node.name);
    if (node.ref_id && node.name && (node.available_actions ?? []).some(a => ['Click','SetValue','Select','Toggle'].includes(a))) {
      controls.push({ref:node.ref_id, role:node.role, name:node.name, ...(node.role === 'link' && webUrl(node.value) ? {href:webUrl(node.value)} : {})});
    }
    for (const child of node.children ?? []) collect(child);
  }
  for (const child of doc.children ?? []) collect(child);
  return {doc, window:win.id, owner:win.process_instance, instance:tab.tab_instance, tab:tab.ref_id,
    instances:tabs.map(t=>t.tab_instance), title:doc.name, url:webUrl(doc.value), controls, text:text.join('\n')};
}

function result(state) {
  const {window,owner,instance,url,title,controls} = state;
  const page = Buffer.from(JSON.stringify({window,owner,instance,url})).toString('base64url');
  return {page,window,title,url,tab:state.tab,controls,text:state.text};
}

async function readyPage(ad, id, owner, bounds=false) {
  const win = browserWindow(ad,id,owner);
  const until = Date.now() + 2500;
  for (;;) {
    try { return readPage(ad,win,bounds); }
    catch (err) {
      if (err.code !== 'PAGE_NOT_READY' || Date.now() >= until) throw err;
      await delay(100);
    }
  }
}

async function source(ad, page, bounds=false) {
  let saved;
  try { saved = JSON.parse(Buffer.from(page, 'base64url').toString()); } catch { /* validated below */ }
  if (!saved?.window || !saved.owner || !saved.instance || !webUrl(saved.url)) throw new Error('Use the page handle returned by current or follow.');
  const state = await readyPage(ad, saved.window, saved.owner, bounds);
  if (state.instance !== saved.instance) throw new Error('The original tab is no longer selected. Run current to take over another tab.');
  return {state,saved};
}

async function current(ad, {window,page}) {
  if (window && page) throw new Error('Choose either --window or --page.');
  return result(page ? (await source(ad,page)).state : await readyPage(ad,window));
}

async function editPage(ad, write, {page,field,value,stdin,app,window,document}) {
  if (!field || app || window || document || (value !== undefined) === Boolean(stdin)) throw new Error('Use --page, --field, and either --value or --stdin.');
  if (stdin && process.stdin.isTTY) throw new Error('Pipe replacement text to --stdin.');
  const {state,saved} = await source(ad,page);
  if (state.url !== saved.url) throw new Error('The page navigated. Read it with current --page before acting.');
  const fields = state.controls.filter(n => n.name === field && ['textfield','textarea'].includes(n.role));
  if (fields.length !== 1) throw new Error('Expected one named writable page field.');
  const action = write(['set-value',fields[0].ref,'--selected-tab',state.tab,'--stdin'], stdin ? readFileSync(0) : Buffer.from(value));
  return {page,url:state.url,field,delivery:action.disposition?.delivery ?? action.after_action?.disposition?.delivery};
}

async function follow(ad, {page,link,button,visible,human,seed,'expect-url':expectedUrl}, physicalPointer) {
  if (!page || Boolean(link) === Boolean(button) || (button && !expectedUrl) || (expectedUrl && !webUrl(expectedUrl)))
    throw new Error('Provide --page with --link, or --button with an absolute --expect-url.');
  const {state,saved} = await source(ad,page,Boolean(visible));
  if (state.url !== saved.url) throw new Error('The page navigated. Read it with current --page before acting.');
  const targets = state.controls.filter(n => n.role === (link ? 'link' : 'button') && n.name === (link || button));
  if (targets.length !== 1) throw new Error('Expected one named navigation control.');
  const destination = webUrl(expectedUrl) ?? targets[0].href;
  if (!destination) throw new Error('Supply --expect-url for a control without a web destination.');
  const [target] = targets;
  const action = visible ? physicalPointer(ad,state,'click',{on:target.name, role:target.role, ref:target.ref, human, seed}) :
    ad('click',target.ref,'--selected-tab',state.tab);
  try {
    const until = Date.now() + 7000;
    do {
      let next;
      try { next = readPage(ad,browserWindow(ad,state.window,state.owner)); }
      catch (err) {
        if (err.code !== 'PAGE_NOT_READY') throw err;
        await delay(100);
        continue;
      }
      const added = next.instances.filter(id => !state.instances.includes(id));
      const original = next.instance === state.instance;
      if (!original && (added.length !== 1 || added[0] !== next.instance || !next.instances.includes(state.instance))) {
        throw new Error('A different tab became selected.');
      }
      if (next.url === destination && (!original || next.url !== state.url)) {
        return {...result(next), navigation:original ? 'same-tab' : 'new-tab'};
      }
      await delay(100);
    } while (Date.now() < until);
    throw new Error('The expected destination was not observed.');
  } catch (err) {
    throw Object.assign(new Error('Control already clicked. '+err.message+' Inspect current before repeating.'),
      {code:'ACTION_FAILED', disposition:{delivery:action.disposition?.delivery ?? 'delivered_unverified',retry:'unsafe'}});
  }
}

module.exports = {current, follow, editPage, source, result};
