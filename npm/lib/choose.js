'use strict';

// Serialized into the selected browser document. Keep DOM traversal in the
// page so looking through a list does not cost a CLI call per viewport.
async function prepareChoice({ field, input, value, position, format, key, url }, opened = false) {
  if (window !== top || location.href !== url) throw new Error('The original main document changed.');
  const text = s => (s ?? '').trim().replace(/\s+/g, ' ');
  const labelText = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.matches?.('input,select,textarea,button,[hidden],[aria-hidden="true"]')) return '';
    return [...node.childNodes].map(labelText).join('');
  };
  const name = el => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const label = text(ids.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(labelText).join(' '));
      if (label) return label;
    }
    return text(el.getAttribute('aria-label')) ||
      text(Array.from(el.labels ?? [], labelText).join(' ')) ||
      (el.getAttribute('role') === 'option' ? text(labelText(el)) : '');
  };
  const controls = () => {
    if (input) return [...document.querySelectorAll(input)];
    const named = [...document.querySelectorAll('input:not([type=hidden]),select,[role=listbox],[role=combobox]')]
      .filter(el => el.getClientRects().length && name(el) === text(field));
    return named.filter(el => !(el.getAttribute('role') === 'listbox' && named.some(other =>
      other.getAttribute('role') === 'combobox' && other.getAttribute('aria-controls') === el.id)));
  };
  const [owner, ...others] = controls();
  if (!owner || others.length) throw new Error('Expected one field: ' + (field || input) + ' (' + (others.length + Number(!!owner)) + ' matches).');
  const usable = el => el.isConnected && !el.closest('[inert],[aria-disabled="true"],[aria-hidden="true"]') &&
    !el.matches(':disabled') && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getClientRects().length > 0;
  if (!usable(owner)) throw new Error('The field is disabled or hidden.');
  const visibleName = name(owner) || input;
  const mark = (node, state) => {
    node.setAttribute(key, '');
    const clear = () => {
      clearTimeout(timer);
      node.removeAttribute(key);
      delete globalThis[key];
      window.removeEventListener('pagehide', clear);
    };
    const timer = setTimeout(clear, 20000);
    window.addEventListener('pagehide', clear, { once: true });
    globalThis[key] = { clear, ...state };
  };
  const combo = !(owner instanceof HTMLSelectElement) && owner.getAttribute('role') === 'combobox';
  let control = owner;
  if (combo) {
    if (owner.getAttribute('aria-readonly') === 'true' || (owner.getAttribute('aria-haspopup') ?? 'listbox') !== 'listbox') throw new Error('Expected an editable combobox with a listbox popup.');
    if (opened) {
      if (globalThis[key]?.owner !== owner) throw new Error('The original combobox changed.');
      globalThis[key].clear();
    }
    if (owner.getAttribute('aria-expanded') === 'false' && !opened) {
      mark(owner, { owner });
      return { action: 'open', selector: '[' + key + ']' };
    }
    const popup = () => {
      const id = owner.getAttribute('aria-controls');
      const elements = id ? document.querySelectorAll('#' + CSS.escape(id)) : [];
      return elements.length === 1 && elements[0].getAttribute('role') === 'listbox' && usable(elements[0]) ? elements[0] : null;
    };
    const until = Date.now() + 1200;
    while (!(control = popup()) || owner.getAttribute('aria-expanded') !== 'true') {
      if (!owner.isConnected || location.href !== url || Date.now() >= until) throw new Error('The combobox did not expose its own open listbox.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let target = control, action, argument, expected, read, setDate, kind, scrolls = 0;
  if (control instanceof HTMLSelectElement) {
    if (format || position || control.multiple) throw new Error('Expected a single-choice select and an exact option label.');
    const matches = [...control.options].filter(o => text(o.label) === text(value));
    if (matches.length !== 1) throw new Error('Expected one matching option, found ' + matches.length + '.');
    const option = matches[0];
    if (option.matches(':disabled') || option.closest('optgroup:disabled')) throw new Error('The option is disabled.');
    if ([...control.options].some(o => o !== option && (o.value === option.value || text(o.label) === text(option.value)))) throw new Error('The option value is ambiguous.');
    expected = text(option.label); argument = option.value; action = 'select'; kind = 'select';
    read = () => control.selectedOptions.length === 1 && control.selectedOptions[0] === option ? text(option.label) : null;
  } else if (control instanceof HTMLInputElement && (control.type === 'date' || (control.type === 'text' && format))) {
    if (position || control.readOnly || control.getAttribute('aria-readonly') === 'true') throw new Error('Expected an editable date field.');
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const day = new Date(value + 'T00:00:00Z');
    if (!parsed || !Number(parsed[1]) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== value) throw new Error('Use a valid calendar date in YYYY-MM-DD format.');
    const [, y, m, d] = parsed;
    const formats = { 'YYYY-MM-DD': value, 'MM/DD/YYYY': [m, d, y].join('/'), 'DD/MM/YYYY': [d, m, y].join('/') };
    if ((control.type === 'date' && format && format !== 'YYYY-MM-DD') || (format && !Object.hasOwn(formats, format))) throw new Error('Unsupported date format.');
    expected = formats[format ?? 'YYYY-MM-DD'];
    const probe = control.cloneNode(false);
    probe.value = expected;
    if (probe.value !== expected || !probe.validity.valid) throw new Error('The date is outside the field constraints.');
    argument = expected; action = control.type === 'date' ? 'date' : 'fill'; kind = 'date';
    read = () => control.validity.valid && control.getAttribute('aria-invalid') !== 'true' ? control.value : null;
    if (action === 'date') setDate = () => {
      if (control.type !== 'date' || control.readOnly || !usable(control)) throw new Error('The date field changed.');
      // A native date has separate localized edit segments. Use its ISO
      // value setter, then notify the application as for a committed edit.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(control, expected);
      control.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      if (!control.isConnected || controls()[0] !== control) throw new Error('The date field changed after input; inspect it before trying again.');
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
  } else if (control.getAttribute('role') === 'listbox') {
    if (format || control.getAttribute('aria-multiselectable') === 'true' || control.getAttribute('aria-readonly') === 'true') throw new Error('Expected an editable single-choice listbox.');
    const rows = () => [...control.querySelectorAll('[role=option]')].filter(o => o.closest('[role=listbox]') === control && o.getClientRects().length && !o.closest('[aria-hidden="true"]'));
    const rank = o => Number(o.getAttribute('aria-posinset'));
    const all = rows();
    const sizes = new Set(all.map(o => Number(o.getAttribute('aria-setsize'))));
    const total = sizes.size === 1 ? [...sizes][0] : 0;
    const ranked = all.length && total > 0 && all.every(o => Number.isInteger(rank(o)) && rank(o) >= 1 && rank(o) <= total);
    if (!all.length) throw new Error('The list has no available options.');
    if (!ranked && all.some(o => o.hasAttribute('aria-setsize') || o.hasAttribute('aria-posinset'))) throw new Error('List positions are incomplete.');
    if (position && (!ranked || position > total)) throw new Error('The list does not expose the requested position.');
    const options = items => items.filter(o => name(o) === text(value) && (!position || rank(o) === position));
    const partial = ranked && total > all.length;
    let matches = options(all);
    if (partial) {
      // Do not assume equal row heights. Use the ranks that the list actually
      // rendered after each scroll to narrow the physical scroll range.
      const origin = control.scrollTop;
      const end = Date.now() + 8000;
      const move = async top => {
        if (!control.isConnected || !usable(control) || controls()[0] !== owner || location.href !== url) throw new Error('The original list changed.');
        if (Date.now() >= end || ++scrolls > 512) throw new Error('List search limit reached; supply --position if known.');
        control.scrollTo({ top, behavior: 'instant' });
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 80);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        });
        const slice = rows();
        if (!slice.length || slice.some((o, i) => +o.getAttribute('aria-setsize') !== total || rank(o) < 1 || rank(o) > total || (i && rank(o) !== rank(slice[i - 1]) + 1))) throw new Error('List positions changed or were incomplete.');
        return slice;
      };
      const max = () => Math.max(0, control.scrollHeight - control.clientHeight);
      const seek = async n => {
        let low = 0, high = max();
        let offset = Math.round(high * (n - 1) / Math.max(1, total - 1));
        while (low <= high) {
          const slice = await move(offset);
          const at = slice.find(o => rank(o) === n);
          if (at) return at;
          if (n < rank(slice[0])) high = Math.floor(control.scrollTop) - 1;
          else low = Math.ceil(control.scrollTop) + 1;
          offset = Math.floor((low + high) / 2);
        }
        throw new Error('The list did not expose the requested position.');
      };
      try {
        let n = position;
        if (!n) {
          let covered = 0;
          for (let offset = 0; ; offset += Math.max(1, Math.floor(control.clientHeight * 0.85))) {
            const slice = await move(Math.min(offset, max()));
            if (rank(slice[0]) > covered + 1) throw new Error('The list skipped options; supply --position if known.');
            for (const o of options(slice).filter(o => rank(o) > covered)) {
              if (n) throw new Error('More than one option has that label; supply --position.');
              n = rank(o);
            }
            covered = Math.max(covered, rank(slice.at(-1)));
            if (covered === total) break;
            if (control.scrollTop >= max() - 1) throw new Error('The list ended before all positions were observed.');
          }
          if (!n) throw new Error('Option not found in the list.');
        }
        let found = await seek(n);
        const row = found.getBoundingClientRect(), box = control.getBoundingClientRect();
        if (row.top < box.top || row.bottom > box.bottom) {
          // The browser may otherwise click the center outside the clipped
          // scrollport, or scroll and recycle the node after it was marked.
          const centered = await move(control.scrollTop + (row.top + row.bottom - box.top - box.bottom) / 2);
          found = centered.find(o => rank(o) === n);
          if (!found) throw new Error('The option disappeared while bringing it into view.');
        }
        matches = name(found) === text(value) ? [found] : [];
        if (!matches.length) throw new Error('The label at the requested position does not match.');
      } catch (err) {
        if (control.isConnected && location.href === url) control.scrollTo({ top: origin, behavior: 'instant' });
        throw err;
      }
    } else if (!ranked && control.scrollHeight > control.clientHeight + 1) {
      const box = control.getBoundingClientRect(), first = all[0].getBoundingClientRect(), last = all.at(-1).getBoundingClientRect();
      if (first.top - box.top + control.scrollTop > control.clientHeight ||
          box.top + control.scrollHeight - control.scrollTop - last.bottom > control.clientHeight) throw new Error('Partially rendered list needs aria-posinset and aria-setsize.');
    }
    if (matches.length !== 1) throw new Error('Expected one matching option, found ' + matches.length + '.');
    target = matches[0]; const chosenRank = rank(target);
    action = 'click'; expected = text(value); kind = combo ? 'combobox' : 'listbox';
    read = () => {
      if (combo && owner.getAttribute('aria-expanded') === 'false') {
        // A collapsed popup can be removed from the DOM. Its owner must
        // expose the new value; a duplicate label also needs the chosen rank.
        const display = text(owner.value ?? owner.getAttribute('aria-valuetext') ?? owner.innerText);
        if (!position) return display;
        const chosen = [...control.querySelectorAll('[role=option][aria-selected="true"]')];
        return control.isConnected && chosen.length === 1 && rank(chosen[0]) === position ? display : null;
      }
      const selected = rows().filter(o => o.getAttribute('aria-selected') === 'true');
      return selected.length === 1 && (chosenRank ? rank(selected[0]) === chosenRank : selected[0] === target) ? name(selected[0]) : null;
    };
  } else {
    throw new Error('Use a date input, single select, listbox or combobox. For an editable text date, supply --format.');
  }
  if (location.href !== url) throw new Error('The original target changed.');
  const suffix = target.hasAttribute('aria-posinset') ? '[aria-posinset="' + CSS.escape(target.getAttribute('aria-posinset')) + '"]' : '';
  if (!usable(target)) throw new Error('The option is disabled or hidden.');
  mark(target, {
    check: () => {
      const current = controls();
      if (location.href !== url || current.length !== 1 || current[0] !== owner) throw new Error('The original field changed.');
    },
    setDate,
    read: () => {
      const actual = read();
      return actual === expected ? { field: visibleName, value: actual, ...(position ? { position } : {}), kind, scrolls } : null;
    },
  });
  return { action: !combo && read() === expected ? 'none' : action, selector: '[' + key + ']' + suffix, argument };
}

async function finishChoice(key, phase) {
  const state = globalThis[key];
  if (phase === 'clean') {
    state?.clear();
    delete globalThis[key];
    return;
  }
  if (!state) throw new Error('The original document changed.');
  state.check();
  if (phase === 'date') return state.setDate();
  const until = Date.now() + 1200;
  do {
    state.check();
    const selected = state.read();
    if (selected) return selected;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < until);
  throw new Error('The field did not confirm the requested selection. Inspect it before trying again.');
}

// For a plain scroll container the page may publish neither item positions
// nor selected state. Reveal a visible match without treating it as selected.
async function revealText(selector, wanted, url) {
  const nodes = () => document.querySelectorAll(selector);
  const [box] = nodes();
  if (window !== top || location.href !== url || nodes().length !== 1 || !box.clientHeight) throw new Error('Expected one visible scroll container in the original document.');
  const text = s => (s ?? '').trim().replace(/\s+/g,' ');
  const value = text(wanted);
  const origin = box.scrollTop, end = Date.now()+8000;
  let last = origin, moves = 0, interrupted = false;
  const stop = e => { if (e.type !== 'keydown' || e.key === 'Escape') interrupted = true; };
  const events = ['keydown','wheel','pointerdown','visibilitychange'];
  for (const event of events) document.addEventListener(event,stop,true);
  const check = () => {
    if (interrupted || location.href !== url || !box.isConnected || nodes().length !== 1 || nodes()[0] !== box || Math.abs(box.scrollTop-last)>1) throw new Error('Scroll interrupted or original container changed.');
  };
  const move = async y => {
    check();
    if (++moves > 512 || Date.now() >= end) throw new Error('Item not found within the search budget.');
    box.scrollTo({top:y,behavior:'instant'}); last = box.scrollTop;
    await new Promise(resolve => { const timer=setTimeout(resolve,80); requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();})); });
    check();
  };
  const match = () => {
    // Walk text nodes once. Only their ancestors can have this visible text;
    // avoid reading the full text of every subtree in a large list.
    const candidates = new Set(box.querySelectorAll('[aria-label]'));
    const walker = document.createTreeWalker(box,NodeFilter.SHOW_TEXT);
    for (let n; (n=walker.nextNode());) {
      if (!text(n.data) || !value.includes(text(n.data))) continue;
      for (let el=n.parentElement; el && el!==box; el=el.parentElement) candidates.add(el);
    }
    const found = [...candidates].filter(el => el.getClientRects().length && el.checkVisibility({visibilityProperty:true,opacityProperty:true}) &&
      !el.closest('[hidden],[aria-hidden="true"]') && text(el.getAttribute('aria-label') ?? el.innerText ?? el.textContent) === value);
    const leaves = found.filter(el=>!found.some(other=>el!==other && el.contains(other)));
    if (leaves.length>1) throw new Error('More than one rendered item has that text.');
    return leaves[0];
  };
  const reveal = async el => {
    let r=el.getBoundingClientRect(), b=box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) {
      await move(box.scrollTop + (r.top+r.bottom-b.top-b.bottom)/2);
      el=match();
      if (!el) throw new Error('Item changed while scrolling into view.');
      r=el.getBoundingClientRect(); b=box.getBoundingClientRect();
    }
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
      box.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      check();
      r=el.getBoundingClientRect(); b=box.getBoundingClientRect();
    }
    const x=Math.max(r.left,b.left,0), right=Math.min(r.right,b.right,innerWidth);
    const y=Math.max(r.top,b.top,0), bottom=Math.min(r.bottom,b.bottom,innerHeight);
    if (x>=right || y>=bottom) throw new Error('Item is not visible in this viewport.');
    const at=document.elementFromPoint((x+right)/2,(y+bottom)/2);
    if (!at || !(el.contains(at) || at.contains(el))) throw new Error('Another element covers the item.');
    return {text:value,visible:true,scope:'rendered',moves};
  };
  // Probe text order only to find positive matches. An unordered or changing
  // slice can never exclude a part of the ordinary scan.
  const compare = new Intl.Collator(undefined, {numeric:true}).compare;
  function orderedSlice() {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const labels = [];
    const viewport = box.getBoundingClientRect();
    for (let n; (n = walker.nextNode());) {
      const label = text(n.data), el = n.parentElement;
      if (!label || !el || !el.getClientRects().length) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || el.closest('[hidden],[aria-hidden="true"]')) continue;
      labels.push(label);
    }
    if (labels.length < 2) return;
    const direction = Math.sign(compare(labels.at(-1),labels[0]));
    if (!direction || labels.slice(1).some((label,i) => direction * compare(label,labels[i]) <= 0)) return;
    return {first:labels[0],last:labels.at(-1),direction};
  }
  async function seek() {
    const max = box.scrollHeight - box.clientHeight;
    if (max < box.clientHeight * 8) return;
    const initial = orderedSlice();
    if (!initial) return;
    const order = (a,b) => initial.direction * compare(a,b);
    let low = 0, high = max;
    if (order(value,initial.first) < 0) high = Math.floor(origin)-1;
    else if (order(value,initial.last) > 0) low = Math.floor(origin + box.clientHeight);
    else return;
    for (let i = 0; i < 18 && high >= low; i++) {
      const offset = Math.floor((low+high)/2);
      await move(offset);
      const hit = match();
      if (hit) return hit;
      const slice = orderedSlice();
      if (!slice || slice.direction !== initial.direction || box.scrollHeight - box.clientHeight !== max) return;
      if (order(value,slice.first) < 0) high = offset-1;
      else if (order(value,slice.last) > 0) low = offset + box.clientHeight;
      else return;
    }
  }
  function bufferedStep() {
    const viewport = box.getBoundingClientRect();
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let bottom = viewport.top;
    for (let n; (n = walker.nextNode());) {
      if (!text(n.data)) continue;
      const r = n.parentElement.getBoundingClientRect();
      if (r.height && r.height <= box.clientHeight && r.top <= bottom+2) bottom = Math.max(bottom,r.bottom);
    }
    return Math.min(box.clientHeight*6, Math.floor(bottom-viewport.top-box.clientHeight*0.15));
  }
  async function scanBuffer() {
    if (box.scrollTop !== 0) await move(0);
    do {
      const hit = match();
      if (hit) return hit;
      const step = bufferedStep();
      if (step <= box.clientHeight || box.scrollTop+box.clientHeight >= box.scrollHeight-1) return;
      await move(box.scrollTop+step);
    } while (Date.now() < end-4000 && moves < 192);
    return match();
  }
  try {
    check();
    let found = match();
    if (found) return await reveal(found);
    found = await seek();
    if (found) return await reveal(found);
    found = await scanBuffer();
    if (found) return await reveal(found);
    for (let offset=0; ; offset+=Math.max(1,Math.floor(box.clientHeight*0.85))) {
      await move(offset);
      found=match();
      if (found) return await reveal(found);
      if (box.scrollTop+box.clientHeight >= box.scrollHeight-1) throw new Error('Item not found in this container.');
    }
  } catch (err) {
    if (!interrupted && box.isConnected && nodes()[0]===box && location.href===url && Math.abs(box.scrollTop-last)<=1) box.scrollTo({top:origin,behavior:'instant'});
    throw err;
  } finally { for (const event of events) document.removeEventListener(event,stop,true); }
}

module.exports = { prepareChoice, finishChoice, revealText };
