'use strict';

const { closeSync, existsSync, openSync, readSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { crc32 } = require('node:zlib');

const keyword = Buffer.from('agent-desktop-frame\0');
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);

function storeImage(png, token, output) {
  if (!png.subarray(0,8).equals(pngSignature) || png.toString('ascii',12,16) !== 'IHDR') throw new Error('Expected a PNG window capture.');
  const data = Buffer.concat([keyword,Buffer.from(token)]);
  const body = Buffer.concat([Buffer.from('tEXt'),data]);
  const chunk = Buffer.alloc(12+data.length);
  chunk.writeUInt32BE(data.length); body.copy(chunk,4); chunk.writeUInt32BE(crc32(body),chunk.length-4);
  writeFileSync(output,Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]),{flag:'wx'});
}

function imageToken(path) {
  const fd = openSync(path,'r');
  const invalid = () => new Error('Use an unedited PNG produced by view.');
  try {
    // view places the handle immediately after IHDR. Do not load the pixels
    // just to translate two mouse coordinates.
    const head=Buffer.alloc(41);
    if (readSync(fd,head,0,41,0)!==41 || !head.subarray(0,8).equals(pngSignature) || head.toString('ascii',37,41)!=='tEXt') throw invalid();
    const n=head.readUInt32BE(33);
    if (n<=keyword.length || n>65536+keyword.length) throw invalid();
    const chunk=Buffer.alloc(n+4);
    if (readSync(fd,chunk,0,n+4,41)!==n+4 || !chunk.subarray(0,keyword.length).equals(keyword) ||
        crc32(chunk.subarray(0,n),crc32(head.subarray(37)))!==chunk.readUInt32BE(n)) throw invalid();
    const token=chunk.toString('ascii',keyword.length,n), frame=decoded(token);
    if (head.readUInt32BE(16) !== (frame.region?.[2] ?? frame.width) || head.readUInt32BE(20) !== (frame.region?.[3] ?? frame.height)) throw invalid();
    return token;
  } finally { closeSync(fd); }
}

function windowOf(ad, id, app) {
  const wins = ad('list-windows').filter(w => w.visible && !w.minimized && (id ? w.id === id : w.app_name === app));
  if (wins.length !== 1 || !wins[0].process_instance) throw new Error('Expected one visible window with an identifiable owner; use list-windows and pass --window.');
  return wins[0];
}

function edit(ad, write, {window, app, document, field, value, stdin}) {
  if (Boolean(window) === Boolean(app) || !document || (value !== undefined) === Boolean(stdin)) throw new Error('Specify the window or app, --document, and exactly one of --value or --stdin.');
  if (document === '*') throw new Error('Provide a document name or a nonempty prefix.');
  const win = windowOf(ad,window,app);
  const snapshot = ad('snapshot','--window-id',win.id,'--max-depth','50','--compact');
  if (!snapshot.complete) throw new Error('The document tree is incomplete; inspect the window.');
  const all = [], writable = [];
  let hasDocument = false;
  const visit = (n, inDocument = false, inChrome = false) => {
    all.push(n);
    inDocument ||= n.role === 'document' && Boolean(n.name);
    hasDocument ||= inDocument;
    inChrome ||= ['toolbar','menubar','menu','dialog'].includes(n.role);
    if (!inChrome && ['textfield','textarea'].includes(n.role) && n.ref_id && n.available_actions?.includes('SetValue'))
      writable.push({n,inDocument});
    (n.children ?? []).forEach(child=>visit(child,inDocument,inChrome));
  };
  visit(snapshot.tree);
  const tabs = all.filter(n => n.role === 'tab' && n.ref_id && (document.endsWith('*') ? n.name?.startsWith(document.slice(0,-1)) : n.name === document));
  if (tabs.length !== 1 || !tabs[0].states?.includes('selected')) throw new Error('The document must identify one tab that is already selected.');
  const editors = writable.filter(({n,inDocument}) => (!hasDocument || inDocument) &&
    (field ? n.name === field : inDocument || n.states?.includes('focused'))).map(({n})=>n);
  if (editors.length !== 1) throw new Error('Expected one writable editor; specify its exact name with --field.');
  if (!same(win,windowOf(ad,win.id))) throw new Error('The original window changed.');
  if (stdin && process.stdin.isTTY) throw new Error('Pipe the replacement text to --stdin.');
  const contents = stdin ? readFileSync(0) : Buffer.from(value);
  const report = write(['set-value',editors[0].ref_id,'--selected-tab',tabs[0].ref_id,'--stdin'],contents);
  return {window:win.id,document:tabs[0].name,field:editors[0].name,delivery:report.disposition?.delivery ?? report.after_action?.disposition?.delivery};
}

function same(a, b) {
  return a.id === b.id && a.pid === b.pid && a.process_instance === b.process_instance && a.title === b.title;
}

function view(ad, { window, app, output, region, popups }) {
  if (Boolean(window) === Boolean(app) || !output) throw new Error('Provide either --window or --app, and --output for the window image.');
  const initial = windowOf(ad, window, app);
  const img = ad('screenshot', '--window-id', initial.id, ...(region ? ['--region',region] : []));
  const current = windowOf(ad, initial.id);
  if (!same(initial, current) || initial.bounds?.width !== current.bounds?.width || initial.bounds?.height !== current.bounds?.height) throw new Error('The window changed during capture.');
  const frame = Buffer.from(JSON.stringify({ window: current, width: img.full_size?.[0] ?? img.width, height: img.full_size?.[1] ?? img.height,
    scale: img.scale_factor, ...(region ? {region:region.split(',').map(Number)} : {}) })).toString('base64url');
  const path = resolve(output);
  storeImage(Buffer.from(img.data,'base64'),frame,path);
  const result = { window: current.id, title: current.title, path, width: img.width, height: img.height };
  if (!popups) return result;
  const owned = ad('list-windows').filter(w => w.pid === current.pid && w.id !== current.id && w.visible && !w.minimized && w.process_instance === current.process_instance);
  const base = path.replace(/\.png\$/i, '');
  result.popups = owned.map((w, index) => ({ layer: owned.length - index, ...view(ad, { window: w.id, output: base + '-popup' + (index + 1) + '.png' }) }));
  return result;
}

function decoded(token) {
  if (!token || token.length > 65536) throw new Error('Expected a frame from view.');
  try { return JSON.parse(Buffer.from(token, 'base64url').toString()); }
  catch { throw new Error('Invalid frame; capture with view again.'); }
}

function humanFlags({ human, seed }) {
  if (human !== undefined && !['natural', 'careful'].includes(human)) throw new Error('--human must be natural or careful.');
  return [...(human ? ['--human', human] : []), ...(seed ? ['--seed', seed] : [])];
}

function pointForText(ad, frame, text, nth) {
  const found = ad('ocr', '--image', resolve(frame), '--find', text).matches ?? [];
  if (nth !== undefined) {
    if (!/^[1-9]\d*$/.test(nth)) throw new Error('--nth must be a positive integer.');
    if (!found[Number(nth) - 1]) throw new Error('No match at position ' + nth + ' for ' + text + '.');
    return found[Number(nth) - 1].center.x + ',' + found[Number(nth) - 1].center.y;
  }
  if (found.length !== 1) throw new Error('Expected one place showing ' + text + ', found ' + found.length + '. Use --nth to choose.');
  return found[0].center.x + ',' + found[0].center.y;
}

function tap(ad, args) {
  const { frame, text, button = 'left', count = '1' } = args;
  if (!frame || Boolean(args.at) === Boolean(text)) throw new Error('Provide --frame and either --at in image pixels or --text to find.');
  imageToken(frame);
  const at = args.at ?? pointForText(ad, frame, text, args.nth);
  const report = ad('--headed', '--when-idle', '600', ...humanFlags(args), 'mouse-click', '--frame', resolve(frame), '--xy', at, '--button', button, '--count', count);
  return { delivery: report.disposition?.delivery, x: report.x, y: report.y, window: report.window };
}

function move(ad, args) {
  const { frame, from, to, after } = args;
  const destination = args['to-frame'] ?? frame;
  if (!frame || !from || !to) throw new Error('Provide --frame, --from and --to in captured image pixels.');
  if (after && existsSync(after)) throw new Error('Use a new --after image path.');
  const srcToken = imageToken(frame);
  const destToken = destination === frame ? srcToken : imageToken(destination);
  const target = decoded(destToken);
  const report = ad('--headed', ...humanFlags(args), 'drag', '--from-frame', resolve(frame), '--to-frame', resolve(destination), '--from-xy', from, '--to-xy', to,
    '--drop-delay', target.window.id === decoded(srcToken).window.id ? '0' : '700');
  const result = { delivery: report.disposition.delivery, source: report.source_window, destination: report.destination_window };
  if (after) {
    try {
      if (!same(windowOf(ad, target.window.id), target.window)) throw new Error('The destination changed.');
      result.after = view(ad, { window: target.window.id, output: after, region:target.region?.join(',') });
      if (!same(decoded(imageToken(result.after.path)).window, target.window)) throw new Error('The destination changed.');
    } catch (err) {
      throw Object.assign(new Error('Drag already dispatched; after-image unavailable: ' + err.message),
        {code:'ACTION_FAILED', disposition:{delivery:result.delivery,retry:'unsafe'}});
    }
  }
  return result;
}

module.exports = { view, move, edit, tap };
