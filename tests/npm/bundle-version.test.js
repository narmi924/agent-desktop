'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bundle, versionReport, base } = require('../../npm/lib/bundle-version');

test('the bundle names its own version and the official release each part is built on', () => {
  const info = bundle();
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  for (const name of ['agent-desktop', 'agent-browser']) {
    const part = info.upstream[name];
    assert.match(part.repository, new RegExp('^https://github.com/vercel-labs/' + name + '$'));
    assert.match(part.tag, /^v\d+\.\d+\.\d+$/);
    assert.ok(Number.isInteger(part.commits_after_tag) && part.commits_after_tag >= 0);
    assert.match(part.commit, /^[0-9a-f]{40}$/);
  }
});

test('the version report says the base as tag, commits after it and the commit', () => {
  assert.equal(base({ tag: 'v1.3.1', commits_after_tag: 6, commit: 'e8934a5e95e1d212c74ead95cd3e4701c04eca31' }), 'v1.3.1+6 (e8934a5e)');
  assert.equal(base({ tag: 'v1.4.0', commits_after_tag: 0, commit: 'abcdef0123456789abcdef0123456789abcdef01' }), 'v1.4.0 (abcdef01)');
  const report = versionReport({});
  assert.equal(report.name, 'Slipwing');
  assert.equal(report.version, bundle().version);
  assert.equal(report['agent-desktop'].installed, undefined, 'a missing program is left out, not guessed');
  assert.match(report['agent-browser'].based_on, /^v\d+\.\d+\.\d+/);
});
