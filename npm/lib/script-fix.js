'use strict';

/** Errors a fix cannot help with: the user has to decide, or the script itself is wrong. */
const NOT_FIXABLE = new Set(['MISSING_ARGS', 'INVALID_ARGS', 'EXPECTATION_FAILED', 'SURFACE_PROTECTED']);
/** A step the tool stopped itself because a person took the mouse or keyboard: not sent, safe to do again. */
const YIELDED = /Cursor movement interrupted|stopped by Escape|held mouse button|left the foreground|PERSON_TOOK_OVER/;
/** A step that was sent: doing it again could send it twice. */
const SENT = new Set(['EFFECT_MISMATCH']);

function targetIndex(surface, name) {
  return surface === 'desktop' && !['windows', 'apps', 'launch', 'cmd'].includes(name) ? 1 : 0;
}

function withOptions(args, options) {
  if (!options) return args;
  const last = args.at(-1);
  return last && typeof last === 'object' && !Array.isArray(last) ? [...args.slice(0, -1), { ...last, ...options }] : [...args, options];
}

/**
 * Wraps the helpers so a failed step waits for a fix instead of ending the script. `ask` gets what failed and
 * returns what to do: {action: "retry", target, options}, {action: "do", source}, {action: "skip", value} or
 * {action: "stop"}. A patch runs first and then the step is tried again, unless the step was already sent: then the
 * script goes on with the patch's value. The script's variables stay as they were; steps that already ran are not run again.
 */
function fixable(surfaces, { ask, runPatch, fixes = [], allowOnce = () => {}, waitHands }) {
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
            if (waitHands && (err.code === 'INPUT_NOT_ALLOWED' || YIELDED.test(err.message ?? '') || cutShort)) {
              const outcome = await waitHands({ step: err.step ?? surface + '.' + name, helper: name, reason: err.code === 'INPUT_NOT_ALLOWED' ? 'hands' : 'user', error: err, uncertain: cutShort && !YIELDED.test(err.message ?? '') });
              if (outcome === 'retry') { if (err.resumeWith) current = err.resumeWith; continue; }
              if (outcome !== 'fix') throw err;
            }
            const approval = err.code === 'FINAL_NOT_ALLOWED';
            const at = targetIndex(surface, name);
            const decision = await ask({ step: err.step ?? surface + '.' + name, surface, helper: name, target: current[at], error: err, sent: SENT.has(err.code), approval });
            if (!decision || decision.action === 'stop') throw err;
            if (approval && !['approve', 'skip'].includes(decision.action)) throw err;
            if (decision.action === 'approve') allowOnce();
            fixes.push({ step: err.step ?? surface + '.' + name, ...decision, ...(decision.source ? { source: undefined, patch: true } : {}) });
            if (decision.action === 'skip') return decision.value ?? null;
            if (decision.action === 'do') {
              const value = await runPatch(decision.source);
              if (SENT.has(err.code)) return value ?? null;
            }
            if (decision.action === 'retry') {
              current = [...current];
              if (decision.target !== undefined) current[at] = decision.target;
              current = withOptions(current, decision.options);
            }
          }
        }
      }];
    }));
  }
  return wrapped;
}

module.exports = { fixable, NOT_FIXABLE, SENT, YIELDED };
