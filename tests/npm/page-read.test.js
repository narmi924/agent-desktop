'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { readPage } = require('../../npm/lib/page-read');

const FULL = '正文'.repeat(400);

/** Answers the plain request and the browser read with the given text, error or delay. */
function fakeBrowser({ request, browser }) {
  const answer = async ({ text, error, after = 0 }) => {
    await delay(after);
    if (error) throw new Error(error);
    return { content: text };
  };
  return async (binary, args) => {
    if (args.includes('open')) return {};
    return answer(args.includes('--session') ? browser : request);
  };
}

test('the first full answer wins without waiting for the slower way', async () => {
  const page = await readPage('ab', 'https://example.com/a', fakeBrowser({ request: { text: FULL }, browser: { text: FULL + 'x', after: 5000 } }));
  assert.deepEqual([page.via, page.text.length, page.thin], ['request', FULL.length, undefined]);
});

test('a script-built page that is empty to a plain request is read from the browser', async () => {
  const page = await readPage('ab', 'https://example.com/app', fakeBrowser({ request: { text: 'Loading' }, browser: { text: FULL, after: 30 } }));
  assert.equal(page.via, 'browser');
});

test('a site that turns the browser away is read from the plain request', async () => {
  const page = await readPage('ab', 'https://example.com/b', fakeBrowser({ request: { text: FULL, after: 30 }, browser: { error: 'Navigation failed' } }));
  assert.equal(page.via, 'request');
});

test('two short answers return the longer one marked thin, and two failures are an error', async () => {
  const page = await readPage('ab', 'https://example.com/c', fakeBrowser({ request: { text: 'ab' }, browser: { text: 'abcd' } }));
  assert.deepEqual([page.via, page.text, page.thin], ['browser', 'abcd', true]);
  await assert.rejects(readPage('ab', 'https://example.com/d', fakeBrowser({ request: { error: 'HTTP 403' }, browser: { error: 'refused' } })), /HTTP 403; refused/);
});

test('only web addresses are read', async () => {
  await assert.rejects(readPage('ab', 'file:///C:/Users/me/notes.txt', async () => ({ content: FULL })), /http or https/);
});
