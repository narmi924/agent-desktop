'use strict';

const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const NAME = 'slipwing';
const SKILL_DIR = join(__dirname, '..', 'skills', NAME);
const STUB_MARK = 'generated-by: slipwing';

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGS' });

/** The guide's parts: SKILL.md is the main one, the others go by their file name without .md. */
function parts() {
  return readdirSync(SKILL_DIR).filter(file => file.endsWith('.md')).map(file => (file === 'SKILL.md' ? 'main' : file.slice(0, -3))).sort();
}

function read(part = 'main') {
  const file = part === 'main' ? 'SKILL.md' : part.replace(/\.md$/, '') + '.md';
  if (!/^[a-z-]+\.md$|^SKILL\.md$/.test(file) || !existsSync(join(SKILL_DIR, file))) {
    throw invalid('The guide has these parts: ' + parts().join(', ') + '.');
  }
  return readFileSync(join(SKILL_DIR, file), 'utf8');
}

/** The main guide without its frontmatter, for places that show it as text (the MCP guide tool). */
function body() {
  return read().replace(/^---[\s\S]*?\n---\s*\n/, '');
}

/** The frontmatter description, so an installed entry triggers on the same words. */
function description() {
  const match = /^description:\s*(.+)$/m.exec(read());
  return match ? match[1].trim() : '';
}

/**
 * A short entry for an agent's skill folder. It holds only the trigger description and points at the guide the
 * installed program prints, so the guide an agent reads always matches the program it runs.
 */
function stub() {
  return [
    '---',
    'name: ' + NAME,
    'description: ' + description(),
    STUB_MARK,
    '---',
    '',
    '# Working on the user\'s computer',
    '',
    'Run `slipwing skill` and follow it. It names further parts; read one with',
    '`slipwing skill NAME`, for example `slipwing skill chrome`.',
    '',
  ].join('\n');
}

/** The skill folders of the agents this installs for, or the one folder the caller names. */
function targets(dir) {
  if (dir) return [join(dir, NAME)];
  return [join(homedir(), '.claude', 'skills', NAME), join(homedir(), '.codex', 'skills', NAME)];
}

/**
 * Writes the entry into each target. A folder that holds a skill this command did not write is left alone unless
 * `force` is given: it may be the user's own.
 */
function install({ dir, force = false } = {}) {
  const done = [], kept = [];
  for (const folder of targets(dir)) {
    const file = join(folder, 'SKILL.md');
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(STUB_MARK) && !force) { kept.push(folder); continue; }
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, stub());
    done.push(folder);
  }
  return { installed: done, ...(kept.length ? { kept, note: 'These folders hold a skill this command did not write; add --force to replace it.' } : {}) };
}

module.exports = { NAME, parts, read, body, stub, install, STUB_MARK, SKILL_DIR };
