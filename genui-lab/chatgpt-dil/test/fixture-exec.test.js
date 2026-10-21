// Executes the REAL server-sent DIL programs from the capture through the runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createMirror, encodeOps, decodeOps } from '../src/runtime.js';
import { compile, resolutionIdsFromProgram } from '../src/compiler.js';
import { parseConversationSource, ConversationTurn } from '../src/stream.js';
import { QUIZ_APP_DATA, QUIZ_MARKUP, QUIZ_RESOLUTION_ID } from '../src/demo-data.js';
import { finalDil, streamText } from './helpers.js';

function setup(viewportWidth = 1024) {
  const mirror = createMirror();
  const errors = [];
  const actions = [];
  let opCount = 0;
  const rt = createRuntime({
    viewportWidth,
    onOps(ops) { opCount += ops.length; const e = encodeOps(ops); mirror.apply(decodeOps(e.buffer, e.strings)); },
    onError: (e) => errors.push(e),
    onHostAction: (a) => actions.push(a),
    schedule: (fn) => fn(),
  });
  return { rt, mirror, errors, actions, ops: () => opCount };
}
const catalogNodes = (mirror, name) => mirror.findAll((n) => n.props?.__component === name);

test('final-dil.json: real server code renders the Tokyo weather card and AAPL stock card', () => {
  const dil = finalDil();
  const { rt, mirror, errors, actions } = setup();
  rt.render({ source: dil.code, constants: dil.constants, appData: dil.appData });
  assert.deepEqual(errors, []);
  const text = mirror.text();
  for (const s of ['Tokyo weather this week & Apple stock', '🌦️ Tokyo, Japan — 7-day forecast', '28°C / 82°F', 'Mostly cloudy, warm and humid',
    'Wettest day', 'Tue 27', '22° / 15°', 'AAPL', '$339.50', 'Down today', '−$3.44 (−1.00%)', 'Apple Inc.', 'Overnight price']) {
    assert.ok(text.includes(s), `missing text: ${s}`);
  }
  // catalog components resolved from appData.opGenui.componentResults
  const charts = catalogNodes(mirror, 'StockChart');
  assert.equal(charts.length, 1);
  const chartText = mirror.text(charts[0]);
  assert.ok(chartText.includes('Apple Inc (AAPL)'));
  assert.ok(chartText.includes('1D') && chartText.includes('MAX'));
  const svg = mirror.findAll((n) => n.type === 'svg', charts[0]);
  assert.equal(svg.length, 1);
  const line = mirror.findAll((n) => n.type === 'path' && n.props.fill === 'none', svg[0])[0];
  assert.ok(line.props.d.split('L').length >= 79, 'price line has a point per 1D sample');
  const images = catalogNodes(mirror, 'AsyncImage');
  assert.equal(images.length, 2);
  const img = mirror.findAll((n) => n.type === 'image', images[0])[0];
  assert.match(img.props.src, /^https:\/\/images\.openai\.com\/static-rsc-4\/.+purpose=inline$/);
  assert.equal(img.props.aspectRatio, '1:1');
  const entity = catalogNodes(mirror, 'Entity')[0];
  assert.equal(mirror.text(entity), 'Apple Inc.');
  const cites = catalogNodes(mirror, 'Cite');
  assert.equal(mirror.text(cites[0]), 'StockAnalysis.com +1');
  assert.match(mirror.text(cites[1]), /^\S.* \+1$/);
  // entity click dispatches the server-provided click_action
  rt.invokeFunction(entity.props.onClick.__fn, []);
  assert.equal(actions[0].type, 'open_entity_detail');
  assert.equal(actions[0].payload.query, 'Apple Inc.');
  assert.equal(actions[0].payload.extraParams.disambiguation, 'NASDAQ ticker AAPL');
});

test('StockChart range switching re-renders the chart from another timeframe config', () => {
  const dil = finalDil();
  const { rt, mirror } = setup();
  rt.render({ source: dil.code, constants: dil.constants, appData: dil.appData });
  const chart = catalogNodes(mirror, 'StockChart')[0];
  const before = mirror.findAll((n) => n.type === 'path' && n.props.fill === 'none', chart)[0].props.d;
  const fiveY = mirror.findAll((n) => n.type === 'pressable' && mirror.text(n) === '5Y', chart)[0];
  rt.invokeFunction(fiveY.props.onClick.__fn, []);
  const after = mirror.findAll((n) => n.type === 'path' && n.props.fill === 'none', chart)[0].props.d;
  assert.notEqual(before, after);
  assert.equal(mirror.findAll((n) => n.type === 'pressable' && n.props.ariaPressed === true, chart).map((n) => mirror.text(n))[0], '5Y');
});

test('stream replay: every server revision renders incrementally in one runtime (server code and local compiler)', () => {
  for (const mode of ['server', 'local']) {
    const { rt, mirror, errors, ops } = setup(390);
    const turn = new ConversationTurn();
    let renders = 0;
    let opsAtRev20 = 0;
    for (const rec of parseConversationSource(streamText())) {
      const r = turn.apply(rec);
      if (r.type !== 'content' || !r.message.dil) continue;
      const m = r.message;
      if (mode === 'server') {
        rt.render({ source: m.dil.code, constants: m.dil.constants, appData: m.dil.appData, animated: m.status === 'streaming' });
      } else {
        const c = compile(m.markdown, { partial: m.status !== 'complete', resolutionIdFor: resolutionIdsFromProgram(m.dil.code, m.dil.constants) });
        rt.render({ source: c.code, constants: c.constants, appData: m.dil.appData, animated: m.status === 'streaming' });
      }
      renders++;
      if (m.revision === 20) opsAtRev20 = ops();
    }
    assert.deepEqual(errors, [], mode);
    assert.ok(renders >= 44);
    const text = mirror.text();
    assert.ok(text.includes('28°C / 82°F') && text.includes('$339.50') && text.includes('Apple Inc.'), mode);
    assert.equal(catalogNodes(mirror, 'StockChart').length, 1, mode);
    assert.equal(catalogNodes(mirror, 'AsyncImage').length, 2, mode);
    // incremental: later revisions add ops rather than rebuilding (first ~third of stream used < half the ops)
    assert.ok(opsAtRev20 < ops() / 2, `${mode}: ${opsAtRev20} vs ${ops()}`);
  }
});

test('streaming text grows via textChanged on the same node (enables word-fade)', () => {
  const { rt, mirror } = setup();
  const turn = new ConversationTurn();
  const seen = [];
  for (const rec of parseConversationSource(streamText())) {
    const r = turn.apply(rec);
    if (r.type !== 'content' || !r.message.dil) continue;
    rt.render({ source: r.message.dil.code, constants: r.message.dil.constants, appData: r.message.dil.appData });
    const p = mirror.findAll((n) => n.type === 'text')[0];
    if (p) seen.push(p.children[0].id);
    if (seen.length > 4) break;
  }
  assert.equal(new Set(seen).size, 1, 'the first paragraph keeps its text node across revisions');
});

test('LearningQuiz: answer, feedback, navigation, results with celebration, next-quiz action', () => {
  const { rt, mirror, errors, actions } = setup(390);
  const c = compile(QUIZ_MARKUP, { resolutionIdFor: () => QUIZ_RESOLUTION_ID });
  rt.render({ source: c.code, constants: c.constants, appData: QUIZ_APP_DATA });
  assert.deepEqual(errors, []);
  const quiz = () => catalogNodes(mirror, 'LearningQuiz')[0];
  assert.ok(mirror.text(quiz()).includes('1 of 3'));
  const option = (label) => mirror.findAll((n) => n.type === 'pressable' && n.props.ariaPressed !== undefined && mirror.text(n).includes(label), quiz())[0];
  const button = (label) => mirror.findAll((n) => n.type === 'button' && mirror.text(n) === label, quiz())[0];
  // hint toggle
  const hintBtn = mirror.findAll((n) => n.type === 'pressable' && n.props.ariaLabel === 'Hint', quiz())[0];
  rt.invokeFunction(hintBtn.props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('Square both legs'));
  // Q1 correct
  rt.invokeFunction(option('`5`').props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('Correct!'));
  assert.ok(mirror.text(quiz()).includes('√25 = 5'));
  rt.invokeFunction(button('Next').props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('2 of 3'));
  // Q2 wrong
  rt.invokeFunction(option('Either leg').props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('Not quite'));
  rt.invokeFunction(button('Next').props.onClick.__fn, []);
  // Q3 true/false correct
  rt.invokeFunction(option('True').props.onClick.__fn, []);
  rt.invokeFunction(button('See results').props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('2 of 3 correct'));
  const cel = mirror.findAll((n) => n.type === 'celebration', quiz())[0];
  assert.equal(cel.props.trigger, true);
  // no server actions while nativeServerActions.ready is false
  assert.equal(actions.filter((a) => a.handler === 'server').length, 0);
  rt.invokeFunction(button('Next quiz').props.onClick.__fn, []);
  assert.equal(actions.at(-1).type, 'issue_new_turn');
  assert.match(actions.at(-1).payload.query, /harder quiz/);
  rt.invokeFunction(button('Try again').props.onClick.__fn, []);
  assert.ok(mirror.text(quiz()).includes('1 of 3'));
});

test('LearningQuiz sends widget server actions when nativeServerActions.ready', () => {
  const { rt, mirror, actions } = setup();
  const c = compile(QUIZ_MARKUP, { resolutionIdFor: () => QUIZ_RESOLUTION_ID });
  const appData = { opGenui: { ...QUIZ_APP_DATA.opGenui, nativeServerActions: { ready: true } } };
  rt.render({ source: c.code, constants: c.constants, appData });
  const opt = mirror.findAll((n) => n.type === 'pressable' && n.props.ariaPressed !== undefined)[0];
  rt.invokeFunction(opt.props.onClick.__fn, []);
  const a = actions.find((x) => x.handler === 'server');
  assert.equal(a.type, 'learning_quiz_answer');
  assert.equal(a.nativeWidgetResolutionId, QUIZ_RESOLUTION_ID);
  assert.equal(a.componentName, 'LearningQuiz');
});

test('pending and failed component results degrade (skeleton / fallback)', () => {
  const dil = finalDil();
  const { rt, mirror, errors } = setup();
  const results = { ...dil.appData.opGenui.componentResults };
  const chartId = Object.keys(results).find((k) => results[k].componentName === 'StockChart');
  const imgId = Object.keys(results).find((k) => results[k].componentName === 'AsyncImage');
  results[chartId] = { status: 'pending' };
  results[imgId] = { status: 'failed', code: 'tool_failed', retryable: false };
  rt.render({ source: dil.code, constants: dil.constants, appData: { opGenui: { ...dil.appData.opGenui, componentResults: results } } });
  assert.deepEqual(errors, []);
  const chart = catalogNodes(mirror, 'StockChart')[0];
  assert.equal(chart.type, 'loading-block');
  assert.equal(catalogNodes(mirror, 'AsyncImage').length, 1);
});
