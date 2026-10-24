// Visual practice types (number_line, chart_select, order_steps): normalization bounds, code
// grading and its FSRS rating mapping, mastery evidence, the structured-output schema and
// mapping, demo-mode extraction from lesson widgets, and the sandboxed review widgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePracticeItem, gradePracticeItem, RATING, PRACTICE_ITEM_TYPES, VISUAL_PRACTICE_TYPES,
  numberLineStops, orderInversions, orderStepsStart, withUnit,
} from '../public/practice-core.js';
import { ratingScore, recordEvidence } from '../public/mastery-core.js';
import { practiceProgram, practiceWidgetProps, practiceResultFor, numberLineLabels, PRACTICE_PRELUDE, PRACTICE_COMPONENT_FOR } from '../public/catalog-practice.js';
import { extractPracticeDeterministic, itemsFromStructured, visualItemsFromComponents, PRACTICE_EXTRACT_SCHEMA, PRACTICE_EXTRACT_PROMPT, VISUAL_ITEM_PROPERTIES } from '../server/practice.js';
import { EXTRACT_SCHEMA } from '../server/prompts.js';
import { demo, DEMO_FILES, runProgram, catalogNodes, click } from './helpers.js';

const NL = { type: 'number_line', prompt: 'Where does the sun turn orange?', min: 0, max: 90, step: 2.5, answer: 10, tolerance: 2.5, unit: '°', concept: 'Sun height' };
const CHART = { type: 'chart_select', prompt: 'Which color fills the sky?', chart: 'bar', title: 'Scattering', unit: '× red', points: [{ label: 'Violet', value: 7.6 }, { label: 'Blue', value: 4.4 }, { label: 'Red', value: 1 }], answer: 1, concept: 'Rayleigh scattering' };
const ORDER = { type: 'order_steps', prompt: 'Order the loop', steps: ['Read', 'Score', 'Pick', 'Append'], concept: 'Generation loop' };

test('visual types are registered practice types', () => {
  for (const t of VISUAL_PRACTICE_TYPES) assert.ok(PRACTICE_ITEM_TYPES.includes(t));
  assert.deepEqual(Object.keys(PRACTICE_COMPONENT_FOR).sort(), [...VISUAL_PRACTICE_TYPES].sort());
});

test('number_line: normalization enforces a 2-40 step grid, a reachable answer and a bounded tolerance', () => {
  const item = normalizePracticeItem(NL);
  assert.deepEqual([item.min, item.max, item.step, item.answer, item.tolerance, item.unit, item.concept], [0, 90, 2.5, 10, 2.5, '°', 'Sun height']);
  assert.match(item.id, /^number_line-/);
  assert.equal(numberLineStops(item).length, 37);
  assert.equal(normalizePracticeItem({ ...NL, step: '2.5', min: '0' }).step, 2.5, 'numeric strings are accepted');
  assert.equal(normalizePracticeItem({ ...NL, tolerance: undefined }).tolerance, 0, 'tolerance defaults to exact');
  const bad = [
    { prompt: '' }, { max: 0 }, { max: -5 }, { step: 0 }, { step: -1 }, { step: 7 }, // 90/7 is not a whole grid
    { step: 1 }, // 90 steps > 40
    { min: 0, max: 2, step: 1, answer: 1, tolerance: 0 }, // 2 steps is the minimum: valid
    { answer: 95 }, { answer: -1 }, { tolerance: -1 }, { tolerance: 30 }, // > a quarter of the range
    { answer: 11, tolerance: 0.5 }, // nearest grid point 10 is 1 away
    { min: NaN }, { answer: 'ten' }, { max: 1e10, step: 1e9 },
  ];
  const results = bad.map((b) => normalizePracticeItem({ ...NL, ...b }));
  assert.deepEqual(results.map((r) => r === null), [true, true, true, true, true, true, true, false, true, true, true, true, true, true, true, true]);
  assert.equal(normalizePracticeItem({ ...NL, min: 0, max: 1, step: 1, answer: 1, tolerance: 0 }), null, '1 step is too few');
  assert.ok(normalizePracticeItem({ ...NL, answer: 11, tolerance: 1 }), 'an off-grid answer is fine when a grid point is within tolerance');
});

test('number_line grading: inner half of the tolerance is Good, its edge Hard, outside Again', () => {
  const item = normalizePracticeItem(NL);
  const g = (v) => gradePracticeItem(item, v);
  assert.deepEqual(g(10), { correct: true, rating: RATING.good, expected: '10°', distance: 0, close: false });
  assert.equal(g(11.25).rating, RATING.good);
  assert.equal(g(12.5).rating, RATING.hard);
  assert.equal(g(12.5).correct, true);
  assert.equal(g(7.5).rating, RATING.hard);
  assert.deepEqual([g(15).correct, g(15).rating, g(15).close, g(15).distance], [false, RATING.again, true, 5]);
  assert.deepEqual([g(40).rating, g(40).close], [RATING.again, false]);
  for (const v of [null, undefined, '', 'x', NaN]) assert.equal(g(v).rating, RATING.again, `bad answer ${v}`);
  const exact = normalizePracticeItem({ ...NL, step: 5, tolerance: 0 });
  assert.equal(gradePracticeItem(exact, 10).rating, RATING.good, 'tolerance 0: the exact point is Good');
  assert.equal(gradePracticeItem(exact, 15).rating, RATING.again);
  const decimals = normalizePracticeItem({ ...NL, min: 0, max: 1, step: 0.1, answer: 0.3, tolerance: 0, unit: '' });
  assert.equal(gradePracticeItem(decimals, 0.1 + 0.2).rating, RATING.good, 'float noise is not a miss');
  assert.equal(withUnit('12', 'years'), '12 years');
});

test('chart_select: normalization bounds and index grading', () => {
  const item = normalizePracticeItem(CHART);
  assert.deepEqual([item.chart, item.title, item.unit, item.showValues, item.points.length, item.answer], ['bar', 'Scattering', '× red', true, 3, 1]);
  assert.equal(normalizePracticeItem({ ...CHART, correct_index: 2, answer: undefined }).answer, 2, 'correct_index works too');
  assert.equal(normalizePracticeItem({ ...CHART, show_values: false }).showValues, false);
  const pts = (n) => Array.from({ length: n }, (_, i) => ({ label: `P${i}`, value: i }));
  for (const b of [
    { points: pts(1) }, { points: pts(9) }, { answer: 3 }, { answer: -1 }, { answer: 1.5 }, { chart: 'pie' },
    { points: [{ label: 'A', value: 1 }, { label: 'a', value: 2 }] }, // duplicate labels
    { points: [{ label: 'A', value: 1 }, { label: '', value: 2 }] }, { points: [{ label: 'A', value: 1 }, { label: 'B', value: 'x' }] },
    { chart: 'line', points: pts(2), answer: 0 }, // a line needs 3+ points
  ]) assert.equal(normalizePracticeItem({ ...CHART, ...b }), null, JSON.stringify(b));
  assert.ok(normalizePracticeItem({ ...CHART, chart: 'line', points: pts(3), answer: 2 }));
  assert.deepEqual(gradePracticeItem(item, 1), { correct: true, rating: RATING.good, expected: 'Blue' });
  assert.deepEqual(gradePracticeItem(item, 0), { correct: false, rating: RATING.again, expected: 'Blue' });
  assert.equal(gradePracticeItem(item, '1').rating, RATING.again, 'only an index counts');
});

test('order_steps: normalization, start order, inversions and the rating mapping', () => {
  const item = normalizePracticeItem(ORDER);
  assert.deepEqual(item.steps, ORDER.steps);
  for (const b of [{ steps: ['a', 'b'] }, { steps: Array.from({ length: 8 }, (_, i) => `s${i}`) }, { steps: ['a', 'b', 'A.'] }, { steps: ['a', '', 'c'] }]) {
    assert.equal(normalizePracticeItem({ ...ORDER, ...b }), null, JSON.stringify(b));
  }
  const start = orderStepsStart(item);
  assert.deepEqual([...start].sort(), [0, 1, 2, 3]);
  assert.ok(orderInversions(start, 4) >= 2, 'never starts solved or one swap away');
  assert.deepEqual(orderStepsStart(item), start, 'deterministic per item');
  assert.equal(orderInversions([0, 1, 2], 3), 0);
  assert.equal(orderInversions([2, 1, 0], 3), 3);
  assert.equal(orderInversions([0, 0, 1], 3), null);
  assert.equal(orderInversions([0, 1], 3), null);
  const g = (a) => gradePracticeItem(item, a);
  assert.deepEqual(g([0, 1, 2, 3]), { correct: true, rating: RATING.good, expected: 'Read → Score → Pick → Append', inversions: 0, inPlace: 4 });
  assert.deepEqual([g([0, 2, 1, 3]).correct, g([0, 2, 1, 3]).rating, g([0, 2, 1, 3]).inPlace], [true, RATING.hard, 2]);
  assert.deepEqual([g([1, 0, 3, 2]).correct, g([1, 0, 3, 2]).rating], [false, RATING.again]);
  assert.equal(g([0, 1, 2]).rating, RATING.again, 'not a permutation');
  assert.equal(g('0123').rating, RATING.again);
  const three = normalizePracticeItem({ ...ORDER, steps: ['a', 'b', 'c'] });
  assert.equal(gradePracticeItem(three, [1, 0, 2]).rating, RATING.again, 'one swap in a 3-step list is a miss');
});

test('visual grades become mastery evidence through the item concept', () => {
  const nl = normalizePracticeItem(NL);
  const order = normalizePracticeItem(ORDER);
  const grades = [[nl, gradePracticeItem(nl, 10)], [nl, gradePracticeItem(nl, 12.5)], [order, gradePracticeItem(order, [1, 0, 3, 2])]];
  assert.deepEqual(grades.map(([, g]) => ratingScore(g.rating)), [1, 0.6, 0]);
  let mastery = {};
  for (const [item, g] of grades) mastery = recordEvidence(mastery, [{ concept: item.concept, score: ratingScore(g.rating), source: 'review' }], new Date('2026-10-01T10:00:00Z'));
  const keys = Object.keys(mastery.concepts || mastery);
  assert.ok(keys.length >= 2, 'both concepts are tracked');
  assert.match(JSON.stringify(mastery), /Sun height/);
  assert.match(JSON.stringify(mastery), /Generation loop/);
});

test('structured output: the extraction schema adds the visual types and fields, strictly', () => {
  const item = PRACTICE_EXTRACT_SCHEMA.properties.items.items;
  assert.equal(item.additionalProperties, false);
  for (const t of VISUAL_PRACTICE_TYPES) assert.ok(item.properties.type.enum.includes(t));
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort(), 'every property is required (strict structured output)');
  for (const k of Object.keys(VISUAL_ITEM_PROPERTIES)) assert.ok(item.properties[k]);
  assert.equal(item.properties.points.items.additionalProperties, false);
  assert.equal(EXTRACT_SCHEMA.properties.items.items.properties.points, undefined, 'the base schema is left untouched');
  assert.match(PRACTICE_EXTRACT_PROMPT, /number_line/);
  assert.match(PRACTICE_EXTRACT_PROMPT, /beats? a flashcard|better than a flashcard/);
});

test('structured output: visual items map to practice items; invalid ones are dropped', () => {
  const blank = { concept: '', prompt: '', choices: [], correct_index: 0, answer: '', statement: '', is_true: false, front: '', back: '', rubric: [], sample_answer: '', explanation: '', min: 0, max: 0, step: 0, target: 0, tolerance: 0, unit: '', chart: '', chart_title: '', points: [], show_values: true, steps: [] };
  const items = itemsFromStructured({ items: [
    { ...blank, type: 'number_line', concept: 'Doubling time', prompt: 'Rate that doubles money in 9 years?', min: 0, max: 20, step: 1, target: 8, tolerance: 1, unit: '%', explanation: 'Rule of 72.' },
    { ...blank, type: 'chart_select', concept: 'Compounding', prompt: 'When did it pass $5,000?', chart: 'line', chart_title: 'Balance', unit: '$', points: [{ label: '10y', value: 1967 }, { label: '20y', value: 3870 }, { label: '30y', value: 7612 }], correct_index: 2, show_values: false },
    { ...blank, type: 'order_steps', concept: 'Loop', prompt: 'Order it', steps: ['a', 'b', 'c'] },
    { ...blank, type: 'number_line', prompt: 'broken', min: 0, max: 100, step: 1, target: 5 }, // 100 steps
    { ...blank, type: 'chart_select', prompt: 'broken', points: [{ label: 'x', value: 1 }], correct_index: 0 },
    { type: 'order_steps', prompt: 'missing steps' },
  ] });
  assert.deepEqual(items.map((i) => i.type), ['number_line', 'chart_select', 'order_steps']);
  assert.deepEqual([items[0].answer, items[0].tolerance, items[0].unit, items[0].concept], [8, 1, '%', 'Doubling time']);
  assert.deepEqual([items[1].chart, items[1].title, items[1].showValues, items[1].answer], ['line', 'Balance', false, 2]);
  assert.equal(items[1].concept, 'Compounding');
});

for (const file of DEMO_FILES) {
  test(`demo extraction: ${file} yields one item of each visual type`, () => {
    const { items } = extractPracticeDeterministic(demo(file));
    const visual = items.filter((i) => VISUAL_PRACTICE_TYPES.includes(i.type));
    assert.deepEqual(visual.map((i) => i.type), ['number_line', 'chart_select', 'order_steps']);
    assert.ok(items.indexOf(visual[2]) < 12, 'visual items fit in the first 12-card review session');
    for (const v of visual) {
      assert.ok(v.concept, `${v.type} has a concept`);
      assert.deepEqual(normalizePracticeItem(v), v, `${v.type} survives re-normalization (client side)`);
    }
    const nl = visual[0];
    assert.equal(gradePracticeItem(nl, nl.answer).rating, RATING.good, 'the target itself is Good');
    assert.equal(items.filter((i) => !VISUAL_PRACTICE_TYPES.includes(i.type)).length <= 12, true);
  });
}

test('demo extraction: a lesson without the source widgets adds no visual items', () => {
  assert.deepEqual(visualItemsFromComponents('# Plain\n\nJust text, <KeyTerm term="x" definition="y"/>.'), []);
});

test('widget props never carry the answer; labels land on round values', () => {
  const nl = normalizePracticeItem(NL);
  const props = practiceWidgetProps(nl);
  assert.equal(props.itemId, nl.id);
  assert.equal(JSON.stringify(props).includes('tolerance'), false);
  assert.deepEqual(props.labels.map((i) => props.stops[i]), [0, 30, 60, 90]);
  assert.equal(props.display[4], '10°');
  assert.equal(practiceWidgetProps(normalizePracticeItem(CHART)).answer, undefined);
  const stops = (a, b, s) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => a + i * s);
  assert.deepEqual(numberLineLabels(stops(0, 1, 0.05)).length, 6);
  assert.deepEqual(numberLineLabels(stops(0, 13, 1)).at(-1), 13, 'the right end is always labeled');
});

function render(item, appData) {
  const p = practiceProgram(item);
  return runProgram({ ...p, appData }, { viewportWidth: 390 });
}
const clickables = (env) => env.mirror.findAll((n) => n.props?.onClick);
const byLabel = (env, label) => env.mirror.findAll((n) => n.props?.onClick && n.props.ariaLabel === label)[0];
const invoke = (env, node) => { const r = env.rt.invokeFunction(node.props.onClick.__fn, []); assert.ok(r.ok, r.error); };

test('PracticeNumberLine: tap a tick or use −/+, Check sends the value, the result locks it', () => {
  const item = normalizePracticeItem(NL);
  assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', PRACTICE_PRELUDE));
  const env = render(item);
  assert.deepEqual(env.errors, []);
  assert.equal(catalogNodes(env.mirror, 'PracticeNumberLine').length, 1);
  assert.match(env.mirror.text(), /Tap the line/);
  const check = env.mirror.findAll((n) => n.type === 'button' && env.mirror.text(n) === 'Check')[0];
  assert.equal(check.props.disabled, true, 'nothing to check before a marker is placed');
  invoke(env, byLabel(env, 'Move marker right')); // first press places it mid-line
  assert.match(env.mirror.text(), /Marker at 45°/);
  const cells = env.mirror.findAll((n) => n.props?.__component === 'PracticeNLCell');
  assert.equal(cells.length, 37);
  invoke(env, cells[5]); // 12.5°
  invoke(env, byLabel(env, 'Move marker left')); // 10°
  assert.match(env.mirror.text(), /Marker at 10°/);
  assert.ok(env.mirror.findAll((n) => n.props?.role === 'img' && /marker at 10°/.test(n.props.ariaLabel || '')).length, 'the line has an accessible description');
  click(env, 'Check');
  assert.deepEqual(env.actions.at(-1), { handler: 'client', type: 'practice_answer', payload: { itemId: item.id, answer: 10 } });
  const g = gradePracticeItem(item, 10);
  const locked = render(item, { practiceResult: practiceResultFor(item, 10, g) });
  assert.deepEqual(locked.errors, []);
  assert.equal(locked.mirror.findAll((n) => n.props?.__component === 'PracticeNLCell').length, 0, 'locked cells are not tappable');
  assert.equal(locked.mirror.findAll((n) => n.props?.background === 'success-subtle').length, 3, 'the accepted band 7.5-12.5 is shaded');
  assert.equal(locked.mirror.findAll((n) => n.type === 'button' && locked.mirror.text(n) === 'Check').length, 0);
});

test('PracticeChartSelect: bars and points are labeled buttons; the pick is sent as an index', () => {
  for (const chart of ['bar', 'line']) {
    const item = normalizePracticeItem({ ...CHART, chart });
    const env = render(item);
    assert.deepEqual(env.errors, []);
    const picks = clickables(env).filter((n) => n.type === 'pressable');
    assert.deepEqual(picks.map((p) => p.props.ariaLabel), ['Choose Violet: 7.6', 'Choose Blue: 4.4', 'Choose Red: 1']);
    invoke(env, picks[1]);
    assert.match(env.mirror.text(), /Selected: Blue/);
    click(env, 'Check');
    assert.deepEqual(env.actions.at(-1).payload, { itemId: item.id, answer: 1 });
    const locked = render(item, { practiceResult: practiceResultFor(item, 0, gradePracticeItem(item, 0)) });
    assert.deepEqual(locked.errors, []);
    const variants = locked.mirror.findAll((n) => n.type === 'pressable').map((p) => p.props.variant);
    assert.deepEqual(variants, ['pick-wrong', 'pick-right', chart === 'line' ? 'pick' : 'pick-dim']);
  }
  const hidden = render(normalizePracticeItem({ ...CHART, show_values: false }));
  assert.equal(hidden.mirror.findAll((n) => n.type === 'pressable')[0].props.ariaLabel, 'Choose Violet');
});

test('PracticeOrderSteps: move up/down reorders; Check sends the order; the result marks each step', () => {
  const item = normalizePracticeItem(ORDER);
  const start = orderStepsStart(item);
  const env = render(item);
  assert.deepEqual(env.errors, []);
  const rowText = () => env.mirror.findAll((n) => n.props?.__component === 'PracticeOrderRow').map((r) => env.mirror.text(r).replace(/^\d/, ''));
  assert.deepEqual(rowText(), start.map((i) => item.steps[i]));
  const first = item.steps[start[0]];
  assert.equal(byLabel(env, `Move "${first}" up`).props.disabled, true);
  invoke(env, byLabel(env, `Move "${first}" down`));
  assert.equal(rowText()[1], first);
  click(env, 'Check');
  const sent = env.actions.at(-1).payload.answer;
  assert.deepEqual(sent, [start[1], start[0], ...start.slice(2)]);
  const locked = render(item, { practiceResult: practiceResultFor(item, [0, 2, 1, 3], gradePracticeItem(item, [0, 2, 1, 3])) });
  assert.deepEqual(locked.errors, []);
  assert.equal(locked.mirror.findAll((n) => n.props?.ariaLabel === 'In the right place').length, 2);
  assert.match(locked.mirror.text(), /Belongs at step 3/);
});
