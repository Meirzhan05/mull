// DOM-free DIL sandbox runtime. Shared by src/worker.js (browser Web Worker) and the
// node:test suite.
//
// Mirrors the worker side of ChatGPT's DIL renderer (findings §3.1/§3.2):
//   - programs are evaluated with Function("DIL","__dil","GenUI","Date", '"use strict";\n'+code)
//   - __dil.jsx(type, props, ...children) / __dil.Fragment build elements
//   - DIL.render / useState / useEffect / useMemo / useRef / useCallback / useConstants /
//     useAppData / useBreakpoint / useIsMobile / useId (+ small stubs for the rest)
//   - a hooks reconciler turns the element tree into render operations:
//       1 createElement(nodeId,type) 2 createText(nodeId,text) 3 destroy(nodeId)
//       4 move(nodeId,parentId,index) 5 propChanged(nodeId,name,value) 6 textChanged(nodeId,text)
//   - function props (onClick, ...) cross the boundary as {__fn:id} and come back via
//     invokeFunction(fnId, args)
//   - GenUI facade turns widget actions into host-action messages.

import { createCatalog, CATALOG_NAMES } from './catalog.js';

export const Fragment = Symbol.for('dil.fragment');
const TEXT = '#text';
const ROOT_ID = 0;

export const OP = { createElement: 1, createText: 2, destroy: 3, move: 4, propChanged: 5, textChanged: 6 };

export const BREAKPOINTS = { xs: 0, sm: 640, md: 768, lg: 1024, xl: 1280 };

// Globals shadowed (as undefined) inside the program's Function scope. Best-effort lockdown:
// the real worker deletes every non-allow-listed global (DILSandboxGlobals, findings §3.2).
export const SHADOWED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'importScripts', 'WebSocket', 'EventSource', 'indexedDB', 'caches',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'postMessage', 'close', 'navigator',
  'location', 'self', 'globalThis', 'window', 'document', 'require', 'process', 'module', 'Function',
  'WebAssembly', 'Request', 'Response', 'Headers', 'FileReader', 'Blob', 'URL', 'crypto', 'performance',
  'onmessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'queueMicrotask',
  'setImmediate', 'structuredClone', 'Atomics', 'SharedArrayBuffer',
];

// ---------------------------------------------------------------------------
// Elements

export function jsx(type, props, ...children) {
  const p = {};
  let key = null;
  if (props) {
    for (const k in props) {
      if (k === 'key') { if (props.key != null) key = String(props.key); }
      else p[k] = props[k];
    }
  }
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { $$dil: true, type, props: p, key };
}

function normalizeChildren(children, out = []) {
  if (children == null || typeof children === 'boolean' || children === '') return out;
  if (Array.isArray(children)) { for (const c of children) normalizeChildren(c, out); return out; }
  if (typeof children === 'string' || typeof children === 'number' || typeof children === 'bigint') {
    out.push({ $$dil: true, type: TEXT, props: { text: String(children) }, key: null });
    return out;
  }
  if (children.$$dil) { out.push(children); return out; }
  // unsupported object child: stringify defensively instead of throwing
  out.push({ $$dil: true, type: TEXT, props: { text: String(children) }, key: null });
  return out;
}

// ---------------------------------------------------------------------------
// Runtime

/**
 * @param {object} o
 * @param {(ops:any[], meta:object)=>void} o.onOps          receives each committed op batch
 * @param {(action:object)=>void} [o.onHostAction]          GenUI actions
 * @param {(err:{message:string, phase:string})=>void} [o.onError]
 * @param {(fn:()=>void)=>void} [o.schedule]               re-render scheduler (default microtask)
 * @param {number} [o.viewportWidth]
 * @param {number} [o.fixedTimeMs]                          frozen clock for Date (createDILDateConstructor)
 */
export function createRuntime(o) {
  const onOps = o.onOps;
  const onHostAction = o.onHostAction || (() => {});
  const onError = o.onError || (() => {});
  const schedule = o.schedule || ((fn) => queueMicrotask(fn));
  let viewportWidth = o.viewportWidth ?? 1024;

  let nextNodeId = 1;
  let nextFnId = 1;
  let nextFiberUid = 1;
  const fnTable = new Map(); // fnId -> function
  let ops = [];
  let pendingEffects = [];
  let currentFiber = null;
  let hookIndex = 0;
  let renderScheduled = false;
  let rendering = false;
  let rootElement = null;
  let constants = {};
  let appData = {};
  let source = null;
  let generation = 0;
  let destroyed = false;
  const timers = new Set();
  const rootFiber = { kind: 'host', type: '#root', hostId: ROOT_ID, children: [], hostKids: [], props: {}, uid: 0 };

  const emit = (op) => ops.push(op);

  // -- hooks -----------------------------------------------------------------
  function hook(init) {
    const f = currentFiber;
    if (!f) throw new Error('DIL hooks can only be called while rendering a component');
    const i = hookIndex++;
    if (f.hooks.length <= i) f.hooks.push(init());
    return f.hooks[i];
  }
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

  const DIL = Object.freeze({
    render(element) { rootElementCandidate = element; },
    useState(initial, _opts) {
      const h = hook(() => ({ value: typeof initial === 'function' ? initial() : initial, setter: null }));
      if (!h.setter) {
        h.setter = (v) => {
          const nv = typeof v === 'function' ? v(h.value) : v;
          if (!Object.is(nv, h.value)) { h.value = nv; scheduleRender(); }
        };
      }
      return [h.value, h.setter];
    },
    useReducer(reducer, initial) {
      const [s, set] = DIL.useState(initial);
      return [s, (a) => set((prev) => reducer(prev, a))];
    },
    useEffect(fn, deps) {
      const f = currentFiber;
      const h = hook(() => ({ deps: undefined, cleanup: null, fn: null, first: true }));
      if (h.first || depsChanged(h.deps, deps)) {
        h.first = false;
        h.deps = deps;
        h.fn = fn;
        pendingEffects.push({ fiber: f, h });
      }
    },
    useLayoutEffect(fn, deps) { return DIL.useEffect(fn, deps); },
    useMemo(fn, deps) {
      const h = hook(() => ({ deps: undefined, value: undefined, init: false }));
      if (!h.init || depsChanged(h.deps, deps)) { h.value = fn(); h.deps = deps; h.init = true; }
      return h.value;
    },
    useCallback(fn, deps) { return DIL.useMemo(() => fn, deps); },
    useRef(initial) { return hook(() => ({ current: initial })); },
    useId() { const f = currentFiber; const i = hookIndex; hook(() => 0); return `dil-${f.uid}-${i}`; },
    useConstants() { return constants; },
    useAppData(selector) { return typeof selector === 'function' ? selector(appData) : appData; },
    useBreakpoint(name) { return viewportWidth >= (BREAKPOINTS[name] ?? Number(name) ?? 0); },
    useIsMobile() { return viewportWidth < BREAKPOINTS.sm; },
    useNow() { return o.fixedTimeMs ?? Date.now(); },
    useTheme() { return 'light'; },
    // Device / messaging hooks exist in the real facade; inert stubs here.
    useDILMessenger() { return { postMessage() {}, subscribe() { return () => {}; } }; },
    useHtmlViewMessenger() { return null; },
    useDictation() { return { supported: false, start() {}, stop() {} }; },
    useSpeechSynthesizer() { return { supported: false, speak() {}, cancel() {} }; },
  });
  let rootElementCandidate;

  const dil = Object.freeze({ jsx, jsxs: jsx, Fragment });

  // -- GenUI facade (createDILGenUIFacade, findings §3.1) ----------------------
  const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function dispatchAction(action) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new TypeError('GenUI.dispatchAction expects {handler, type, payload}');
    const a = { handler: action.handler === 'server' ? 'server' : 'client', type: action.type, payload: plain(action.payload ?? {}) };
    if (action.context) a.context = plain(action.context);
    for (const k of ['nativeWidgetResolutionId', 'componentName', 'loadingBehavior']) if (action[k] != null) a[k] = action[k];
    onHostAction(a);
  }
  const GenUI = Object.freeze({
    dispatchAction,
    dispatchWidgetAction(a) { dispatchAction({ ...a, handler: 'server' }); },
    logEvent(name, data) { dispatchAction({ handler: 'client', type: 'log_event', payload: { event_name: name, event_data: data ?? {} } }); },
    issueNewTurn(query, opts = {}) { dispatchAction({ handler: 'client', type: 'issue_new_turn', payload: { query, ...opts } }); },
    openEntityDetail(category, query, extra = {}) { dispatchAction({ handler: 'client', type: 'open_entity_detail', payload: { category, query, extraParams: extra } }); },
    openImageLightbox(images, index = 0) { dispatchAction({ handler: 'client', type: 'open_image_lightbox', payload: { images, index } }); },
    openUrl(url) { dispatchAction({ handler: 'client', type: 'open_url', payload: { url: String(url) } }); },
    refreshWidget(resolutionId) { dispatchAction({ handler: 'client', type: 'refresh_widget', payload: { resolutionId } }); },
  });

  // Frozen-clock Date (createDILDateConstructor) when fixedTimeMs is given.
  const DateCtor = o.fixedTimeMs == null ? Date : (() => {
    const fixed = o.fixedTimeMs;
    function FixedDate(...args) {
      if (!new.target) return new Date(fixed).toString();
      return args.length ? new Date(...args) : new Date(fixed);
    }
    FixedDate.now = () => fixed;
    FixedDate.parse = Date.parse;
    FixedDate.UTC = Date.UTC;
    FixedDate.prototype = Date.prototype;
    return FixedDate;
  })();

  const timerApi = {
    setTimeout(fn, ms, ...a) { const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(...a); }, ms); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    setInterval(fn, ms, ...a) { const id = setInterval(() => { if (!destroyed) fn(...a); }, Math.max(16, ms | 0)); timers.add(id); return id; },
    clearInterval(id) { timers.delete(id); clearInterval(id); },
  };

  const catalog = createCatalog({ __dil: dil, DIL, GenUI });
  const catalogNames = CATALOG_NAMES.filter((n) => catalog[n]);
  // host functions a program may call but never render: as a component type (a tag named
  // GenUI.dispatchAction) one would run with model-written props on render, without a click
  const notComponents = new Set([...Object.values(GenUI), ...Object.values(DIL), ...Object.values(dil), ...Object.values(timerApi), DateCtor].filter((f) => typeof f === 'function'));

  function evaluate(code) {
    rootElementCandidate = undefined;
    const fn = Function('DIL', '__dil', 'GenUI', 'Date', ...catalogNames, 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', ...SHADOWED_GLOBALS, '"use strict";\n' + code);
    fn(DIL, dil, GenUI, DateCtor, ...catalogNames.map((n) => catalog[n]), timerApi.setTimeout, timerApi.clearTimeout, timerApi.setInterval, timerApi.clearInterval, ...SHADOWED_GLOBALS.map(() => undefined));
    return rootElementCandidate;
  }

  // -- reconciliation ----------------------------------------------------------
  const kindOf = (v) => (v.type === TEXT ? 'text' : v.type === Fragment ? 'fragment' : typeof v.type === 'function' ? 'component' : 'host');

  function compatible(f, v) {
    const k = kindOf(v);
    if (f.kind !== k) return false;
    if (k === 'host') return f.type === v.type;
    if (k === 'component') {
      if (f.type === v.type) return true;
      // Re-evaluated programs create fresh function identities on every revision; keep the
      // fiber (and its state) when the component has the same name, or is the keyed
      // anonymous body (key "body:0") — the role DILSemanticKey plays in the real runtime.
      return f.type.name === v.type.name && (f.type.name !== '' || v.key != null);
    }
    return true;
  }

  function hostParentOf(parent) { return parent.kind === 'host' ? parent : parent.hostParent; }

  function mount(v, parent) {
    const f = { kind: kindOf(v), type: v.type, key: v.key, props: v.props, parent, hostParent: hostParentOf(parent), children: [], hooks: [], uid: nextFiberUid++ };
    if (f.kind === 'text') {
      f.hostId = nextNodeId++;
      f.text = v.props.text;
      emit({ op: 'createText', id: f.hostId, text: f.text });
    } else if (f.kind === 'host') {
      f.hostId = nextNodeId++;
      f.hostKids = [];
      f.sentProps = {};
      f.fnSlots = {};
      emit({ op: 'createElement', id: f.hostId, type: String(f.type) });
      diffProps(f, v.props);
      reconcileChildren(f, normalizeChildren(v.props.children));
      syncHostChildren(f);
    } else if (f.kind === 'fragment') {
      reconcileChildren(f, normalizeChildren(v.props.children));
    } else {
      renderComponent(f);
    }
    return f;
  }

  function update(f, v) {
    f.props = v.props;
    f.key = v.key;
    if (f.kind === 'text') {
      if (f.text !== v.props.text) { f.text = v.props.text; emit({ op: 'textChanged', id: f.hostId, text: f.text }); }
    } else if (f.kind === 'host') {
      diffProps(f, v.props);
      reconcileChildren(f, normalizeChildren(v.props.children));
      syncHostChildren(f);
    } else if (f.kind === 'fragment') {
      reconcileChildren(f, normalizeChildren(v.props.children));
    } else {
      f.type = v.type; // adopt the new closure (fresh constants/props) while keeping hooks
      renderComponent(f);
    }
  }

  function renderComponent(f) {
    const prevFiber = currentFiber;
    const prevIndex = hookIndex;
    currentFiber = f;
    hookIndex = 0;
    let out;
    try {
      if (notComponents.has(f.type)) throw new TypeError('not a component');
      out = f.type(f.props);
    } catch (err) {
      // Per-component boundary: a throwing component renders nothing (the real runtime
      // wraps catalog widgets in OpGenuiResolvedComponentBoundary).
      onError({ message: `${f.type.name || 'component'}: ${err && err.message ? err.message : String(err)}`, phase: 'render' });
      out = null;
    } finally {
      currentFiber = prevFiber;
      hookIndex = prevIndex;
    }
    reconcileChildren(f, normalizeChildren(out));
  }

  function reconcileChildren(parent, vnodes) {
    const old = new Map();
    for (const c of parent.children) old.set(c.slot, c);
    const next = [];
    for (let i = 0; i < vnodes.length; i++) {
      const v = vnodes[i];
      const slot = v.key != null ? 'k:' + v.key : 'i:' + i;
      let f = old.get(slot);
      if (f && compatible(f, v)) { old.delete(slot); update(f, v); }
      else {
        if (f) { old.delete(slot); unmount(f, true); }
        f = mount(v, parent);
      }
      f.slot = slot;
      next.push(f);
    }
    for (const f of old.values()) unmount(f, true);
    parent.children = next;
  }

  function collectHostIds(fibers, out = []) {
    for (const f of fibers) {
      if (f.kind === 'host' || f.kind === 'text') out.push(f.hostId);
      else collectHostIds(f.children, out);
    }
    return out;
  }

  function syncHostChildren(hostFiber) {
    const desired = collectHostIds(hostFiber.children);
    const kids = hostFiber.hostKids;
    for (let i = 0; i < desired.length; i++) {
      const id = desired[i];
      if (kids[i] === id) continue;
      const at = kids.indexOf(id);
      if (at >= 0) kids.splice(at, 1);
      kids.splice(i, 0, id);
      emit({ op: 'move', id, parent: hostFiber.hostId, index: i });
    }
    kids.length = desired.length;
  }

  function unmount(f, emitDestroy) {
    if (f.kind === 'host' || f.kind === 'text') {
      if (emitDestroy) {
        emit({ op: 'destroy', id: f.hostId });
        const hp = f.hostParent;
        const at = hp.hostKids.indexOf(f.hostId);
        if (at >= 0) hp.hostKids.splice(at, 1);
      }
      if (f.fnSlots) for (const id of Object.values(f.fnSlots)) fnTable.delete(id);
      for (const c of f.children) unmount(c, false);
    } else {
      for (const h of f.hooks) if (h && typeof h.cleanup === 'function') safeCall(h.cleanup, 'effect cleanup');
      for (const c of f.children) unmount(c, emitDestroy);
    }
    f.unmounted = true;
  }

  // -- props -------------------------------------------------------------------
  function encodeValue(f, name, v, depth = 0) {
    if (typeof v === 'function') {
      let id = f.fnSlots[name];
      if (!id) { id = nextFnId++; f.fnSlots[name] = id; }
      fnTable.set(id, v);
      return { __fn: id };
    }
    if (v === undefined || v === null || typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? null : v;
    if (depth > 8) return null;
    if (v.$$dil) return null; // element-valued props on primitives are not supported here
    if (Array.isArray(v)) return v.map((x, i) => encodeValue(f, `${name}.${i}`, x, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) out[k] = encodeValue(f, `${name}.${k}`, v[k], depth + 1);
    return out;
  }

  function diffProps(f, props) {
    const seen = new Set();
    for (const name of Object.keys(props)) {
      if (name === 'children') continue;
      seen.add(name);
      const enc = encodeValue(f, name, props[name]);
      if (!deepEqual(enc, f.sentProps[name]) || !(name in f.sentProps)) {
        f.sentProps[name] = enc;
        emit({ op: 'propChanged', id: f.hostId, name, value: enc });
      }
    }
    for (const name of Object.keys(f.sentProps)) {
      if (!seen.has(name)) {
        delete f.sentProps[name];
        emit({ op: 'propChanged', id: f.hostId, name, value: undefined });
      }
    }
  }

  // -- commit loop -------------------------------------------------------------
  function safeCall(fn, phase) {
    try { return fn(); } catch (err) { onError({ message: err && err.message ? err.message : String(err), phase }); }
  }

  function scheduleRender() {
    if (destroyed || renderScheduled) return;
    renderScheduled = true;
    if (rendering) return; // renderRoot loops while renderScheduled is set
    schedule(() => { if (renderScheduled) renderRoot(); });
  }

  function renderRoot(meta = {}) {
    if (destroyed) return;
    rendering = true;
    let passes = 0;
    try {
      do {
        renderScheduled = false;
        if (++passes > 50) { onError({ message: 'Render loop limit exceeded', phase: 'render' }); break; }
        const root = rootElement ? [rootElement] : [];
        reconcileChildren(rootFiber, root.flatMap((r) => normalizeChildren(r)));
        syncHostChildren(rootFiber);
        const effects = pendingEffects;
        pendingEffects = [];
        if (ops.length) {
          const batch = ops;
          ops = [];
          onOps(batch, { generation, ...meta });
        }
        for (const { fiber, h } of effects) {
          if (fiber.unmounted) continue;
          if (typeof h.cleanup === 'function') safeCall(h.cleanup, 'effect cleanup');
          const r = safeCall(h.fn, 'effect');
          h.cleanup = typeof r === 'function' ? r : null;
        }
      } while (renderScheduled);
    } finally {
      rendering = false;
    }
  }

  return {
    DIL, GenUI, __dil: dil, catalog,
    /**
     * Render a DIL program. Re-evaluates `source` only when it changed (each streamed
     * revision ships a new source + constants); otherwise just re-renders with new appData.
     */
    render({ source: src, constants: c = {}, appData: ad = {}, animated = false, sourceGeneration } = {}) {
      if (destroyed) return;
      constants = c || {};
      appData = ad || {};
      generation = sourceGeneration ?? generation + 1;
      if (src !== source) {
        source = src;
        try {
          const el = src ? evaluate(src) : null;
          rootElement = el && el.$$dil ? el : null;
        } catch (err) {
          onError({ message: err && err.message ? err.message : String(err), phase: 'evaluate' });
          return; // keep the previous tree on evaluation failure
        }
      }
      renderRoot({ animated });
    },
    invokeFunction(fnId, args = []) {
      const fn = fnTable.get(fnId);
      if (!fn) return { ok: false, error: 'unknown function' };
      const r = safeCall(() => fn(...(Array.isArray(args) ? args : [])), 'invokeFunction');
      if (renderScheduled && !rendering) renderRoot({ animated: false });
      return { ok: true, value: r === undefined ? undefined : (() => { try { return plain(r); } catch { return undefined; } })() };
    },
    setViewport(width) {
      if (width === viewportWidth) return;
      viewportWidth = width;
      if (rootElement) renderRoot({ animated: false });
    },
    flush() { if (renderScheduled) renderRoot({ animated: false }); },
    reset() {
      for (const c of rootFiber.children) unmount(c, true);
      rootFiber.children = [];
      rootFiber.hostKids = [];
      rootElement = null;
      source = null;
      if (ops.length) { const b = ops; ops = []; onOps(b, { generation, reset: true }); }
    },
    destroy() {
      destroyed = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers.clear();
    },
    stats() { return { nodes: nextNodeId - 1, functions: fnTable.size }; },
  };
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Binary op buffer (DILRenderBufferDelegate, findings §3.2). Little-endian u32 words,
// f64 for numbers, strings de-duplicated into a side table ("attachedValues").
// Value tags: 0 undef, 1 null, 2 false, 3 true, 4 f64, 5 string(idx), 6 array(len),
// 7 object(n keys), 8 function(id).

export function encodeOps(ops) {
  const strings = [];
  const index = new Map();
  let buf = new ArrayBuffer(1024);
  let dv = new DataView(buf);
  let pos = 0;
  const ensure = (n) => {
    if (pos + n <= buf.byteLength) return;
    let size = buf.byteLength * 2;
    while (size < pos + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(buf, 0, pos));
    buf = nb;
    dv = new DataView(buf);
  };
  const u32 = (v) => { ensure(4); dv.setUint32(pos, v >>> 0, true); pos += 4; };
  const f64 = (v) => { ensure(8); dv.setFloat64(pos, v, true); pos += 8; };
  const str = (s) => {
    let i = index.get(s);
    if (i === undefined) { i = strings.length; strings.push(s); index.set(s, i); }
    u32(i);
  };
  const value = (v) => {
    if (v === undefined) return u32(0);
    if (v === null) return u32(1);
    if (v === false) return u32(2);
    if (v === true) return u32(3);
    if (typeof v === 'number') { u32(4); return f64(v); }
    if (typeof v === 'string') { u32(5); return str(v); }
    if (Array.isArray(v)) { u32(6); u32(v.length); for (const x of v) value(x); return; }
    if (typeof v === 'object' && typeof v.__fn === 'number' && Object.keys(v).length === 1) { u32(8); return u32(v.__fn); }
    if (typeof v === 'object') { const ks = Object.keys(v); u32(7); u32(ks.length); for (const k of ks) { str(k); value(v[k]); } return; }
    u32(1);
  };
  for (const o of ops) {
    u32(OP[o.op]);
    switch (o.op) {
      case 'createElement': u32(o.id); str(o.type); break;
      case 'createText': u32(o.id); str(o.text); break;
      case 'destroy': u32(o.id); break;
      case 'move': u32(o.id); u32(o.parent); u32(o.index); break;
      case 'propChanged': u32(o.id); str(o.name); value(o.value); break;
      case 'textChanged': u32(o.id); str(o.text); break;
      default: throw new Error('unknown op ' + o.op);
    }
  }
  return { buffer: buf.slice(0, pos), strings };
}

export function decodeOps(buffer, strings) {
  const dv = new DataView(buffer);
  let pos = 0;
  const u32 = () => { const v = dv.getUint32(pos, true); pos += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(pos, true); pos += 8; return v; };
  const str = () => strings[u32()];
  const value = () => {
    const tag = u32();
    switch (tag) {
      case 0: return undefined;
      case 1: return null;
      case 2: return false;
      case 3: return true;
      case 4: return f64();
      case 5: return str();
      case 6: { const n = u32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = value(); return a; }
      case 7: { const n = u32(); const o = {}; for (let i = 0; i < n; i++) { const k = str(); o[k] = value(); } return o; }
      case 8: return { __fn: u32() };
      default: throw new Error('bad value tag ' + tag);
    }
  };
  const ops = [];
  while (pos < buffer.byteLength) {
    const code = u32();
    switch (code) {
      case 1: ops.push({ op: 'createElement', id: u32(), type: str() }); break;
      case 2: ops.push({ op: 'createText', id: u32(), text: str() }); break;
      case 3: ops.push({ op: 'destroy', id: u32() }); break;
      case 4: ops.push({ op: 'move', id: u32(), parent: u32(), index: u32() }); break;
      case 5: { const id = u32(); const name = str(); ops.push({ op: 'propChanged', id, name, value: value() }); break; }
      case 6: ops.push({ op: 'textChanged', id: u32(), text: str() }); break;
      default: throw new Error('bad opcode ' + code);
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// DOM-free host mirror: applies ops to a plain tree (used by tests and for debugging).

export function createMirror() {
  const nodes = new Map();
  const root = { id: ROOT_ID, type: '#root', props: {}, children: [], parent: null };
  nodes.set(ROOT_ID, root);
  const detach = (n) => {
    if (n.parent) { const p = n.parent; const i = p.children.indexOf(n); if (i >= 0) p.children.splice(i, 1); n.parent = null; }
  };
  const drop = (n) => { nodes.delete(n.id); for (const c of n.children || []) drop(c); };
  function apply(batch) {
    for (const o of batch) {
      switch (o.op) {
        case 'createElement': nodes.set(o.id, { id: o.id, type: o.type, props: {}, children: [], parent: null }); break;
        case 'createText': nodes.set(o.id, { id: o.id, type: '#text', text: o.text, parent: null }); break;
        case 'destroy': { const n = nodes.get(o.id); if (n) { detach(n); drop(n); } break; }
        case 'move': {
          const n = nodes.get(o.id);
          const p = nodes.get(o.parent);
          if (!n || !p) throw new Error(`move of unknown node ${o.id} -> ${o.parent}`);
          detach(n);
          p.children.splice(Math.min(o.index, p.children.length), 0, n);
          n.parent = p;
          break;
        }
        case 'propChanged': { const n = nodes.get(o.id); if (n) { if (o.value === undefined) delete n.props[o.name]; else n.props[o.name] = o.value; } break; }
        case 'textChanged': { const n = nodes.get(o.id); if (n) n.text = o.text; break; }
        default: throw new Error('unknown op ' + o.op);
      }
    }
  }
  const text = (n = root) => (n.type === '#text' ? n.text : (n.children || []).map((c) => text(c)).join(''));
  function findAll(pred, n = root, out = []) {
    if (pred(n)) out.push(n);
    for (const c of n.children || []) findAll(pred, c, out);
    return out;
  }
  function toJSON(n = root) {
    if (n.type === '#text') return n.text;
    return { type: n.type, props: n.props, children: n.children.map((c) => toJSON(c)) };
  }
  return { root, nodes, apply, text, findAll, toJSON };
}
