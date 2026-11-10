'use strict';

const PRESSABLE = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch', 'treeitem', 'listitem', 'combobox', 'menubutton'];

function plain(text) {
  return String(text ?? '').replace(/\s+/g, ' ').replace(/[\s:：*＊]+$/u, '').trim();
}

function describe(control) {
  return control.role + ' "' + (control.name || control.near || '') + '" ' + control.ref;
}

/**
 * Picks the one control a name refers to. Exact names win over trimmed names,
 * then over the visible text beside an unnamed control, then over partial names.
 */
function pick(controls, name, { roles, role, nth } = {}) {
  const usable = controls.filter(c => c.ref && (role ? c.role === role : !roles || roles.includes(c.role)));
  const wanted = plain(name);
  const rules = [
    c => c.name === name,
    c => plain(c.name) === wanted,
    c => !c.name && plain(c.near) === wanted,
    c => wanted.length > 1 && plain(c.name).includes(wanted),
  ];
  for (const rule of rules) {
    let hits = usable.filter(rule);
    if (!hits.length) continue;
    if (!role && !roles) {
      const pressable = hits.filter(c => PRESSABLE.includes(c.role));
      if (pressable.length) hits = pressable;
    }
    if (nth !== undefined) {
      if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) throw Object.assign(new Error('nth ' + nth + ' is out of range: ' + hits.length + ' controls are named "' + name + '".'), { code: 'INVALID_ARGS' });
      return hits[nth - 1];
    }
    if (hits.length > 1) {
      throw Object.assign(new Error(hits.length + ' controls are named "' + name + '": ' + hits.slice(0, 6).map(describe).join(', ') + '. Pass {nth} or {role}, or use the ref.'), { code: 'AMBIGUOUS_TARGET' });
    }
    return hits[0];
  }
  return undefined;
}

module.exports = { pick, plain };
