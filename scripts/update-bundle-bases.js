#!/usr/bin/env node
'use strict';
// Records in npm/bundle.json which official commits this bundle is built on, after merging an official update.
// Usage: node scripts/update-bundle-bases.js [--browser-repo PATH] [--remote upstream]
// Both repositories need the official remote fetched; each base is the official main the personal branch contains.
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const desktopRepo = resolve(__dirname, '..');
const browserRepo = resolve(option('--browser-repo', join(desktopRepo, '..', 'agent-browser')));
const remote = option('--remote', 'upstream');

function base(repo) {
  const git = (...words) => execFileSync('git', ['-C', repo, ...words], { encoding: 'utf8' }).trim();
  const ref = remote + '/main';
  try { git('merge-base', '--is-ancestor', ref, 'HEAD'); } catch {
    throw new Error(repo + ': HEAD does not contain ' + ref + '; merge the official update first.');
  }
  const tag = git('describe', '--tags', '--abbrev=0', ref);
  return { tag, commits_after_tag: Number(git('rev-list', '--count', tag + '..' + ref)), commit: git('rev-parse', ref) };
}

const file = join(desktopRepo, 'npm', 'bundle.json');
const bundle = JSON.parse(readFileSync(file, 'utf8'));
for (const [name, repo] of [['agent-desktop', desktopRepo], ['agent-browser', browserRepo]]) {
  bundle.upstream[name] = { repository: bundle.upstream[name].repository, ...base(repo) };
}
writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
console.log(JSON.stringify(bundle.upstream, null, 2));
