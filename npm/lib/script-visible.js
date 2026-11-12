'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const TICKS = ['radiobutton', 'checkbox', 'switch'];
const CONFIRM_MS = 2500;
const MAX_READ_MS = 12000;
const VIEW_LIMIT = 6000;
const REBIND = /navigated|Read the selected page again|no longer selected/i;

/** How long a person takes to read `text`: Chinese by the character, other text by the word. */
function readingMs(text, random = Math.random) {
  const value = String(text ?? '');
  const han = (value.match(/[㐀-鿿]/g) ?? []).length;
  const words = (value.replace(/[㐀-鿿]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (!han && !words) return 0;
  return Math.round(Math.min(350 + han * 130 + words * 250, MAX_READ_MS) * (0.85 + 0.3 * random()));
}

/**
 * Helpers for the page in the browser window the user can see, acted on with the real mouse and
 * keyboard. One helper is one thing a person does: tick a choice, type into a field, scroll until a
 * text shows. `pace()` is the human pace the script asked for, if any. Every command is marked
 * `visible`, so none of them is handed to a background browser connection.
 */
function createVisible({ flow, step, warn, pace }) {
  let handle, windowId;
  const human = () => ({ visible: true, ...(pace() ? { human: pace() } : {}) });

  async function bind(window = windowId) {
    const page = await flow('current', { visible: true, ...(window ? { window } : {}) });
    handle = page.page;
    windowId = page.window;
    return page;
  }

  /** A page that changed since it was bound is bound again, as long as nothing was sent yet. */
  async function on(run) {
    if (!handle) await bind();
    try { return await run(handle); } catch (err) {
      if (err.disposition || !REBIND.test(err.message)) throw err;
      await bind();
      return run(handle);
    }
  }

  /**
   * A control further down or up the page is scrolled to with the wheel, the way a person gets to it,
   * and the action is tried once more. Nothing was sent when a control is reported as not on screen.
   */
  async function reaching(name, run) {
    try { return await on(run); } catch (err) {
      if (err.code !== 'NOT_ON_SCREEN') throw err;
    }
    for (const lines of ['4', '-4']) {
      const report = await on(page => flow('wheel', { page, until: name, lines, ...human() }));
      if (report.verified) return on(run);
    }
    throw Object.assign(new Error('"' + name + '" is on the page, but scrolling did not bring it onto the screen.'), { code: 'ELEMENT_NOT_FOUND' });
  }

  const shown = page => ({ title: page.title, url: page.url, text: page.text,
    controls: page.controls.map(({ role, name, checked }) => ({ role, name, ...(checked ? { checked } : {}) })) });

  const visible = {
    use: window => step('visible.use', window ?? '', async () => shown(await bind(window))),
    read: () => step('visible.read', '', async () => shown(await bind())),
    click: (name, { role, nth, expectText } = {}) => step('visible.click', name, () => reaching(name, page => flow('click',
      { page, on: name, role, nth: nth === undefined ? undefined : String(nth), 'expect-text': expectText, ...human() }))),
    hover: (name, { role, nth } = {}) => step('visible.hover', name, () => reaching(name, page => flow('point',
      { page, on: name, role, nth: nth === undefined ? undefined : String(nth), ...human() }))),
    choose: (name, { off = false } = {}) => step('visible.choose', name, async () => {
      const find = page => page.controls.filter(control => control.name === name && TICKS.includes(control.role));
      const boxes = find(await bind());
      if (boxes.length !== 1) {
        throw Object.assign(new Error((boxes.length ? boxes.length + ' choices are' : 'No radio button or checkbox is') + ' named "' + name + '" on this page.'),
          { code: boxes.length ? 'AMBIGUOUS_TARGET' : 'ELEMENT_NOT_FOUND' });
      }
      const wanted = !off;
      if (off && boxes[0].role === 'radiobutton') throw Object.assign(new Error('A radio button is cleared by choosing another one.'), { code: 'INVALID_ARGS' });
      if (Boolean(boxes[0].checked) === wanted) return { changed: false, checked: wanted };
      await reaching(name, page => flow('click', { page, on: name, role: boxes[0].role, ...human() }));
      const until = Date.now() + CONFIRM_MS;
      let seen = 0;
      for (;;) {
        const now = find(await bind());
        seen += now.length;
        if (now.length === 1 && Boolean(now[0].checked) === wanted) return { changed: true, checked: wanted };
        if (Date.now() >= until) break;
        await delay(150);
      }
      if (!seen) return { changed: true, checked: null, gone: true };
      warn('visible.choose "' + name + '" was clicked, but the page does not show it as ' + (wanted ? 'selected' : 'cleared') + '.');
      return { changed: false, checked: !wanted };
    }),
    type: (field, text, { multiline, replace, at } = {}) => step('visible.type', field, async () => {
      const report = await on(page => flow('type', { page, field, value: String(text), multiline: multiline || undefined, replace: replace || undefined, at, ...human() }));
      if (!report.verified) warn('visible.type "' + field + '" sent the keys, but the field does not show the text. ' + (report.message ?? ''));
      return report.verified;
    }),
    scrollTo: (text, { over, lines } = {}) => step('visible.scrollTo', text, async () => {
      const report = await on(page => flow('wheel', { page, over, until: String(text), lines: lines === undefined ? undefined : String(lines), ...human() }));
      if (!report.verified) throw Object.assign(new Error('"' + text + '" did not come into view. ' + (report.message ?? '')), { code: 'ELEMENT_NOT_FOUND' });
      return true;
    }),
    scroll: (lines = 3, { over } = {}) => step('visible.scroll', lines, async () => {
      const report = await on(page => flow('wheel', { page, over, lines: String(lines), ...human() }));
      return Boolean(report.verified);
    }),
  };

  async function scene() {
    const page = shown(await bind());
    const view = [page.text, ...page.controls.map(control => '- ' + control.role + ' "' + control.name + '"' + (control.checked ? ' [checked]' : ''))].join('\n');
    return { surface: 'visible', url: page.url, title: page.title, view: view.length > VIEW_LIMIT ? view.slice(0, VIEW_LIMIT) + '\n… (cut)' : view };
  }

  return { visible, scene };
}

module.exports = { createVisible, readingMs };
