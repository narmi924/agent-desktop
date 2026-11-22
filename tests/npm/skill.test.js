'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const skill = require('../../npm/lib/skill-command');
const { COMMAND_OPTIONS } = require('../../npm/lib/cli-options');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');
const cli = args => spawnSync(process.execPath, [workflow, ...args], { encoding: 'utf8' });
const files = readdirSync(skill.SKILL_DIR).filter(f => f.endsWith('.md'));
const text = Object.fromEntries(files.map(f => [f, readFileSync(join(skill.SKILL_DIR, f), 'utf8')]));

test('the skill command prints the guide and each part, and names the parts on a wrong one', () => {
  assert.match(cli(['skill']).stdout, /^---\r?\nname: slipwing/, 'a checkout with Windows line ends prints them');
  assert.match(cli(['skill', 'jobs']).stdout, /^# Jobs/);
  assert.deepEqual(JSON.parse(cli(['skill', '--list']).stdout).data.parts, ['chrome', 'desktop', 'human', 'jobs', 'main', 'routines', 'watches']);
  const wrong = cli(['skill', 'nope']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /chrome, desktop, human/);
});

test('every part the guide points to exists', () => {
  for (const [file, body] of Object.entries(text)) {
    for (const [, named] of body.matchAll(/`([a-z-]+)\.md`/g)) assert.ok(files.includes(named + '.md'), file + ' points to ' + named + '.md');
  }
});

test('every workflow command and flag the guide shows exists, so the guide cannot drift from the program', () => {
  const unknown = [];
  for (const [file, body] of Object.entries(text)) {
    for (const line of body.split('\n')) {
      const segments = line.split('slipwing ').slice(1);
      for (const segment of segments) {
        const command = segment.match(/^([a-z-]+)/)?.[1];
        if (!command || ['--help', '--version'].includes(command)) continue;
        if (!Object.hasOwn(COMMAND_OPTIONS, command)) { unknown.push(file + ': command ' + command); continue; }
        const words = segment.split(/[`|]/)[0];
        for (const [, flag] of words.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)) {
          if (!COMMAND_OPTIONS[command].includes(flag) && !(command === 'run' && flag === 'api')) unknown.push(file + ': ' + command + ' --' + flag);
        }
      }
    }
  }
  assert.deepEqual(unknown, []);
});

test('installing writes a short entry that points to the guide and never replaces a skill it did not write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-skill-'));
  const first = skill.install({ dir });
  const entry = join(dir, 'slipwing', 'SKILL.md');
  assert.deepEqual(first.installed, [join(dir, 'slipwing')]);
  const written = readFileSync(entry, 'utf8');
  assert.match(written, /slipwing skill/);
  assert.equal(written.match(/^description: (.+)$/m)[1], text['SKILL.md'].match(/^description: (.+)$/m)[1], 'it triggers on the same words as the guide');
  assert.deepEqual(skill.install({ dir }).installed.length, 1, 'its own entry is refreshed');

  const own = mkdtempSync(join(tmpdir(), 'ad-skill-own-'));
  mkdirSync(join(own, 'slipwing'));
  writeFileSync(join(own, 'slipwing', 'SKILL.md'), '# the user\'s own notes');
  const kept = skill.install({ dir: own });
  assert.deepEqual(kept.installed, []);
  assert.equal(readFileSync(join(own, 'slipwing', 'SKILL.md'), 'utf8'), '# the user\'s own notes');
  assert.equal(skill.install({ dir: own, force: true }).installed.length, 1);
});
