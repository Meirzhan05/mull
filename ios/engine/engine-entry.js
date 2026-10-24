// One DIL surface on iOS: the same sandbox the web runs in a Web Worker
// (genui-lab/wonder/public/wonder-worker.js: chatgpt-dil runtime + the learning catalog),
// evaluated in its own JSContext. Swift sends the worker protocol through __wonderReceive and
// gets {type:'ops'|'hostAction'|'error'|'viewState'|...} back through postMessage. Ops travel as
// JSON (`init` with binary:false), not the binary buffer.
import './jsc-shim.js';
import '../../genui-lab/wonder/public/wonder-worker.js';
