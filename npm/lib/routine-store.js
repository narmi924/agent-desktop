'use strict';

const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;
const KEEP_VERSIONS = 10;

function stateDir() {
  return process.env.AGENT_DESKTOP_HOME || join(homedir(), '.agent-desktop');
}

/** Create the Windows state root with the permissions required by the native CLI. */
function initializeStateDir() {
  if (process.platform !== 'win32' || existsSync(stateDir())) return;
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const initialize = readFileSync(join(__dirname, '..', 'scripts', 'initialize-state.ps1'), 'utf8');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', initialize], { windowsHide: true, stdio: 'inherit' });
}

function routinesDir() {
  return join(stateDir(), 'routines');
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw Object.assign(new Error('A routine name is letters, digits, "-", "_" or ".", at most 64, for example weekly-orders.'), { code: 'INVALID_ARGS' });
  }
  return name;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Writes through a temporary file so a reader never sees half a file. */
function writeJson(path, value) {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

const indexPath = () => join(routinesDir(), 'index.json');

/** The addresses a routine opens, as its saved steps show them, so a search for a page path finds it. */
function pagesOf(routine) {
  return (routine.steps ?? []).map(step => /^(?:web|visible)\.open (.+)$/.exec(step.label)?.[1]).filter(Boolean);
}

function summary(routine) {
  return {
    about: routine.about, params: routine.params.map(p => p.name), input: routine.input, finals: routine.finals.length,
    status: routine.status, successes: routine.successes, failures: routine.failures, apps: routine.apps, hosts: routine.hosts,
    pages: pagesOf(routine), last_success: routine.last_success,
  };
}

/** The index of saved routines; one written before it listed their addresses is built again. */
function readIndex() {
  const index = readJson(indexPath(), undefined);
  return index && Object.values(index.routines ?? {}).every(r => Array.isArray(r.pages)) ? index : rebuildIndex();
}

function rebuildIndex() {
  const routines = {};
  let names = [];
  try { names = readdirSync(routinesDir(), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* No routines yet. */ }
  for (const name of names) {
    const routine = readJson(join(routinesDir(), name, 'routine.json'), undefined);
    if (routine) routines[name] = summary(routine);
  }
  mkdirSync(routinesDir(), { recursive: true });
  writeJson(indexPath(), { routines });
  return { routines };
}

function updateIndex(name, routine) {
  const index = readIndex();
  if (routine) index.routines[name] = summary(routine); else delete index.routines[name];
  writeJson(indexPath(), index);
}

function load(name) {
  checkName(name);
  const dir = join(routinesDir(), name);
  const routine = readJson(join(dir, 'routine.json'), undefined);
  if (!routine) throw Object.assign(new Error('No routine is named "' + name + '". routine list shows the saved ones.'), { code: 'ROUTINE_NOT_FOUND' });
  return { ...routine, script: readFileSync(join(dir, 'script.js'), 'utf8') };
}

function exists(name) {
  return existsSync(join(routinesDir(), checkName(name), 'routine.json'));
}

/** Keeps the routine that is being replaced under versions/<n>, the newest ten. */
function archive(dir, routine) {
  const versions = join(dir, 'versions');
  const target = join(versions, String(routine.version));
  mkdirSync(target, { recursive: true });
  for (const file of ['routine.json', 'script.js']) {
    if (existsSync(join(dir, file))) writeFileSync(join(target, file), readFileSync(join(dir, file)));
  }
  const kept = readdirSync(versions).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  for (const old of kept.slice(KEEP_VERSIONS)) rmSync(join(versions, String(old)), { recursive: true, force: true });
}

/** Stores a routine. An existing name needs replace: true, and the old one is kept as a version. */
function save(routine, script, { replace = false } = {}) {
  const dir = join(routinesDir(), checkName(routine.name));
  const previous = readJson(join(dir, 'routine.json'), undefined);
  if (previous && !replace) {
    throw Object.assign(new Error('A routine named "' + routine.name + '" exists. Add --replace to save over it; the old one is kept as a version.'), { code: 'ROUTINE_EXISTS' });
  }
  mkdirSync(dir, { recursive: true });
  if (previous) archive(dir, previous);
  const stored = { ...routine, version: (previous?.version ?? 0) + 1, created: previous?.created ?? routine.updated };
  writeFileSync(join(dir, 'script.js'), script);
  writeJson(join(dir, 'routine.json'), stored);
  updateIndex(routine.name, stored);
  return stored;
}

/** Writes back counters and learned expectations without making a new version. */
function update(name, change) {
  const dir = join(routinesDir(), checkName(name));
  const current = readJson(join(dir, 'routine.json'), undefined);
  if (!current) return undefined;
  const next = change(current);
  writeJson(join(dir, 'routine.json'), next);
  updateIndex(name, next);
  return next;
}

function remove(name) {
  const dir = join(routinesDir(), checkName(name));
  if (!existsSync(join(dir, 'routine.json'))) throw Object.assign(new Error('No routine is named "' + name + '".'), { code: 'ROUTINE_NOT_FOUND' });
  rmSync(dir, { recursive: true, force: true });
  updateIndex(name, undefined);
}

module.exports = { stateDir, initializeStateDir, routinesDir, checkName, readIndex, rebuildIndex, load, exists, save, update, remove };
