'use strict';

const ASK_FIRST = 'Nothing was sent. Ask the user first; when they agree, run the steps that are left with run --allow-input.';

const INPUT_USES = [
  [/\bvisible\.(click|hover|choose|type|scrollTo|scroll)\s*\(/g, m => 'visible.' + m[1]],
  [/\bhuman\(\s*['"`](natural|careful)['"`]/g, m => 'human("' + m[1] + '")'],
  [/\bdesktop\.type\s*\(/g, () => 'desktop.type'],
  [/['"`]--headed['"`]/g, () => '"--headed"'],
  [/\bflow\(\s*['"`](tap|move)['"`]/g, m => 'flow("' + m[1] + '")'],
];

/** The helpers a script names that always take the real mouse and keyboard. */
function inputUses(source) {
  const found = new Set();
  for (const [pattern, label] of INPUT_USES) for (const m of source.matchAll(pattern)) found.add(label(m));
  return [...found];
}

function inputRefused(message, next = ASK_FIRST) {
  return Object.assign(new Error(message + ' ' + next), { code: 'INPUT_NOT_ALLOWED' });
}

module.exports = { inputUses, inputRefused };
