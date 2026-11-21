'use strict';

const store = require('./routine-store');
const { argNames, parseArgs } = require('./script-args');
const { templateSteps, lacksResultCheck, effectChecker, learn, firstSeen, scrubber } = require('./routine-effects');
const grants = require('./routine-approvals');

const KNOWN_LIMIT = 5;

/** `--param name="what it is"` entries as [{name, about}]. */
function parseParams(entries = []) {
  return entries.map(entry => {
    const at = entry.indexOf('=');
    const name = (at < 0 ? entry : entry.slice(0, at)).trim();
    const about = at < 0 ? '' : entry.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw Object.assign(new Error('--param takes name="what it is", for example --param who="收货人姓名".'), { code: 'INVALID_ARGS' });
    return { name, about };
  });
}

/** The routine a successful run becomes. Argument values never reach the stored files. */
function routineFrom({ name, about, params, source, args, done }) {
  const described = new Map(params.map(p => [p.name, p.about]));
  const used = argNames(source);
  const unused = params.filter(p => !used.includes(p.name)).map(p => p.name);
  const steps = templateSteps(done.trail.records, args);
  const scrub = scrubber(args);
  const now = new Date().toISOString();
  const routine = {
    name, about: about ?? '', params: [...new Set([...params.map(p => p.name), ...used])].map(n => ({ name: n, about: described.get(n) ?? '' })),
    status: 'candidate', successes: 1, failures: 0, last_success: now, updated: now,
    input: steps.some(s => s.input), finals: (done.finals ?? []).map(f => scrub(f.what)),
    apps: done.trail.apps, hosts: done.trail.hosts, steps, seen: firstSeen(steps), pinned: {},
  };
  const warnings = [
    ...(lacksResultCheck(source) ? ['The last action in this script is not followed by a check of its result (waitText, waitFor, value, has or expect). ' +
      'A later run cannot tell whether that action worked; add one and save again with --replace.'] : []),
    ...(unused.length ? ['--param ' + unused.join(', ') + ' is not read by the script (as args.name).'] : []),
  ];
  return { routine, warnings };
}

function save({ name, about, params, replace, source, args, done }) {
  store.checkName(name);
  const { routine, warnings } = routineFrom({ name, about, params: parseParams(params), source, args, done });
  const stored = store.save(routine, source, { replace });
  return { name, version: stored.version, status: stored.status, params: stored.params, ...(warnings.length ? { warnings } : {}) };
}

/** Runs a saved routine through the same script runner, stopping at the first step whose effects differ. */
async function runRoutine(name, given, run, { fixes } = {}) {
  const routine = store.load(name);
  const missing = routine.params.filter(p => !Object.hasOwn(given, p.name));
  if (missing.length) {
    throw Object.assign(new Error('Routine "' + name + '" needs: ' + missing.map(p => p.name + (p.about ? ' (' + p.about + ')' : '')).join(', ') +
      '. Pass them with --args JSON.'), { code: 'MISSING_ARGS', details: { needs: missing } });
  }
  const checker = effectChecker(routine, given);
  const standing = grants.approved(name, routine.script);
  try {
    const done = await run(routine.script, { args: given, onStep: record => checker.check(record), ...(standing ? { allowFinal: true, approvedRoutine: true } : {}) });
    const next = fixes?.length
      ? store.update(name, current => ({ ...current, last_fixed: new Date().toISOString() }))
      : store.update(name, current => learn(current, checker.matched));
    return Object.defineProperty({ routine: name, status: next?.status, successes: next?.successes, ...done }, 'trail', { value: done.trail, enumerable: false });
  } catch (err) {
    store.update(name, current => ({ ...current, failures: (current.failures ?? 0) + 1, last_failure: new Date().toISOString() }));
    if (err.report) err.report = { routine: name, ...err.report };
    else err.report = { routine: name };
    throw err;
  }
}

function list(filter) {
  const wanted = filter?.toLowerCase();
  const rows = Object.entries(store.readIndex().routines)
    .filter(([name, r]) => !wanted || [name, r.about, ...(r.apps ?? []), ...(r.hosts ?? [])].some(t => String(t ?? '').toLowerCase().includes(wanted)))
    .map(([name, r]) => row(name, r));
  return { routines: rows };
}

function row(name, r) {
  return name + (r.params.length ? ' (' + r.params.join(', ') + ')' : '') + ': ' + (r.about || '(no description)') +
    (r.input ? ' [real mouse and keyboard]' : '') + (r.finals ? ' [final steps]' : '') + ' [' + r.status + ', ' + r.successes + ' ok' +
    (r.failures ? ', ' + r.failures + ' failed' : '') + ']';
}

function show(name) {
  const r = store.load(name);
  return {
    name: r.name, about: r.about, params: r.params, status: r.status, successes: r.successes, failures: r.failures,
    last_success: r.last_success, version: r.version, input: r.input, finals: r.finals, apps: r.apps, hosts: r.hosts,
    steps: r.steps.map(s => s.label + (s.effects.length ? ' -> ' + s.effects.map(e => e.kind + (e.app ? ' ' + e.app : '')).join(', ') : '')),
    script: r.script,
  };
}

/** Routines a person approved for good in the confirmation window, and whether each is still the script they approved. */
function permissions() {
  return { approved: Object.entries(grants.approvals()).map(([name, entry]) => {
    let current;
    try { current = grants.approved(name, store.load(name).script); } catch { current = false; }
    return { name, since: entry.at, current };
  }), protected: grants.protectedSurfaces(), protected_file: grants.protectedPath() };
}

function revoke(name) {
  return { revoked: name, had: grants.revoke(name) };
}

function remove(name) {
  store.remove(name);
  return { removed: name };
}

/** Saved routines that touch an app or site the run just touched, as one line each, at most five. */
function knownRoutines(trail) {
  if (!trail || (!trail.apps.length && !trail.hosts.length)) return [];
  let index;
  try { index = store.readIndex(); } catch { return []; }
  return Object.entries(index.routines)
    .filter(([, r]) => (r.apps ?? []).some(a => trail.apps.includes(a)) || (r.hosts ?? []).some(h => trail.hosts.includes(h)))
    .sort(([, a], [, b]) => String(b.last_success ?? '').localeCompare(String(a.last_success ?? '')))
    .slice(0, KNOWN_LIMIT).map(([name, r]) => row(name, r));
}

function readArgs({ args, 'args-file': file }, readText) {
  if (args !== undefined && file !== undefined) throw Object.assign(new Error('Give --args or --args-file, not both.'), { code: 'INVALID_ARGS' });
  return parseArgs(file !== undefined ? readText(file).replace(/^﻿/, '') : args);
}

module.exports = { save, runRoutine, list, show, remove, knownRoutines, readArgs, parseParams, routineFrom, permissions, revoke };
