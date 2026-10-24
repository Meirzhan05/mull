// Host shim for one JavaScriptCore context on iOS. Swift installs `__native` before this
// bundle runs:
//   __native.post(json)            JS -> Swift messages (the Web Worker postMessage protocol)
//   __native.setTimer(id, ms)      ask Swift to call __wonderFireTimer(id) after ms
//   __native.clearTimer(id)
//   __native.log(level, text)
// The bridge is captured here and removed from the global object, so model-written programs
// (evaluated later by the DIL runtime) cannot name it; they reach the host only through the
// same postMessage path a Web Worker program has.

const g = globalThis;
const native = g.__native;
try { delete g.__native; } catch {}

const timers = new Map();
let nextTimer = 1;
function addTimer(fn, ms, args, repeat) {
  const id = nextTimer++;
  if (typeof fn !== 'function') return id;
  const delay = Math.max(0, Number(ms) || 0);
  timers.set(id, { fn, args, repeat: repeat ? Math.max(16, delay) : 0 });
  native.setTimer(id, repeat ? Math.max(16, delay) : delay);
  return id;
}
function clearTimer(id) {
  if (timers.delete(id)) native.clearTimer(id);
}
g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
g.clearTimeout = clearTimer;
g.clearInterval = clearTimer;
g.__wonderFireTimer = (id) => {
  const t = timers.get(id);
  if (!t) return;
  if (t.repeat) native.setTimer(id, t.repeat); else timers.delete(id);
  try { t.fn(...t.args); } catch (err) { native.log('error', `timer: ${err && err.message ? err.message : err}`); }
};
// JavaScriptCore has no TextEncoder; chatgpt-dil's stream validator measures records with it.
if (typeof g.TextEncoder !== 'function') {
  g.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s = '') {
      const str = String(s);
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
          const n = str.charCodeAt(i + 1);
          if (n >= 0xdc00 && n < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00); i++; } else c = 0xfffd;
        } else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
}
if (typeof g.queueMicrotask !== 'function') g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };

const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
g.console = { log: (...a) => native.log('log', fmt(a)), info: (...a) => native.log('log', fmt(a)), warn: (...a) => native.log('warn', fmt(a)), error: (...a) => native.log('error', fmt(a)), debug() {} };

// Worker-style messaging for the engine context.
g.self = g;
g.postMessage = (msg) => native.post(JSON.stringify(msg));
g.__wonderReceive = (json) => {
  const data = JSON.parse(json);
  if (typeof g.onmessage === 'function') g.onmessage({ data });
};
