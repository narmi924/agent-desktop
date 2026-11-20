'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { stateDir } = require('./routine-store');

const DEFAULT_WORDS = join(__dirname, 'final-words.json');
const CJK = /[　-鿿가-힯]/;

/** The final-step word list: the user's own file under the state folder replaces the shipped one. */
function finalWords() {
  const own = join(stateDir(), 'final-words.json');
  try { return JSON.parse(readFileSync(existsSync(own) ? own : DEFAULT_WORDS, 'utf8')).words.map(String); } catch { return []; }
}

/** The word a control name shares with the final-step list, or undefined. Chinese words match inside a name; others as whole words. */
function finalWord(name, words = finalWords()) {
  const text = String(name ?? '');
  if (!text) return undefined;
  return words.find(word => CJK.test(word)
    ? text.includes(word)
    : new RegExp('(^|[^\\p{L}\\p{N}])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + '($|[^\\p{L}\\p{N}])', 'iu').test(text));
}

const LITERAL = String.raw`(?<quote>['"\x60])(?<target>(?:\\.|(?!\k<quote>)[^\\])*)\k<quote>`;
const CLICKS = [
  new RegExp(String.raw`\b(?<surface>web|visible)\.click\(\s*` + LITERAL + String.raw`(?<rest>[^)]*)\)`, 'g'),
  new RegExp(String.raw`\b(?<surface>desktop)\.click\(\s*[^,()]+,\s*` + LITERAL + String.raw`(?<rest>[^)]*)\)`, 'g'),
];
const MARKED = /\bfinal\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Final steps a script shows in its own text: marked {final: "..."} steps and clicks on a listed name not marked {final: false}. */
function scanFinals(source, words = finalWords()) {
  const found = [];
  for (const m of String(source).matchAll(MARKED)) found.push({ what: m[2], why: 'marked final' });
  for (const pattern of CLICKS) {
    for (const m of String(source).matchAll(pattern)) {
      const { surface, target, rest } = m.groups;
      if (/\bfinal\s*:/.test(rest)) continue;
      const word = finalWord(target, words);
      if (word) found.push({ what: surface + '.click ' + target, why: 'the name contains "' + word + '"' });
    }
  }
  return found;
}

function finalRefused(message, details) {
  return Object.assign(new Error(message + ' Nothing was sent. Ask the user; when they agree, run the steps that are left with --allow-final.'),
    { code: 'FINAL_NOT_ALLOWED', details });
}

const OPTION_HELPERS = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck', 'press', 'choose', 'cmd']);

/** The options object a helper call carries, if any: the last plain-object argument. */
function optionsOf(args) {
  const last = args.at(-1);
  return last && typeof last === 'object' && !Array.isArray(last) ? last : undefined;
}

/**
 * Wraps the page and desktop helpers so a final step stops before it is sent: a click on a control whose
 * name is on the list, or any step marked {final: "..."}. {final: false} clears a listed name.
 */
function guardFinals(surfaces, { allowed, mark, onFinal = () => {} }) {
  const words = finalWords();
  const wrapped = {};
  for (const [surface, helpers] of Object.entries(surfaces)) {
    wrapped[surface] = Object.fromEntries(Object.entries(helpers).map(([name, fn]) => {
      if (typeof fn !== 'function' || !OPTION_HELPERS.has(name)) return [name, fn];
      return [name, async (...args) => {
        const options = optionsOf(args);
        const target = surface === 'desktop' && name !== 'cmd' ? args[1] : args[0];
        const marked = typeof options?.final === 'string' ? options.final : undefined;
        const word = name === 'click' && options?.final !== false ? finalWord(target, words) : undefined;
        if (marked !== undefined || word) {
          const what = surface + '.' + name + ' ' + (typeof target === 'string' ? target : '');
          const why = marked !== undefined ? marked || 'marked final' : 'the name contains "' + word + '"';
          if (!(typeof allowed === 'function' ? allowed() : allowed)) {
            let picture;
            try { picture = await mark?.(surface, args, name); } catch { /* A step is refused even when its picture cannot be made. */ }
            throw finalRefused('This step is a final step (' + what.trim() + ': ' + why + '); it cannot be taken back.',
              { what: what.trim(), why, ...(picture ? { picture } : {}) });
          }
          onFinal({ what: what.trim(), why });
        }
        return fn(...args);
      }];
    }));
  }
  return wrapped;
}

module.exports = { finalWords, finalWord, scanFinals, guardFinals, finalRefused };
