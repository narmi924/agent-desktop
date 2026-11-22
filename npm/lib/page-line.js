'use strict';

const LINE = /^(\s*)- (\S+?)(?: "((?:[^"\\]|\\.)*)")?(?: \[(.*)\])?(?:: (.*))?$/;
/** Roles that run inside a line of text instead of starting one. */
const INLINE = new Set(['StaticText', 'text', 'strong', 'emphasis', 'mark', 'code', 'subscript', 'superscript', 'deletion',
  'insertion', 'time', 'abbr', 'link', 'ListMarker', 'LineBreak']);
/** Controls whose name or value is not part of the sentence around them. */
const WIDGETS = new Set(['button', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch',
  'option', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab']);
const LONG = 200;
const END = /[。！？!?；;\n]|\.(?=\s)/;

const unquote = text => (text === undefined ? '' : text.replace(/\\(.)/g, '$1'));
const clean = text => text.replace(/\s+/g, ' ').trim();
const squeeze = text => text.replace(/\s+/g, '');

/** The lines of a page read as a tree. */
function textTree(snapshot) {
  const nodes = [], stack = [];
  for (const raw of String(snapshot ?? '').split('\n')) {
    const match = LINE.exec(raw);
    if (!match) continue;
    const [, indent, role, name, attributes = '', value = ''] = match;
    const node = { role, name: unquote(name), value: unquote(value), ref: /(?:^|, )ref=e\d+/.test(attributes), depth: indent.length, children: [] };
    while (stack.length && stack.at(-1).depth >= node.depth) stack.pop();
    node.parent = stack.at(-1);
    node.parent?.children.push(node);
    stack.push(node);
    nodes.push(node);
  }
  return nodes;
}

/** The text a node shows, its children joined as the page runs them together. */
function said(node) {
  if (node.role === 'ListMarker' || (node.ref && WIDGETS.has(node.role))) return '';
  if (!node.children.length) return node.name || node.value;
  return node.children.map(child => (INLINE.has(child.role) ? said(child) : ' ' + said(child) + ' ')).join('');
}

/** The sentence of a long line that holds the text. */
function sentence(line, text) {
  if (line.length <= LONG) return line;
  const at = line.indexOf(text);
  if (at < 0) return undefined;
  let start = at;
  while (start > 0 && !END.test(line[start - 1])) start--;
  let end = at + text.length;
  while (end < line.length && !END.test(line[end])) end++;
  const piece = clean(line.slice(start, Math.min(line.length, end + 1)));
  return piece.length <= LONG * 2 ? piece : undefined;
}

/**
 * The whole line or sentence of the page that shows the text: the text of the nearest paragraph, cell, list item or
 * other block around it, inline parts such as bold numbers and links joined in. A page that splits one sentence over
 * several text nodes still gives the sentence. Undefined when no plain text on the page holds it.
 */
function lineAround(snapshot, text) {
  const nodes = textTree(snapshot);
  const wanted = squeeze(text);
  if (!wanted) return undefined;
  const lineOf = node => {
    let at = node;
    while (at.parent && INLINE.has(at.role)) at = at.parent;
    return at;
  };
  const hit = nodes.find(node => !node.ref && (node.name || node.value).includes(text));
  if (hit) {
    const line = clean(said(lineOf(hit)));
    if (squeeze(line).includes(wanted)) return sentence(line, text) ?? clean(hit.name || hit.value);
  }
  let best;
  for (const node of nodes) {
    if (node.ref && WIDGETS.has(node.role)) continue;
    if (INLINE.has(node.role) && node.parent) continue;
    const line = clean(said(node));
    if (squeeze(line).includes(wanted) && (!best || node.depth > best.node.depth)) best = { node, line };
  }
  return best ? sentence(best.line, text) ?? text : undefined;
}

module.exports = { lineAround, textTree };
