'use strict';

/** Errors a fix cannot help with: the user has to decide, or the script itself is wrong. */
const NOT_FIXABLE = new Set(['MISSING_ARGS', 'INVALID_ARGS', 'EXPECTATION_FAILED', 'SURFACE_PROTECTED']);
/** A step the tool stopped itself because a person took the mouse or keyboard: not sent, safe to do again. */
const YIELDED = /Cursor movement interrupted|stopped by Escape|held mouse button|left the foreground|PERSON_TOOK_OVER/;
/** A step that was sent: doing it again could send it twice. */
const SENT = new Set(['EFFECT_MISMATCH', 'CLICK_UNCONFIRMED']);
/** Wait helpers that take their time limit as a plain number in this place rather than in an options object. */
const TIME_IN_PLACE = { 'web.waitText': 1, 'visible.waitText': 1, 'desktop.waitText': 2 };
const SUBJECT_LIMIT = 60;

function targetIndex(surface, name) {
  return surface === 'desktop' && !['windows', 'apps', 'launch', 'cmd'].includes(name) ? 1 : 0;
}

/** The time a step was given, as a number, whether it came as milliseconds or as `{timeout}`. */
function givenTime(value) {
  const ms = Number(value && typeof value === 'object' ? value.timeout : value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The step's arguments with the options of a retry. A `timeout` reaches the helper wherever it takes it, and the
 * longer of the retry's time and the time the script gave the step applies; other options replace the step's own.
 */
function withOptions(args, options, helper) {
  if (!options) return args;
  const { timeout, ...rest } = options;
  const slot = TIME_IN_PLACE[helper];
  if (slot !== undefined) {
    const next = [...args];
    const longer = Math.max(Number(timeout), givenTime(next[slot]) ?? 0);
    if (timeout !== undefined) next[slot] = next[slot] && typeof next[slot] === 'object' ? { ...next[slot], timeout: longer } : longer;
    if (Object.keys(rest).length && helper === 'desktop.waitText') next[slot + 1] = { ...next[slot + 1], ...rest };
    return next;
  }
  const last = args.at(-1);
  const own = last && typeof last === 'object' && !Array.isArray(last) ? last : undefined;
  const merged = { ...own, ...rest, ...(timeout !== undefined ? { timeout: Math.max(Number(timeout), givenTime(own) ?? 0) } : {}) };
  return own ? [...args.slice(0, -1), merged] : [...args, merged];
}

function describe(helper, target) {
  const text = typeof target === 'string' ? target : '';
  return helper + (text ? ' ' + (text.length > SUBJECT_LIMIT ? text.slice(0, SUBJECT_LIMIT) + '…' : text) : '');
}

/** A patch that threw on its own: the job waits again with this, and the step it was for has not been tried again. */
function patchFailed(thrown) {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return Object.assign(new Error('The patch stopped: ' + message + '. The failed step was not tried again; send another fix.'),
    { code: 'PATCH_FAILED', ...(thrown?.step ? { details: { patch_step: thrown.step } } : {}) });
}

/**
 * Wraps the helpers so a failed step waits for a fix instead of ending the script. `ask` gets what failed and
 * returns what to do: {action: "retry", target, options}, {action: "do", source}, {action: "skip", value} or
 * {action: "stop"}. A patch runs first and then the step is tried again, unless the step was already sent: then the
 * script goes on with the patch's value. A patch that throws asks again with code PATCH_FAILED. The script's
 * variables stay as they were; steps that already ran are not run again. Decisions on a final step (approve, or skip
 * before it) are not fixes of the script and go to `approvals`.
 */
function fixable(surfaces, { ask, runPatch, fixes = [], approvals = [], allowOnce = () => {}, waitHands }) {
  const wrapped = {};
  for (const [surface, helpers] of Object.entries(surfaces)) {
    wrapped[surface] = Object.fromEntries(Object.entries(helpers).map(([name, fn]) => {
      if (typeof fn !== 'function') return [name, fn];
      return [name, async (...args) => {
        let current = args;
        for (;;) {
          try {
            return await fn(...current);
          } catch (err) {
            if (!err || NOT_FIXABLE.has(err.code)) throw err;
            const cutShort = waitHands?.cutShort?.() ?? false;
            if (waitHands && !SENT.has(err.code) && (err.code === 'INPUT_NOT_ALLOWED' || YIELDED.test(err.message ?? '') || cutShort)) {
              const outcome = await waitHands({ step: err.step ?? surface + '.' + name, helper: name, reason: err.code === 'INPUT_NOT_ALLOWED' ? 'hands' : 'user', error: err, uncertain: cutShort && !YIELDED.test(err.message ?? '') });
              if (outcome === 'retry') { if (err.resumeWith) current = err.resumeWith; continue; }
              if (outcome !== 'fix') throw err;
            }
            const approval = err.code === 'FINAL_NOT_ALLOWED';
            const at = targetIndex(surface, name);
            const step = err.step ?? describe(surface + '.' + name, current[at]);
            let problem = err;
            for (;;) {
              const decision = await ask({ step, surface, helper: name, target: current[at], error: problem, sent: SENT.has(err.code), approval });
              if (!decision || decision.action === 'stop') throw Object.assign(err, { fixStopped: true });
              if (approval && !['approve', 'skip'].includes(decision.action)) throw Object.assign(err, { fixStopped: true });
              if (decision.action === 'approve') allowOnce();
              const record = { step, ...decision, ...(decision.source ? { source: undefined, patch: true } : {}) };
              if (approval) { approvals.push({ step, action: decision.action }); if (decision.action === 'skip') return decision.value ?? null; break; }
              if (decision.action === 'skip') { fixes.push(record); return decision.value ?? null; }
              if (decision.action === 'do') {
                let value;
                try { value = await runPatch(decision.source); } catch (thrown) {
                  if (thrown?.fixStopped) throw thrown;
                  problem = patchFailed(thrown);
                  continue;
                }
                fixes.push(record);
                if (SENT.has(err.code)) return value ?? null;
                break;
              }
              fixes.push(record);
              if (decision.action === 'retry') {
                current = [...current];
                if (decision.target !== undefined) current[at] = decision.target;
                current = withOptions(current, decision.options, surface + '.' + name);
              }
              break;
            }
          }
        }
      }];
    }));
  }
  return wrapped;
}

module.exports = { fixable, withOptions, NOT_FIXABLE, SENT, YIELDED };
