'use strict';

const { setTimeout: delay } = require('node:timers/promises');

/** Helpers only the background browser has; on screen they are refused rather than run against another page. */
const BACKGROUND_ONLY = ['eval', 'table', 'fetch', 'cmd', 'selection', 'value'];

function refused(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGS' });
}

/**
 * web.* for the ways of working that happen on screen (watch and record): the same helper names, done in the Chrome
 * window the user can see, through visible.* with the real mouse and keyboard at the script's pace. A script written
 * for the background browser runs unchanged where the user can follow it.
 */
function screenWeb(visible) {
  const plain = (name, options) => {
    if (options?.near !== undefined) throw refused('web.' + name + ' {near} works in the background browser only; on screen use {nth} or {role}.');
  };
  const backgroundOnly = name => () => {
    throw refused('web.' + name + ' works in the background browser only. On screen, read the page with web.read() or web.text(), or run this part with --mode background.');
  };
  const web = {
    open: url => visible.open(url),
    read: () => visible.read(),
    text: async target => {
      if (target !== undefined) backgroundOnly('text(target)')();
      return (await visible.read()).text;
    },
    fill: (target, value, options) => { plain('fill', options); return visible.type(target, String(value), { replace: true }); },
    type: (target, text, options = {}) => { plain('type', options); return visible.type(target, text, { multiline: options.multiline, at: options.at }); },
    click: (target, options = {}) => { plain('click', options); return visible.click(target, { role: options.role, nth: options.nth, expectText: options.expectText }); },
    select: (target, ...choices) => {
      if (choices.length !== 1) throw refused('On screen web.select picks one option at a time.');
      return visible.select(target, choices[0]);
    },
    check: (target, options) => { plain('check', options); return visible.choose(target); },
    uncheck: (target, options) => { plain('uncheck', options); return visible.choose(target, { off: true }); },
    press: key => visible.press(key),
    waitText: (text, timeout) => visible.waitText(text, timeout),
    waitFor: (target, options = {}) => visible.waitFor(target, { timeout: options.timeout }),
    waitIdle: options => visible.waitIdle(options),
    has: target => visible.has(target),
    url: async () => (await visible.read()).url,
    title: async () => (await visible.read()).title,
    sleep: ms => delay(ms),
  };
  for (const name of BACKGROUND_ONLY) web[name] = backgroundOnly(name);
  return web;
}

module.exports = { screenWeb, BACKGROUND_ONLY };
