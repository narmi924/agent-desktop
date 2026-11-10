'use strict';

const PRESSABLE = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch', 'treeitem', 'listitem', 'combobox', 'menubutton'];

function plain(text) {
  return String(text ?? '').replace(/\s+/g, ' ').replace(/[\s:：*＊]+$/u, '').trim();
}

function describe(control) {
  return control.role + ' "' + (control.name || control.near || '') + '" ' + control.ref;
}

/**
 * Controls a name can refer to. Exact names win over trimmed names, then over
 * the visible text beside an unnamed control, then over partial names.
 */
function matching(controls, name, { roles, role } = {}) {
  const usable = controls.filter(c => c.ref && (role ? c.role === role : !roles || roles.includes(c.role)));
  const wanted = plain(name);
  const rules = [
    c => c.name === name,
    c => plain(c.name) === wanted,
    c => !c.name && plain(c.near) === wanted,
    c => wanted.length > 1 && plain(c.name).includes(wanted),
  ];
  for (const rule of rules) {
    const hits = usable.filter(rule);
    if (!hits.length) continue;
    const pressable = role || roles ? [] : hits.filter(c => PRESSABLE.includes(c.role));
    return pressable.length ? pressable : hits;
  }
  return [];
}

function several(hits, name, hint) {
  return Object.assign(new Error(hits.length + ' controls are named "' + name + '": ' + hits.slice(0, 6).map(describe).join(', ') + '. ' + hint), { code: 'AMBIGUOUS_TARGET' });
}

/** Picks the one control a name refers to, or the nth of several. */
function pick(controls, name, { nth, near, ...kind } = {}) {
  if (near !== undefined) return pickNear(controls, name, near, kind);
  const hits = matching(controls, name, kind);
  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) throw Object.assign(new Error('nth ' + nth + ' is out of range: ' + hits.length + ' controls are named "' + name + '".'), { code: 'INVALID_ARGS' });
    return hits[nth - 1];
  }
  if (hits.length > 1) throw several(hits, name, 'Pass {near: "text beside the one you mean"}, {nth} or {role}, or use the ref.');
  return hits[0];
}

/** Lines above a line that contain it, outermost first. Needs `depth` on every line. */
function ancestors(lines, index) {
  const path = [];
  let depth = lines[index].depth;
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    if (lines[i].depth < depth) {
      path.unshift(i);
      depth = lines[i].depth;
    }
  }
  return path;
}

/**
 * Among controls with the same name, picks the one that shares the most of
 * the page structure with a piece of visible text: the button in the row
 * that shows a product name, the field in the card that shows a heading.
 */
function pickNear(lines, name, near, kind) {
  const hits = matching(lines, name, kind);
  const anchors = lines.map((line, index) => index).filter(index => (lines[index].name ?? '').includes(near) || String(lines[index].value ?? '').includes(near));
  if (!hits.length || !anchors.length) return undefined;
  const shared = (a, b) => {
    let count = 0;
    while (count < a.length && count < b.length && a[count] === b[count]) count++;
    return count;
  };
  const scored = hits.map(hit => {
    const index = lines.indexOf(hit), path = [...ancestors(lines, index), index];
    const best = anchors.map(anchor => [shared(path, [...ancestors(lines, anchor), anchor]), -Math.abs(anchor - index)])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
    return { hit, best };
  }).sort((a, b) => b.best[0] - a.best[0] || b.best[1] - a.best[1]);
  if (scored.length > 1 && scored[0].best[0] === scored[1].best[0] && scored[0].best[1] === scored[1].best[1]) {
    throw several(scored.slice(0, 2).map(s => s.hit), name, 'They are equally close to "' + near + '". Pass {nth} or use the ref.');
  }
  return scored[0].hit;
}

module.exports = { pick, plain };
