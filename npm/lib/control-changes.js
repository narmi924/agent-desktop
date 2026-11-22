'use strict';

/** States worth a line, with the words for gaining and losing them. Focus moves with every click, so it is left out. */
const SHOWN_STATES = {
  checked: ['checked', 'unchecked'],
  expanded: ['expanded', 'collapsed'],
  selected: ['selected', 'deselected'],
  disabled: ['disabled', 'enabled'],
};
const VALUE_SHOWN = 30;
const NAMES_SHOWN = 3;

const label = control => '"' + (control.name || control.role) + '"';
const quoted = value => (value === undefined || value === null ? 'empty' : JSON.stringify(String(value).length > VALUE_SHOWN ? String(value).slice(0, VALUE_SHOWN) + '…' : String(value)));
const shownStates = states => new Set((states ?? []).filter(state => Object.hasOwn(SHOWN_STATES, state)));

/**
 * The lines a step reports for what changed inside its window, from a snapshot's `changes` (taken with --since the
 * read the step acted on). A value the step itself wrote is never printed, since a step record keeps field names and
 * not what was typed: `hidden` is the name of the control written to, `written` the text or texts sent, and a value
 * that holds one of them is reported only as changed. Each line comes with an effect for the run record.
 */
function describeChanges(changes, { hidden, written } = {}) {
  if (!changes) return [];
  const sent = (Array.isArray(written) ? written : written === undefined ? [] : [written]).map(String).filter(Boolean);
  const lines = [];
  for (const control of changes.changed ?? []) {
    const was = control.before ?? {}, now = control.after ?? {};
    const parts = [];
    if ((was.value ?? null) !== (now.value ?? null)) {
      const own = (hidden !== undefined && control.name === hidden) || sent.some(text => String(now.value ?? '').includes(text));
      parts.push(own || (now.states ?? []).includes('protected') ? 'value changed' : 'value ' + quoted(was.value) + ' -> ' + quoted(now.value));
    }
    const before = shownStates(was.states), after = shownStates(now.states);
    for (const state of after) if (!before.has(state)) parts.push(SHOWN_STATES[state][0]);
    for (const state of before) if (!after.has(state)) parts.push(SHOWN_STATES[state][1]);
    const line = label(control) + ' ' + parts.join(', ');
    if (parts.length && !lines.some(([text]) => text === line)) lines.push([line, { kind: 'control_changed', role: control.role, name: control.name }]);
  }
  const names = list => list.slice(0, NAMES_SHOWN).map(label).join(', ') + (list.length > NAMES_SHOWN ? ' and ' + (list.length - NAMES_SHOWN) + ' more' : '');
  const added = changes.added ?? [], removed = changes.removed ?? [];
  if (added.length) lines.push([added.length + (added.length === 1 ? ' control' : ' controls') + ' appeared: ' + names(added), { kind: 'controls_appeared', count: added.length }]);
  if (removed.length) lines.push([removed.length + (removed.length === 1 ? ' control' : ' controls') + ' went away: ' + names(removed), { kind: 'controls_gone', count: removed.length }]);
  return lines;
}

module.exports = { describeChanges, SHOWN_STATES };
