'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { pageState, descendants, bringToFront, physicalArgs } = require('./page-input');

function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)};
}

function matches(root, name, {visible = true, receiver = false, role} = {}) {
  if (!root.bounds) throw new Error('The browser did not expose the region bounds.');
  const found = [];
  function visit(node, clip, path, panel) {
    const bounds = node.bounds;
    const hasArea = bounds?.width > 0 && bounds.height > 0;
    const part = hasArea ? intersection(clip, bounds) : clip;
    if (hasArea && (node.role === 'document' || node.available_actions?.includes('Scroll'))) {
      clip = part;
      panel = path;
    }
    const first = found.length;
    for (const [index, child] of (node.children ?? []).entries()) {
      if (child.role !== 'document') visit(child, clip, [...path, index], panel);
    }
    const actionable = node.ref_id && !node.states?.includes('disabled') &&
      node.available_actions?.some(a => ['Click', 'Toggle', 'Expand', 'Select', 'SetValue', 'SetFocus'].includes(a));
    if (found.length === first && node.name === name && (!role || node.role === role) && hasArea && (!receiver || actionable) &&
      (!visible || (part.width > 0 && part.height > 0 && !node.states?.some(s => s === 'offscreen' || s === 'hidden')))) {
      found.push({bounds, clip: part, panel, ref: actionable ? node.ref_id : undefined});
    }
  }
  visit(root, root.bounds, [], []);
  return found;
}

function one(root, name, options = {}) {
  const found = matches(root, name, options);
  if (options.nth !== undefined) {
    if (!/^[1-9]\d*$/.test(options.nth) || !Number.isSafeInteger(Number(options.nth))) throw new Error('--nth must be a positive integer.');
    const match = found[Number(options.nth) - 1];
    if (!match) throw new Error('No visible match at position ' + options.nth + ' for ' + name + '.');
    return match;
  }
  if (!found.length && options.visible !== false && matches(root, name, {...options, visible: false}).length) {
    throw Object.assign(new Error(name + ' is on the page but outside the part that is on screen. Scroll it into view first: wheel --until with its name.'),
      {code: 'NOT_ON_SCREEN'});
  }
  if (found.length !== 1) throw new Error('Expected one target named ' + name + ', found ' + found.length + '.');
  return found[0];
}

function center(rect) {
  return {x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2)};
}

const scrolls = node => node.role === 'document' || node.available_actions?.includes('Scroll');
const holds = (rect, point) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;

/** The visible part of the scroll region at `path`: its box cut by every scrolling box around it. */
function panelClip(doc, path) {
  let node = doc, clip = doc.bounds;
  for (const index of path) {
    node = node?.children?.[index];
    if (node?.bounds?.width > 0 && node.bounds.height > 0 && scrolls(node)) clip = intersection(clip, node.bounds);
  }
  return clip;
}

/**
 * Where the cursor rests while a region is scrolled: a place in the region that no smaller scrolling
 * box inside it covers. It is the same place every time, so a second scroll of the region does not
 * move the cursor again, the way a hand stays put while the wheel turns.
 */
function restingPoint(panel, clip, fallback) {
  const inner = [];
  (function visit(node) {
    for (const child of node.children ?? []) {
      if (child.bounds?.width > 0 && child.bounds.height > 0 && scrolls(child)) inner.push(child.bounds);
      visit(child);
    }
  })(panel);
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.35, 0.5], [0.65, 0.5]]) {
    const point = {x: Math.floor(clip.x + clip.width * fx), y: Math.floor(clip.y + clip.height * fy)};
    if (clip.width > 0 && clip.height > 0 && !inner.some(rect => holds(rect, point))) return point;
  }
  return fallback;
}

function panelAt(doc, path) {
  return path.reduce((node, index) => node?.children?.[index], doc);
}

function visibleRows(panel) {
  const bounds = panel.bounds;
  return JSON.stringify(descendants(panel).filter(node => {
    const r = node.bounds;
    return node.role === 'statictext' && node.name && r && r.y + r.height > bounds.y && r.y < bounds.y + bounds.height &&
      !node.states?.some(s => s === 'offscreen' || s === 'hidden');
  }).slice(0, 30).map(node => [node.name, node.bounds.y]));
}

async function wheelPage(ad, {page, over, lines = '3', until, human, seed}) {
  if (!page || !/^-?\d+$/.test(lines) || !Number(lines) || Math.abs(Number(lines)) > 12) {
    throw new Error('Use --page and 1 to 12 wheel lines. Positive is down. --over names a visible text inside the region to scroll; without it the page itself scrolls.');
  }
  let state = await pageState(ad, page, true);
  bringToFront(ad, state);
  const flags = physicalArgs({human, seed});
  const anchor = over ? one(state.doc, over) : {panel: [], clip: state.doc.bounds, bounds: state.doc.bounds};
  const original = panelAt(state.doc, anchor.panel);
  const steady = human || !over ? restingPoint(original, panelClip(state.doc, anchor.panel), center(anchor.clip)) : undefined;
  const point = steady ?? center(anchor.clip);
  const report = {page, ...(over ? {over} : {}), lines: Number(lines), moves: 0, verified: false};
  const panel = () => {
    const next = panelAt(state.doc, anchor.panel);
    if (!next?.bounds || next.role !== original.role || next.name !== original.name ||
      ['x', 'y', 'width', 'height'].some(k => Math.abs(next.bounds[k] - original.bounds[k]) > 2)) {
      throw new Error('The scroll region changed. Inspect the page before continuing.');
    }
    return next;
  };
  const goalVisible = () => {
    const found = matches(panel(), until);
    if (found.length > 1) throw new Error('More than one visible scroll destination named ' + until + '.');
    return found.length === 1;
  };
  if (until && goalVisible()) return {...report, until, verified: true};
  const end = Date.now() + 20000;
  for (let i = 0; i < (until ? 12 : 1); i++) {
    let progress = false;
    try {
      const area = panel(), rows = (until || !over) && visibleRows(area);
      const receiver = area !== state.doc && area.ref_id;
      const action = ad('mouse-wheel', '--headed', '--x=' + point.x, '--y=' + point.y, '--dy=' + (-Number(lines)),
        '--page-refs', state.tab, state.doc.ref_id, ...(receiver ? [receiver] : []), ...flags);
      report.delivery = action.disposition?.delivery;
      report.moves++;
      const settle = Date.now() + 1400;
      do {
        state = await pageState(ad, page, true);
        if (until && goalVisible()) return {...report, until, verified: true};
        if (until || !over) progress = visibleRows(panel()) !== rows;
        else {
          const found = matches(state.doc, over, {visible: false});
          if (found.length === 1) report.anchor_delta_y = found[0].bounds.y - anchor.bounds.y;
          progress = report.anchor_delta_y * Number(lines) < 0;
        }
        if (progress) break;
        await delay(80);
      } while (Date.now() < settle);
    } catch (error) {
      if (!report.moves) throw error;
      return {...report, until, message: error.message + ' Inspect the page before scrolling again.'};
    }
    if (!until) return {...report, verified: progress};
    if (!progress || Date.now() >= end) break;
  }
  return {...report, until, message: 'The named destination was not observed in this region.'};
}

function physicalPointer(ad, state, command, {on, role, nth, ref, human, seed}) {
  bringToFront(ad, state);
  const target = one(state.doc, on, {receiver: command === 'click', role, nth});
  if (ref && target.ref !== ref) throw new Error('The visible receiver differs from the selected navigation control.');
  const {x, y} = center(target.clip);
  return ad(command === 'point' ? 'mouse-move' : 'mouse-click', '--headed', '--xy=' + x + ',' + y,
    '--page-refs', state.tab, state.doc.ref_id, ...(target.ref ? [target.ref] : []), ...physicalArgs({human, seed}));
}

async function pointerPage(ad, command, {page, on, role, nth, human, seed, 'expect-text': expected}) {
  if (!page || !on) throw new Error('Use --page and --on with a visible name.');
  const state = await pageState(ad, page, true);
  if (expected && matches(state.doc, expected).length) throw new Error('The expected text is already visible.');
  const action = physicalPointer(ad, state, command, {on, role, nth, human, seed});
  const report = {page, on, x: action.x, y: action.y, delivery: action.disposition?.delivery};
  if (expected) {
    report.expected_text = expected;
    report.verified = false;
    const end = Date.now() + 3500;
    do {
      try { report.verified = matches((await pageState(ad, page, true)).doc, expected).length > 0; }
      catch { break; }
      if (!report.verified) await delay(100);
    } while (!report.verified && Date.now() < end);
  }
  return report;
}

module.exports = {pointerPage, wheelPage, physicalPointer, restingPoint, panelClip};
