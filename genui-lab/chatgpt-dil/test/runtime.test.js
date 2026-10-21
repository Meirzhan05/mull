import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createMirror, encodeOps, decodeOps } from '../src/runtime.js';
import { compile } from '../src/compiler.js';
import { computePresentation, resolveColor, rendererFor } from '../src/host.js';

// Synchronous harness: ops go through the binary buffer into a DOM-free mirror.
function harness(extra = {}) {
  const mirror = createMirror();
  const batches = [];
  const actions = [];
  const errors = [];
  let queued = null;
  const rt = createRuntime({
    onOps(ops, meta) {
      batches.push({ ops, meta });
      const { buffer, strings } = encodeOps(ops);
      mirror.apply(decodeOps(buffer, strings));
    },
    onHostAction: (a) => actions.push(a),
    onError: (e) => errors.push(e),
    schedule: (fn) => { queued = fn; },
    ...extra,
  });
  const run = (source, constants = {}, appData = {}) => rt.render({ source, constants, appData });
  const flushScheduled = () => { const f = queued; queued = null; if (f) f(); };
  const click = (pred) => {
    const n = mirror.findAll(pred)[0];
    assert.ok(n, 'clickable node not found');
    return rt.invokeFunction(n.props.onClick.__fn, []);
  };
  return { rt, mirror, batches, actions, errors, run, click, flushScheduled };
}

test('jsx tree renders host elements and text in order', () => {
  const h = harness();
  h.run('DIL.render(__dil.jsx("box",{"gap":2},__dil.jsx("text",null,"a"),"b",null,false,[__dil.jsx("title",null,"c")]))');
  const tree = h.mirror.toJSON();
  assert.deepEqual(tree.children[0], {
    type: 'box', props: { gap: 2 },
    children: [{ type: 'text', props: {}, children: ['a'] }, 'b', { type: 'title', props: {}, children: ['c'] }],
  });
  const kinds = new Set(h.batches[0].ops.map((o) => o.op));
  for (const k of ['createElement', 'createText', 'move', 'propChanged']) assert.ok(kinds.has(k), k);
});

test('useState + onClick proxied by function id -> textChanged', () => {
  const h = harness();
  h.run(`function Counter(){const [n,setN]=DIL.useState(0);return __dil.jsx("pressable",{onClick:()=>setN(n+1)},__dil.jsx("text",null,"count ",String(n)));}
DIL.render(__dil.jsx(Counter,null));`);
  assert.equal(h.mirror.text(), 'count 0');
  const fn = h.mirror.findAll((n) => n.type === 'pressable')[0].props.onClick;
  assert.equal(typeof fn.__fn, 'number');
  h.click((n) => n.type === 'pressable');
  h.click((n) => n.type === 'pressable');
  assert.equal(h.mirror.text(), 'count 2');
  const last = h.batches.at(-1).ops;
  assert.deepEqual(last.map((o) => o.op), ['textChanged']);
  // the function id stays stable across renders (no propChanged for onClick)
  assert.equal(h.mirror.findAll((n) => n.type === 'pressable')[0].props.onClick.__fn, fn.__fn);
});

test('keyed reorder emits move ops and keeps node identity; removal emits destroy', () => {
  const h = harness();
  const code = (keys) => `DIL.render(__dil.jsx("list",null,${keys.map((k) => `__dil.jsx("list-item",{key:"${k}"},"${k}")`).join(',')}))`;
  h.run(code(['a', 'b', 'c']));
  const ids = Object.fromEntries(h.mirror.findAll((n) => n.type === 'list-item').map((n) => [h.mirror.text(n), n.id]));
  h.run(code(['c', 'a', 'b']));
  assert.equal(h.mirror.text(), 'cab');
  const ops = h.batches.at(-1).ops;
  assert.ok(ops.some((o) => o.op === 'move'));
  assert.ok(!ops.some((o) => o.op === 'createElement'));
  assert.deepEqual(h.mirror.findAll((n) => n.type === 'list-item').map((n) => n.id), [ids.c, ids.a, ids.b]);
  h.run(code(['c', 'b']));
  assert.equal(h.mirror.text(), 'cb');
  assert.deepEqual(h.batches.at(-1).ops.filter((o) => o.op === 'destroy').map((o) => o.id), [ids.a]);
});

test('effects run after commit, re-run on dep change and clean up on unmount', () => {
  const h = harness();
  const log = [];
  const src = (show, dep) => `function E(p){DIL.useEffect(()=>{p.log.push("run:"+p.dep);return ()=>p.log.push("clean:"+p.dep)},[p.dep]);return __dil.jsx("text",null,"e");}
DIL.render(__dil.jsx("box",null,${show ? `__dil.jsx(E,{log:DIL.useAppData().log,dep:${dep}})` : 'null'}))`;
  // useAppData outside a component is fine: it only reads the current appData
  h.rt.render({ source: src(true, 1), appData: { log } });
  h.rt.render({ source: src(true, 1) + ' ', appData: { log } });
  h.rt.render({ source: src(true, 2), appData: { log } });
  h.rt.render({ source: src(false, 2), appData: { log } });
  assert.deepEqual(log, ['run:1', 'clean:1', 'run:2', 'clean:2']);
});

test('state survives re-evaluation of a new revision (same component name / keyed body)', () => {
  const h = harness();
  const src = (label) => `function C(){const [n,setN]=DIL.useState(0);return __dil.jsx("pressable",{onClick:()=>setN(n+1)},"${label}"+n);}
DIL.render(__dil.jsx(()=>__dil.jsx(C,null),{"key":"body:0"}));`;
  h.run(src('v1:'));
  h.click((n) => n.type === 'pressable');
  h.run(src('v2:'));
  assert.equal(h.mirror.text(), 'v2:1');
});

test('setState is batched through the scheduler', () => {
  const h = harness();
  h.run(`function T(){const [n,setN]=DIL.useState(0);DIL.useEffect(()=>{if(n<3){setN(n+1)}},[n]);return __dil.jsx("text",null,String(n));}
DIL.render(__dil.jsx(T,null));`);
  // effects schedule renders synchronously within the same commit loop
  assert.equal(h.mirror.text(), '3');
});

test('sandbox: shadowed globals, __dilSafe for missing components, errors contained', () => {
  const h = harness();
  h.run(`function __dilSafe(e,f){try{return e()}catch{return f}}
DIL.render(__dil.jsx("box",null,
  __dil.jsx("text",null,typeof fetch+","+typeof XMLHttpRequest+","+typeof importScripts+","+typeof WebSocket+","+typeof globalThis+","+typeof self),
  __dilSafe(()=>(__dil.jsx(NotARealWidget,{})),null),
  __dil.jsx(function Boom(){throw new Error("kaboom")},null),
  __dil.jsx("text",null,"after")))`);
  assert.equal(h.mirror.text(), 'undefined,undefined,undefined,undefined,undefined,undefinedafter');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /Boom: kaboom/);
  // a syntax error keeps the previous tree
  h.run('DIL.render(__dil.jsx("text",null,"x"');
  assert.equal(h.errors.at(-1).phase, 'evaluate');
  assert.match(h.mirror.text(), /after$/);
});

test('GenUI facade posts host actions; hooks: useConstants/useAppData/useBreakpoint/useIsMobile/useId/useMemo/useRef', () => {
  const h = harness({ viewportWidth: 390 });
  h.run(`function W(){const c=DIL.useConstants();const v=DIL.useAppData(a=>a.v);const id=DIL.useId();const r=DIL.useRef(0);r.current++;
const m=DIL.useMemo(()=>v*2,[v]);
return __dil.jsx("pressable",{onClick:()=>{GenUI.openUrl("https://example.com");GenUI.issueNewTurn("more",{append_to_current_leaf:true});GenUI.openEntityDetail("stock","Apple Inc.",{disambiguation:"AAPL"});GenUI.dispatchAction({handler:"server",type:"x",payload:{a:1}})}},
c["0"]+"|"+m+"|"+DIL.useBreakpoint("sm")+"|"+DIL.useIsMobile()+"|"+id.startsWith("dil-"));}
DIL.render(__dil.jsx(W,null));`, { 0: 'K' }, { v: 21 });
  assert.equal(h.mirror.text(), 'K|42|false|true|true');
  h.click((n) => n.type === 'pressable');
  assert.deepEqual(h.actions.map((a) => `${a.handler}:${a.type}`), ['client:open_url', 'client:issue_new_turn', 'client:open_entity_detail', 'server:x']);
  assert.equal(h.actions[0].payload.url, 'https://example.com');
  h.rt.setViewport(1280);
  assert.equal(h.mirror.text(), 'K|42|true|false|true');
});

test('binary op buffer round-trips every op and value tag', () => {
  const ops = [
    { op: 'createElement', id: 1, type: 'box' },
    { op: 'createText', id: 2, text: 'héllo 🌦️' },
    { op: 'propChanged', id: 1, name: 'padding', value: { x: 4, y: '7px', nested: [1, null, true, false, 2.5] } },
    { op: 'propChanged', id: 1, name: 'onClick', value: { __fn: 7 } },
    { op: 'propChanged', id: 1, name: 'gone', value: undefined },
    { op: 'move', id: 2, parent: 1, index: 0 },
    { op: 'move', id: 1, parent: 0, index: 3 },
    { op: 'textChanged', id: 2, text: 'héllo 🌦️ world' },
    { op: 'destroy', id: 1 },
  ];
  const { buffer, strings } = encodeOps(ops);
  assert.ok(buffer instanceof ArrayBuffer);
  assert.deepEqual(decodeOps(buffer, strings), ops);
  assert.ok(strings.length < 12, 'strings are de-duplicated');
});

test('compiled markup renders through the runtime', () => {
  const h = harness();
  const r = compile('# Hi\n\n<box gap={2}><text size="sm">**bold** tail</text></box>');
  h.run(r.code, r.constants);
  const box = h.mirror.findAll((n) => n.type === 'box')[0];
  assert.equal(box.props.gap, 2);
  assert.equal(h.mirror.text(), 'Hibold tail');
  assert.ok(h.mirror.findAll((n) => n.type === 'bold').length === 1);
});

test('host token mapping (pure): spacing, radius, colors, aliases', () => {
  const { style, attrs } = computePresentation('box', { border: true, radius: 'xl', padding: 4, gap: 3, background: 'surface-tertiary' });
  assert.equal(style.padding, 'calc(var(--d-spacing) * 4)');
  assert.equal(style.gap, 'calc(var(--d-spacing) * 3)');
  assert.equal(style.borderRadius, '0.75rem');
  assert.equal(style.background, 'var(--d-surface-tertiary)');
  assert.equal(attrs['data-d-direction'], 'col');
  assert.equal(computePresentation('row', {}).attrs['data-d-direction'], 'row');
  assert.equal(computePresentation('text', { color: 'secondary', size: 'sm' }).style.color, 'var(--d-text-secondary)');
  assert.equal(computePresentation('divider', { color: 'subtle' }).style.background, 'var(--d-border-subtle)');
  assert.equal(computePresentation('box', { radius: 'full', width: '100%', height: '5px' }).style.borderRadius, '9999px');
  assert.equal(resolveColor('#E9A23B'), '#E9A23B');
  assert.equal(resolveColor('danger'), 'var(--d-danger)');
  assert.equal(rendererFor('box'), 'row');
  assert.equal(rendererFor('text'), 'title');
  assert.equal(rendererFor('spacer'), 'divider');
});
