'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const home = mkdtempSync(join(tmpdir(), 'ad-mcp-'));
process.env.AGENT_DESKTOP_HOME = home;

const { TOOLS, toArgv, definition } = require('../../npm/lib/mcp-server');
const { COMMAND_OPTIONS } = require('../../npm/lib/cli-options');

const workflow = join(__dirname, '..', '..', 'npm', 'bin', 'workflow.js');

/** Starts the server, sends the messages, and returns the replies by id once every request has one. */
function session(messages, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AGENT_DESKTOP_HOME: home };
    delete env.AGENT_DESKTOP_POINTER;
    const child = spawn(process.execPath, [workflow, 'mcp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const wanted = messages.filter(m => m.id !== undefined).length;
    const replies = {};
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no reply in time: ' + JSON.stringify(replies))); }, 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        replies[message.id] = message;
        if (Object.keys(replies).length === wanted) { clearTimeout(timer); child.stdin.end(); resolve(replies); }
      }
    });
    for (const message of messages) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  });
}

const call = (id, name, args) => ({ id, method: 'tools/call', params: { name, arguments: args } });

function sample(schema) {
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer') return 5;
  if (schema.type === 'object') return { a: 1 };
  if (schema.type === 'array') return [schema.items.enum?.[0] ?? 'x'];
  return 'x';
}

test('initialize answers with a version the client knows and the working rules', async () => {
  const replies = await session([{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { id: 2, method: 'ping' }]);
  assert.equal(replies[1].result.protocolVersion, '2025-06-18');
  assert.equal(replies[1].result.serverInfo.name, 'agent-desktop-workflow');
  assert.match(replies[1].result.instructions, /workflow_guide/);
  assert.deepEqual(replies[2].result, { resultType: 'complete' });
});

test('every tool argument becomes an option its command accepts, so the tools cannot drift from the command line', () => {
  for (const tool of TOOLS) {
    const input = Object.fromEntries(Object.entries(tool.properties).map(([name, schema]) => [name, sample(schema)]));
    if (tool.name === 'workflow_prefs_set') Object.assign(input, { scope: 'project', mode: 'record' });
    if (tool.name === 'workflow_prefs_unset') Object.assign(input, { scope: 'always' });
    const { argv, files } = toArgv(tool, input);
    for (const path of files) rmSync(path, { force: true });
    const allowed = COMMAND_OPTIONS[tool.command[0]];
    for (const word of argv.filter(w => w.startsWith('--'))) assert.ok(allowed.includes(word.slice(2)), tool.name + ' passes ' + word);
    const def = definition(tool);
    assert.equal(def.inputSchema.type, 'object');
    assert.equal(def.inputSchema.additionalProperties, false);
  }
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length);
});

test('a script runs through the command line, its reply is the structured result, and its temporary files are gone', async () => {
  const replies = await session([
    call(1, 'workflow_run', { script: 'return 1 + args.n;', args: { n: 41 } }),
    call(2, 'workflow_run', { script: 'return (;' }),
    call(3, 'workflow_run', { script: 'return 1;', colour: 'red' }),
  ]);
  assert.equal(replies[1].result.isError, false);
  assert.equal(replies[1].result.structuredContent.data.result, 42);
  assert.deepEqual(replies[1].result.structuredContent.data.mode, { name: 'background', from: 'built-in' });
  assert.equal(replies[2].result.isError, true);
  assert.equal(replies[2].result.structuredContent.code, 'INVALID_ARGS');
  assert.equal(replies[3].result.isError, true);
  assert.match(replies[3].result.content[0].text, /no argument colour/);
  const temp = join(home, 'mcp');
  assert.deepEqual(existsSync(temp) ? readdirSync(temp) : [], [], 'scripts and arguments written for a call are removed after it: ' + temp);
});

test('a mouse-taking script without the user\'s word is refused the same way as on the command line', async () => {
  const replies = await session([call(1, 'workflow_run', { script: 'human("natural"); return 1;' })]);
  assert.equal(replies[1].result.isError, true);
  assert.equal(replies[1].result.structuredContent.code, 'INPUT_NOT_ALLOWED');
});

test('preferences set through the tools apply to the folder they name', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ad-mcp-project-'));
  const set = await session([call(1, 'workflow_prefs_set', { mode: 'record', scope: 'project', dir: project }), call(3, 'workflow_prefs_set', { scope: 'always' })]);
  assert.equal(set[1].result.isError, false);
  assert.equal(set[3].result.isError, true, 'a set with nothing to set is refused');
  const read = await session([call(2, 'workflow_prefs', { dir: project })]);
  assert.deepEqual(read[2].result.structuredContent.data.mode, { value: 'record', from: 'project' }, 'calls run concurrently, so the read waits for the set to answer');
});

test('the guide carries the routes, the ways of working and the script helpers', async () => {
  const replies = await session([call(1, 'workflow_guide', {})]);
  const text = replies[1].result.content[0].text;
  assert.match(text, /fastest route/);
  assert.match(text, /\| record \|/);
  assert.match(text, /body of an async function/, 'the helper list from run --api follows the guide');
});
