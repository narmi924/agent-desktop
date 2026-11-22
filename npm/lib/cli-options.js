'use strict';

/** The options each workflow command accepts. The command line and the MCP tools both read this table. */
const COMMAND_OPTIONS = {
  connect: ['cdp'],
  disconnect: [],
  current: ['window', 'page', 'visible'],
  follow: ['page', 'link', 'button', 'expect-url', 'visible', 'human', 'seed'],
  choose: ['page', 'session', 'tab', 'field', 'input', 'value', 'position', 'format', 'within', 'open', 'popup', 'advance', 'search', 'confirm', 'expect-value'],
  reveal: ['session', 'tab', 'within', 'text'],
  'choose-file': ['session', 'tab', 'input', 'file'],
  view: ['window', 'app', 'output', 'region', 'popups'],
  type: ['page', 'field', 'value', 'stdin', 'interval-ms', 'multiline', 'replace', 'at', 'after', 'human', 'seed'],
  wheel: ['page', 'over', 'lines', 'until', 'human', 'seed'],
  point: ['page', 'on', 'role', 'nth', 'expect-text', 'human', 'seed'],
  click: ['page', 'on', 'role', 'nth', 'expect-text', 'human', 'seed'],
  edit: ['window', 'app', 'document', 'field', 'value', 'stdin', 'page'],
  move: ['frame', 'from', 'to-frame', 'to', 'after', 'human', 'seed'],
  tap: ['frame', 'at', 'text', 'nth', 'button', 'count', 'human', 'seed'],
  replay: ['file', 'window', 'speed'],
  'browser-move': ['session', 'tab', 'surface', 'from', 'to', 'object', 'after'],
  'drop-file': ['session', 'tab', 'input', 'file'],
  run: ['file', 'session', 'chrome', 'space', 'timeout-ms', 'api', 'allow-input', 'allow-final', 'args', 'args-file', 'save', 'about', 'param', 'replace', 'detach', 'mode'],
  routine: ['args', 'args-file', 'allow-input', 'allow-final', 'session', 'chrome', 'space', 'timeout-ms', 'for', 'detach', 'mode'],
  prefs: ['project', 'always', 'routine', 'dir'],
  job: ['timeout-ms', 'target', 'options', 'file', 'value', 'force', 'for', 'all'],
  host: [],
  'job-run': [],
  watch: ['window', 'text', 'in', 'gone', 'every-ms', 'notification', 'file', 'then', 'args', 'args-file', 'timeout-ms', 'allow-final'],
  space: ['login', 'close'],
  read: ['url'],
  mcp: [],
  skill: ['list', 'install', 'dir', 'force'],
};

const BOOLEAN_OPTIONS = ['stdin', 'multiline', 'replace', 'visible', 'popups', 'chrome', 'api', 'space', 'close', 'allow-input', 'allow-final', 'detach', 'force', 'gone', 'all', 'project', 'always', 'list', 'install'];
const MULTIPLE_OPTIONS = ['param'];
const POSITIONAL_COMMANDS = ['routine', 'job', 'host', 'job-run', 'watch', 'prefs', 'skill'];

/** The `node:util` parseArgs options for one command. */
function parseOptions(command) {
  return Object.fromEntries(COMMAND_OPTIONS[command].map(key => [key, {
    type: BOOLEAN_OPTIONS.includes(key) ? 'boolean' : 'string', ...(MULTIPLE_OPTIONS.includes(key) ? { multiple: true } : {}),
  }]));
}

module.exports = { COMMAND_OPTIONS, BOOLEAN_OPTIONS, MULTIPLE_OPTIONS, POSITIONAL_COMMANDS, parseOptions };
