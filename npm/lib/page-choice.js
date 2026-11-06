'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { source } = require('./current-page');

const norm = s => (s ?? '').trim().replace(/\s+/g,' ');
const label = s => norm(s).replace(/\s*[*＊]\s*$/, '');
const nodes = root => [root, ...(root.children ?? []).filter(n=>n.role!=='document').flatMap(nodes)];
const acts = (n,a) => n.available_actions?.includes(a);
const click = n => n.ref_id && acts(n,'Click');
const checks = new Set(['radiobutton','checkbox','switch']);
const containers = new Set(['listbox','list','radiogroup','group','section','region','form','window','dialog','grid','table']);
const selected = n => n.states?.some(s=>['checked','selected','pressed'].includes(s));
const searchable = n => ['textfield','combobox'].includes(n.role) && acts(n,'SetValue');
function single(items, kind) {
  if(items.length!==1) throw new Error('Expected one '+kind+', found '+items.length+'.');
  return items[0];
}
function parents(root) {
  const p = new Map();
  for(const n of nodes(root)) for(const c of n.children ?? []) p.set(c,n);
  return p;
}
function top(items) {
  const all=new Set(items);
  const nested=new Set(items.flatMap(n=>nodes(n).slice(1)).filter(n=>all.has(n)));
  return items.filter(n=>!nested.has(n));
}
function scope(doc, within) {
  if(!within) return doc;
  return single(nodes(doc).filter(n=>containers.has(n.role) && label(n.name)===label(within)), 'section named '+within);
}
function field(root,name,opener) {
  const all=nodes(root), key=label(name);
  const controls=n=>checks.has(n.role)||['combobox','listbox','radiogroup','menubutton'].includes(n.role)||(opener && n.role==='textfield')||
    ((n.role==='button'||n.role==='group')&&click(n));
  const direct=all.filter(n=>label(n.name)===key && (controls(n)||containers.has(n.role)));
  if(direct.length===2) {
    const combo=direct.find(n=>n.role==='combobox'), list=direct.find(n=>n.role==='listbox'), p=parents(root);
    if(combo && list && p.get(combo)===p.get(list) && combo.states?.includes('expanded')) return combo;
  }
  if(direct.length) return single(direct,'field named '+name+' (use --within for repeated labels)');
  const text=single(all.filter(n=>['statictext','heading','label'].includes(n.role)&&label(n.name)===key), 'field label '+name);
  const p=parents(root);
  for(let branch=text,box=p.get(text);box;branch=box,box=p.get(box)) {
    const next=box.children?.[box.children.indexOf(branch)+1];
    if(next && !nodes(branch).some(n=>n!==text && (controls(n)||(n.role==='statictext'&&label(n.name))))) {
      const adjacent=top(nodes(next).filter(controls));
      if(adjacent.length===1 && !nodes(next).some(n=>n.role==='statictext' && label(n.name) && !nodes(adjacent[0]).includes(n))) return adjacent[0];
    }
    if(box===root) break;
    const choices=top(nodes(box).filter(n=>controls(n)));
    if(choices.length===1) return choices[0];
    if(choices.length>1) {
      if(choices.every(n=>checks.has(n.role))) return box;
      throw new Error('More than one control shares the field label '+name+'.');
    }
  }
  throw new Error('No choice control is associated with '+name+'.');
}

function trigger(root,control,name) {
  const p=parents(root);
  for(let box=p.get(control);box;box=p.get(box)) {
    const buttons=nodes(box).filter(n=>['button','menubutton'].includes(n.role)&&norm(n.name)===norm(name)&&click(n));
    if(buttons.length) {
      if(nodes(box).some(n=>n!==control && ['textfield','combobox','listbox'].includes(n.role))) break;
      return single(buttons,'opener associated with this field');
    }
    if(box===root) break;
  }
  throw new Error('No button named '+name+' is associated with this field.');
}
function option(box,value,loose=true) {
  const key=norm(value);
  const items=nodes(box).filter(n=>n!==box && n.ref_id &&
(checks.has(n.role)||['option','listitem','menuitem','cell'].includes(n.role)||(loose && ['button','group'].includes(n.role)&&click(n))) &&
    (norm(n.name)===key || (!n.name && nodes(n).some(c=>c.role==='statictext'&&norm(c.name)===key))));
  const inner=items.filter(n=>!nodes(n).slice(1).some(c=>items.includes(c)));
  if(inner.length>1) throw new Error('More than one option named '+value+' in this field.');
  return inner[0];
}
function read(field,value,expected=value) {
  const key=norm(expected);
  if(checks.has(field.role)) return norm(field.name)===norm(value) && selected(field);
  if(field.role==='combobox' || field.role==='textfield') return norm(field.value)===key &&
    (!field.states?.includes('expanded') || Boolean(selected(option(field,value) ?? {})));
  const item=option(field,value);
  if(item && selected(item) && key===norm(value)) return true;
  if(norm(field.value)===key) return true;
  if(item || ['list','listbox','radiogroup'].includes(field.role)) return false;
  if(!click(field) || field.states?.includes('expanded')) return false;
  const leaves=nodes(field).slice(1).filter(n=>n.role==='statictext').map(n=>norm(n.name));
  return leaves.some(v=>v===key || v.split(/[,，;；]/).map(norm).includes(key));
}
const popupRole=n=>['dialog','window','listbox','list','menu','grid','table'].includes(n.role);
const identity=n=>n.role+'\x00'+norm(n.name);
function panels(doc) {
  return {doc, popups:new Set(nodes(doc).filter(popupRole).map(identity))};
}
function popup(doc, before, getCurrent, {field,confirm,search,popup:popupName,value}, requirePopup=false) {
  const all=nodes(doc);
  const namedConfirm=n=>n.role==='button'&&norm(n.name)===norm(confirm)&&click(n);
  const candidates=all.filter(n=>(popupRole(n) || (popupName && n.role==='group')) && (!popupName || norm(n.name)===norm(popupName)) &&
    (!before.popups.has(identity(n)) || (popupName ? norm(n.name)===norm(popupName) :
      (['window','dialog'].includes(n.role) && (norm(n.name)===norm(field)||norm(n.name).startsWith(norm(field)+' '))))) &&
    (!confirm || nodes(n).some(namedConfirm)));
  if(candidates.length) return single(top(candidates),'new choice popup');
  let current;
  try {current=getCurrent();} catch(err) {if(!confirm) throw err;}
  if(current?.role==='combobox' && current.states?.includes('expanded')) {
    const parent=parents(doc).get(current);
    const siblings=(parent?.children ?? []).filter(n=>n.role==='listbox'&&n.name===current.name);
    if(!popupName && siblings.length) return single(siblings,'listbox for '+current.name);
  }
  if(confirm && !popupName && !nodes(before.doc).some(namedConfirm)) {
    const shown=all.filter(namedConfirm);
    if(!shown.length && !requirePopup && current) return current;
    const b=single(shown,'new popup button '+confirm), p=parents(doc);
    for(let box=p.get(b);box&&box!==doc;box=p.get(box)) {
      if(nodes(box).includes(current)) break;
      if(option(box,value) || (search && nodes(box).some(n=>searchable(n)&&norm(n.name)===norm(search)))) return box;
    }
  }
  if(!current || requirePopup) throw new Error('Cannot identify the owning choice popup.');
  return current;
}

async function choosePage(ad,args) {
  const {page,field:name,value,within,confirm,search,open,'expect-value':expected=value}=args;
  if(!page||!label(name)||!norm(value)||['session','tab','input','position','format'].some(k=>args[k]!==undefined)) throw new Error('Use --page, --field and --value with an optional --within, --search or --confirm.');
  if(args.advance && !args.popup) throw new Error('--advance requires the exact --popup panel to reach.');
  const load=async()=>{
    const {state,saved}=await source(ad,page);
    if(state.url!==saved.url) throw new Error('The page navigated; inspect current before acting.');
    return state;
  };
  let state=await load();
  const get=s=>field(scope(s.doc,within),name,open);
  const done=changed=>({page,url:state.url,field:name,value,changed,verified:true});
  let control=get(state);
  if(read(control,value,expected)) return done(false);
  const before=panels(state.doc);
  let delivered=false;
  const act=(node,operation='click',argument)=>{
    if(!node?.ref_id || node.states?.some(s=>['disabled','readonly'].includes(s))) throw new Error('The choice is not enabled or writable.');
    try {
      const result=ad('page-option',node.ref_id,'--selected-tab',state.tab,'--document',state.doc.ref_id,'--operation',operation,
        ...(argument===undefined ? [] : ['--value',argument]));
      if(result.steps?.every(s=>s.outcome==='skipped' && s.verified)) return false;
      delivered=true;
      return true;
    } catch(err) {
      if(err.details?.kind!=='post_action_verification' || err.disposition?.delivery!=='delivered_unverified') throw err;
      delivered=true;
    }
  };
  async function observe(probe,msg) {
    const until=Date.now()+6500;
    do {
      state=await load();
      const result=probe(state);
      if(result) return result;
      await delay(90);
    } while(Date.now()<until);
    throw new Error(msg);
  }
  const box=(s,required=false)=>popup(s.doc,before,()=>get(s),args,required);
  const row=s=>{
    const area=box(s);
    if(args.popup && norm(area.name)!==norm(args.popup)) return undefined;
    let inline;
    try {inline=area===get(s);} catch {inline=false;}
    return option(area,value,popupRole(area) || !inline);
  };
  const verify=()=>observe(s=>read(get(s),value,expected),'The original field did not confirm '+expected+'.');
  function navigator(s) {
    const panels=nodes(s.doc).filter(n=>['window','dialog'].includes(n.role) &&
      (!before.popups.has(identity(n)) || n.name===open || n.name===name) &&
      nodes(n).some(c=>c.role==='button' && norm(c.name)===norm(args.advance)));
    if(!panels.length) return;
    const panel=single(panels,'open picker containing '+args.advance);
    const names=nodes(panel).filter(n=>['listbox','grid','table'].includes(n.role)&&n.name).map(n=>identity(n));
    if(!names.length) throw new Error('The picker exposes no named pages to navigate.');
    return {button:single(nodes(panel).filter(c=>c.role==='button'&&click(c)&&norm(c.name)===norm(args.advance)),'picker navigation button'),key:JSON.stringify(names)};
  }
  async function advance() {
    let step=await observe(s=>(box(s).name===args.popup ? true : navigator(s)), 'Could not identify the named picker.');
    const seen=new Set();
    while(step!==true) {
      if(seen.has(step.key)||seen.size>=24) throw new Error('The requested panel was not reached.');
      seen.add(step.key); act(step.button);
      step=await observe(s=>{
        if(box(s).name===args.popup) return true;
        const next=navigator(s);
        return next && !seen.has(next.key) && next;
      }, 'The picker did not reach a different named panel.');
    }
  }
  const scrollable=s=>{const area=box(s);return acts(area,'Scroll') && ['listbox','list','grid'].includes(area.role) && area.ref_id ? area : undefined;};
  async function scan(list) {
    const visible=list=>JSON.stringify(nodes(list).filter(n=>!n.states?.includes('offscreen')).map(n=>[n.role,n.name,n.value]));
    let returnTime=0, returnSteps=0;
    for(const direction of ['up','down']) {
      const started=Date.now(), seen=new Set(), until=started+12000+returnTime;
      for(let i=0;list && i<20+returnSteps && Date.now()<until;i++) {
        const key=visible(list);
        if(seen.has(key)) break;
        seen.add(key);
        if(act(list,'scroll-'+direction)===false) break;
        const settle=Date.now()+4500;
        do {
          state=await load();
          const hit=row(state);
          if(hit) return hit;
          list=scrollable(state);
          if(!list || visible(list)!==key) break;
          if(Date.now()>=settle) throw new Error('No new rows appeared after scrolling. Check that the list is visible and no other picker is open.');
          await delay(70);
        } while(true);
      }
      returnTime=Date.now()-started;
      returnSteps=seen.size;
    }
    throw new Error('The exposed list did not reveal an exact option named '+value+'.');
  }
  try {
    let item=checks.has(control.role)&&norm(control.name)===norm(value)?control:row(state);
    if(!item && !search && scrollable(state)) item=await scan(scrollable(state));
    if(!item) {
      if(['list','listbox','radiogroup'].includes(control.role)) throw new Error('No exposed option named '+value+' in the field.');
      if(box(state)===control && !control.states?.includes('expanded') && !(args.advance && navigator(state))) {
        if(open) act(trigger(scope(state.doc,within),control,open));
        else if(acts(control,'Expand')) act(control,'expand');
        else if(click(control)) act(control);
        else throw new Error('This field exposes no way to open a choice list.');
      }
      if(args.advance) await advance();
      item=await observe(s=>row(s)||(search ? nodes(box(s)).find(n=>searchable(n)&&norm(n.name)===norm(search)) : scrollable(s)), 'The opened field did not expose the requested option or search control.');
      if(item===scrollable(state)) item=await scan(item);
      if(search && searchable(item)) {
        const input=single(nodes(box(state)).filter(n=>searchable(n)&&norm(n.name)===norm(search)),'popup search field');
        act(input,'search',value);
        item=await observe(row,'The popup search did not expose the option '+value+'.');
      }
    }
    if(!selected(item)) {
      if(['checkbox','switch'].includes(item.role) && acts(item,'Toggle')) act(item,'check');
      else if(item.role!=='radiobutton' && click(item)) act(item);
      else if(['radiobutton','option','listitem'].includes(item.role) && acts(item,'Select') && norm(item.name)===norm(value)) act(item,'select',item.name);
      else if(click(item)) act(item);
      else throw new Error('This option has no semantic action.');
    }
    if(confirm) {
      state=await load();
      const area=box(state,true);
      const button=single(nodes(area).filter(n=>n.role==='button'&&click(n)&&norm(n.name)===norm(confirm)), 'popup button '+confirm);
      act(button);
    }
    await verify();
    const after=get(state);
    if(after.role==='combobox' && after.states?.includes('expanded') && acts(after,'Collapse') && !control.states?.includes('expanded')) {
      act(after,'collapse');
      await observe(s=>!get(s).states?.includes('expanded') && read(get(s),value,expected), 'The collapsed field did not confirm '+expected+'.');
    }
    return done(delivered);
  } catch(err) {
    if(delivered && !err.disposition?.delivery?.startsWith('delivered')) throw Object.assign(new Error(err.message+' Inspect the field before repeating.'),{code:'ACTION_FAILED',disposition:{delivery:'delivered_unverified',retry:'unsafe'}});
    throw err;
  }
}

module.exports={choosePage};
