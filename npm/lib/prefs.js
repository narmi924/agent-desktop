'use strict';

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { stateDir } = require('./routine-store');

/**
 * The four ways of working. Each one names what a person sees; underneath it is only whether the real mouse and
 * keyboard may be used without asking again, whether pointer moves and typing take a human pace, and which pointer
 * shows while the agent has the input.
 */
const WAYS = {
  background: { input: false, pace: undefined, pointer: 'amber',
    about: 'Works in the background: no window comes to the front, the mouse and keyboard stay with the user. The default and usually the fastest.' },
  watch: { input: true, pace: 'natural', pointer: 'amber', screen: true,
    about: 'Works on the screen at a human pace with the amber agent pointer, web steps included, so the user can follow every step and knows not to touch.' },
  record: { input: true, pace: 'natural', pointer: 'off', screen: true,
    about: 'Works on the screen at a human pace with the user\'s own pointer, web steps included, for recordings and shared screens.' },
  direct: { input: true, pace: undefined, pointer: 'amber',
    about: 'Uses the real mouse and keyboard whenever a step needs them, without asking again and without a human pace.' },
};
const WAY_NAMES = { 后台: 'background', 看着做: 'watch', 录屏: 'record', 直接操作: 'direct' };
const BROWSERS = { background: 'a background browser with no sign-ins', chrome: 'the user\'s running Chrome (needs connect once)', space: 'the agent\'s own signed-in profile (space --login once)' };
const POINTERS = ['amber', 'red', 'green', 'off'];
const LAYERS = ['request', 'routine', 'project', 'everywhere'];
const KEYS = ['mode', 'pointer', 'browser'];

const WELCOME = [
  'First run on this computer. After the result, tell the user once, in their language, in about four lines:',
  'by default you work in the background and leave their mouse and keyboard alone;',
  'they can say "let me watch" to see it done on screen, "for a recording" to keep their own pointer and move like a person,',
  'or "use my browser" to work in their signed-in Chrome; you ask before anything that sends, pays or deletes;',
  'and if they say "from now on in this project ..." or "from now on ...", you remember it (prefs set).',
].join(' ');

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGS' });
const prefsPath = () => join(stateDir(), 'preferences.json');

function readPrefs() {
  const path = prefsPath();
  if (!existsSync(path)) return { exists: false, data: empty() };
  let data;
  try { data = JSON.parse(withoutMark(readFileSync(path, 'utf8'))); } catch (err) {
    throw invalid('The preferences file ' + path + ' is not valid JSON: ' + err.message);
  }
  return { exists: true, data: { ...empty(), ...data } };
}

function withoutMark(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function empty() {
  return { everywhere: {}, projects: {}, routines: {} };
}

/** Writes through a temporary file so a reader never sees half a file. */
function writePrefs(data) {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporary, path);
}

/** Creates the file with nothing set the first time a script runs; true when this was that first time. */
function firstUse() {
  if (existsSync(prefsPath())) return false;
  writePrefs(empty());
  return true;
}

/** A folder in the form the file keeps: absolute, forward slashes, no trailing slash. */
function folder(dir) {
  return resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The saved project that holds `dir`: the deepest saved folder that is `dir` or one of its parents. Windows paths match without case. */
function projectFor(dir, projects) {
  const here = folder(dir).toLowerCase();
  let best;
  for (const saved of Object.keys(projects)) {
    const key = folder(saved).toLowerCase();
    if ((here === key || here.startsWith(key + '/')) && (!best || key.length > folder(best).length)) best = saved;
  }
  return best;
}

function wayName(value) {
  const name = WAY_NAMES[String(value).trim()] ?? String(value).trim().toLowerCase();
  if (!Object.hasOwn(WAYS, name)) throw invalid('A way of working is one of ' + Object.keys(WAYS).join(', ') + ' (后台, 看着做, 录屏, 直接操作).');
  return name;
}

function check(key, value) {
  if (key === 'mode') return wayName(value);
  if (key === 'browser') {
    if (!Object.hasOwn(BROWSERS, value)) throw invalid('browser is one of ' + Object.keys(BROWSERS).join(', ') + '.');
    return value;
  }
  if (key === 'pointer') {
    if (POINTERS.includes(String(value).toLowerCase())) return String(value).toLowerCase();
    if (/\.png$/i.test(value)) return value;
    throw invalid('pointer is one of ' + POINTERS.join(', ') + ', or the path of a square PNG.');
  }
  throw invalid('The preferences are ' + KEYS.join(', ') + '.');
}

/**
 * What applies here, and which layer said it. The most specific layer wins: what the caller passed for this run,
 * then the routine being run, then the project folder the command runs in, then everywhere. A pointer the
 * environment already sets counts as said for this run.
 */
function resolveSettings({ cwd = process.cwd(), routine, request = {}, env = process.env, data = readPrefs().data } = {}) {
  const project = projectFor(cwd, data.projects ?? {});
  const layers = {
    request: { ...(request.mode ? { mode: wayName(request.mode) } : {}), ...(request.browser ? { browser: request.browser } : {}),
      ...(env.AGENT_DESKTOP_POINTER ? { pointer: env.AGENT_DESKTOP_POINTER } : {}) },
    routine: (routine && data.routines?.[routine]) || {},
    project: (project && data.projects[project]) || {},
    everywhere: data.everywhere ?? {},
  };
  const pick = key => {
    for (const layer of LAYERS) if (layers[layer][key] !== undefined) return { value: layers[layer][key], from: layer };
    return undefined;
  };
  const mode = pick('mode') ?? { value: 'background', from: 'built-in' };
  mode.value = wayName(mode.value);
  const pointer = pick('pointer') ?? { value: WAYS[mode.value].pointer, from: mode.from === 'built-in' ? 'built-in' : 'mode' };
  const browser = pick('browser') ?? { value: 'background', from: 'built-in' };
  return { mode, pointer, browser, ...(project ? { project } : {}) };
}

/**
 * The runner options a way of working turns into. A way that uses the screen, said by the caller, a routine, the
 * project or everywhere, is the user's standing word that the mouse and keyboard may be used. Flags the caller gave
 * stay as they are.
 */
function runnerOptions(settings, values) {
  const way = WAYS[settings.mode.value];
  const own = values.session || values.chrome || values.space;
  return {
    ...values,
    ...(way.input ? { 'allow-input': true } : {}),
    ...(way.pace ? { pace: way.pace } : {}),
    ...(way.screen ? { screen: true } : {}),
    ...(settings.pointer.from !== 'built-in' ? { pointer: settings.pointer.value } : {}),
    ...(!own && settings.browser.value === 'chrome' ? { chrome: true } : {}),
    ...(!own && settings.browser.value === 'space' ? { space: true } : {}),
  };
}

/** The part of the reply that says which way this run worked and where that came from. */
function settingsNote(settings) {
  return {
    mode: { name: settings.mode.value, from: settings.mode.from },
    ...(['request', 'built-in', 'mode'].includes(settings.pointer.from) ? {} : { pointer: settings.pointer }),
    ...(['request', 'built-in'].includes(settings.browser.from) ? {} : { browser: settings.browser }),
  };
}

function scopeOf({ project, always, routine, dir }, cwd) {
  const chosen = [project || dir, always, routine].filter(Boolean).length;
  if (chosen !== 1) throw invalid('Say where it applies: --project (this folder), --dir FOLDER, --always (everywhere) or --routine NAME.');
  if (always) return { layer: 'everywhere' };
  if (routine) return { layer: 'routines', key: routine };
  return { layer: 'projects', key: folder(dir ?? cwd) };
}

function describe(cwd, data = readPrefs().data) {
  const settings = resolveSettings({ cwd, data });
  return {
    here: folder(cwd), ...(settings.project ? { project: settings.project } : {}),
    mode: settings.mode, pointer: settings.pointer, browser: settings.browser,
    ways: Object.fromEntries(Object.entries(WAYS).map(([name, way]) => [name, way.about])),
    browsers: BROWSERS,
    file: prefsPath(), saved: data,
    change: 'prefs set mode=WAY|pointer=amber,red,green,off,FILE.png|browser=background,chrome,space (--project | --dir FOLDER | --always | --routine NAME); prefs unset KEY with the same scope',
  };
}

/** `prefs`, `prefs set KEY=VALUE ... SCOPE`, `prefs unset KEY ... SCOPE`. */
function prefsCommand([action, ...pairs], values, cwd = process.cwd()) {
  if (action === undefined) return describe(values.dir ?? cwd);
  if (!['set', 'unset'].includes(action) || !pairs.length) throw invalid('prefs | prefs set KEY=VALUE [KEY=VALUE] SCOPE | prefs unset KEY SCOPE');
  const scope = scopeOf(values, cwd);
  const { data } = readPrefs();
  const target = scope.key ? (data[scope.layer][scope.key] ??= {}) : data[scope.layer];
  const changed = {};
  for (const pair of pairs) {
    if (action === 'set') {
      const at = pair.indexOf('=');
      if (at < 1) throw invalid('Write each preference as KEY=VALUE, for example mode=record.');
      const key = pair.slice(0, at).trim();
      target[key] = changed[key] = check(key, pair.slice(at + 1).trim());
    } else {
      if (!KEYS.includes(pair)) throw invalid('The preferences are ' + KEYS.join(', ') + '.');
      delete target[pair];
      changed[pair] = null;
    }
  }
  if (scope.key && !Object.keys(target).length) delete data[scope.layer][scope.key];
  writePrefs(data);
  const where = scope.layer === 'everywhere' ? 'everywhere' : scope.layer === 'routines' ? 'routine ' + scope.key : 'project ' + scope.key;
  return { [action === 'set' ? 'set' : 'unset']: changed, where, now: describe(values.dir ?? cwd, data) };
}

/** A routine saved with a way of working keeps it, so later runs of it work the same way. */
function rememberRoutineMode(name, mode) {
  const { data } = readPrefs();
  (data.routines[name] ??= {}).mode = wayName(mode);
  writePrefs(data);
}

module.exports = { WAYS, WELCOME, prefsPath, readPrefs, firstUse, resolveSettings, runnerOptions, settingsNote, prefsCommand, rememberRoutineMode, wayName, projectFor };
