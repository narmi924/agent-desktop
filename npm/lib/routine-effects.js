'use strict';

/** Effects whose absence on a later run means the app took another path. */
const EXPECTED_KINDS = new Set(['window_opened', 'window_closed', 'dialog_opened', 'new_tab', 'url_changed']);
/** Effects that stop a run when they appear and the saved run never saw them: an unknown window, dialog or tab. */
const UNSEEN_KINDS = new Set(['window_opened', 'dialog_opened', 'new_tab']);
const PIN_AFTER = 2;
const ACTIONS = /\b(?:web|desktop|visible)\.(?:click|fill|type|select|check|uncheck|press|choose|launch|cmd)\s*\(|\bflow\s*\(/g;
const RESULT_CHECKS = /\b(?:web|desktop|visible)\.(?:waitText|waitFor|value|has|waitIdle)\s*\(|\bexpect\s*\(/g;

const effectKey = effect => effect.kind + '|' + (effect.app ?? '');

/** Replaces every given argument value inside a text with {name}, longest values first. */
function scrubber(args) {
  const pairs = Object.entries(args ?? {})
    .map(([name, value]) => [name, value === null || value === undefined ? '' : String(value)])
    .filter(([, value]) => value.trim() !== '')
    .sort((a, b) => b[1].length - a[1].length);
  return text => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [name, value] of pairs) {
      out = value.length > 1
        ? out.split(value).join('{' + name + '}')
        : out.replace(new RegExp('(^|[^\\p{L}\\p{N}])' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^\\p{L}\\p{N}])', 'gu'), '$1{' + name + '}');
    }
    return out;
  };
}

/** A run's step records with argument values taken out, as stored in a routine. */
function templateSteps(records, args) {
  const scrub = scrubber(args);
  return records.filter(r => r.ok).map(r => ({
    label: scrub(r.label),
    effects: r.effects.map(e => ({ kind: e.kind, ...(e.app ? { app: e.app } : {}), ...(e.title ? { title: scrub(e.title) } : {}), ...(e.host ? { host: e.host } : {}) })),
    ...(r.input ? { input: true } : {}),
    ms: r.ms,
  }));
}

/** True when the last action in a script is not followed by anything that reads its result. */
function lacksResultCheck(source) {
  const last = [...String(source).matchAll(ACTIONS)].at(-1);
  if (!last) return false;
  return ![...String(source).matchAll(RESULT_CHECKS)].some(m => m.index > last.index);
}

/**
 * Follows a routine run step by step. Each finished step is matched to the next saved step with the same label;
 * a missing expected effect or an unseen window, dialog or tab stops the run with EFFECT_MISMATCH.
 * Window titles count only once two successful runs in a row saw the same one.
 */
function effectChecker(routine, args) {
  const scrub = scrubber(args);
  const saved = routine.steps ?? [];
  let cursor = 0;
  const matched = [];
  return {
    matched,
    check(record) {
      const label = scrub(record.label);
      const at = saved.findIndex((s, i) => i >= cursor && s.label === label);
      if (at < 0) return;
      cursor = at + 1;
      const expected = saved[at];
      const found = record.effects.map(e => ({ ...e, ...(e.title ? { title: scrub(e.title) } : {}) }));
      matched.push({ index: at, effects: found });
      const pinned = routine.pinned?.[at] ?? {};
      const has = (list, effect) => list.some(e => effectKey(e) === effectKey(effect) && (!pinned[effectKey(effect)] || e.title === pinned[effectKey(effect)]));
      const missing = expected.effects.filter(e => EXPECTED_KINDS.has(e.kind) && !has(found, { ...e, title: pinned[effectKey(e)] ?? e.title }));
      const unseen = found.filter(e => UNSEEN_KINDS.has(e.kind) && !expected.effects.some(s => effectKey(s) === effectKey(e)));
      if (!missing.length && !unseen.length) return;
      const say = e => e.kind.replace('_', ' ') + (e.app ? ' (' + e.app + (e.title ? ' "' + e.title + '"' : '') + ')' : '');
      throw Object.assign(new Error('Step ' + (at + 1) + ' (' + expected.label + ') did not do what it did when the routine was saved: ' +
        [...missing.map(e => 'expected ' + say(e)), ...unseen.map(e => 'found ' + say(e))].join('; ') +
        '. The routine stopped here; nothing after this step ran.'),
      { code: 'EFFECT_MISMATCH', details: { step: at + 1, label: expected.label, expected: expected.effects, found } });
    },
  };
}

/**
 * After a successful run: counts it, and pins a window title once it was the same in PIN_AFTER runs in a row.
 * A title that changes un-pins and starts counting again.
 */
function learn(routine, matched, now = new Date().toISOString()) {
  const seen = { ...(routine.seen ?? {}) };
  const pinned = { ...(routine.pinned ?? {}) };
  for (const { index, effects } of matched) {
    const step = { ...(seen[index] ?? {}) };
    const pins = { ...(pinned[index] ?? {}) };
    for (const effect of effects) {
      if (!effect.title || !EXPECTED_KINDS.has(effect.kind)) continue;
      const key = effectKey(effect);
      const last = step[key];
      const streak = last?.title === effect.title ? last.streak + 1 : 1;
      step[key] = { title: effect.title, streak };
      if (streak >= PIN_AFTER) pins[key] = effect.title; else delete pins[key];
    }
    seen[index] = step;
    pinned[index] = pins;
  }
  const successes = (routine.successes ?? 0) + 1;
  return { ...routine, seen, pinned, successes, status: successes > PIN_AFTER ? 'proven' : 'candidate', last_success: now };
}

/** The first-run counts for a newly saved routine: its own steps' titles seen once. */
function firstSeen(steps) {
  const seen = {};
  steps.forEach((step, index) => {
    for (const effect of step.effects) if (effect.title && EXPECTED_KINDS.has(effect.kind)) {
      (seen[index] ??= {})[effectKey(effect)] = { title: effect.title, streak: 1 };
    }
  });
  return seen;
}

module.exports = { scrubber, templateSteps, lacksResultCheck, effectChecker, learn, firstSeen, effectKey };
