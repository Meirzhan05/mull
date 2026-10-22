// Math: protected LaTeX spans in the compiler, LaTeX-aware JSON escapes, catalog inline math,
// the KaTeX static route and the Unicode fallback.
import fs from 'node:fs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { compileWonder } from '../server/compile.js';
import { protectMath } from '../server/math-spans.js';
import { tryParseExpression, parseLenientJSON, LATEX_COMMANDS } from '../server/lenient-json.js';
import { createWonderServer } from '../server/app.js';
import { prettyLatex, KATEX_OPTIONS } from '../public/math.js';
import { runProgram, catalogNodes, demo, DEMO_FILES } from './helpers.js';

/** Every math node of a compiled program, as {latex, display}. */
function mathNodes(src, opts) {
  const r = compileWonder(src, opts);
  const env = runProgram(r);
  assert.deepEqual(env.errors, []);
  return {
    r,
    env,
    math: env.mirror.findAll((n) => n.type === 'math').map((n) => ({ latex: env.mirror.text(n), display: !!n.props.display })),
    text: env.mirror.findAll((n) => n.type === 'text' || n.type === 'title' || n.type === 'list-item').map((n) => env.mirror.text(n)).join('\n'),
  };
}

const REAL = String.raw`<math>\text{mean} = \frac{x_1 + x_2 + \dots + x_n}{n}</math>`;

test('the real Claude <math> example keeps every brace and becomes display math', () => {
  const { math, r } = mathNodes(`The average:\n\n${REAL}\n\nDone.`);
  assert.deepEqual(math, [{ latex: String.raw`\text{mean} = \frac{x_1 + x_2 + \dots + x_n}{n}`, display: true }]);
  assert.ok(!Object.values(r.constants).some((v) => typeof v === 'string' && /__wonder_m/.test(v)));
  assert.doesNotMatch(r.code, /__wonder_m/);
  // inline <math> inside a sentence stays inline; `display` forces display
  const inl = mathNodes(String.raw`So <math>\bar{x} = \frac{\sum x_i}{n}</math> is the mean, and <math display>a^{2}</math>.`).math;
  assert.deepEqual(inl, [{ latex: String.raw`\bar{x} = \frac{\sum x_i}{n}`, display: false }, { latex: 'a^{2}', display: true }]);
});

test('$$…$$, \\[…\\], \\(…\\) and $…$ become math primitives', () => {
  const src = [
    String.raw`Inline $\frac{1}{2} + x_1$ and \(\sqrt{a^2+b^2}\) here.`,
    '',
    String.raw`$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$`,
    '',
    '$$',
    String.raw`E = mc^{2}`,
    '$$',
    '',
    String.raw`\[ \int_0^1 x\,dx = \tfrac{1}{2} \]`,
    '',
    String.raw`- list item with $\alpha$`,
    String.raw`## Heading with $\lambda^4$`,
  ].join('\n');
  const { math } = mathNodes(src);
  assert.deepEqual(math, [
    { latex: String.raw`\frac{1}{2} + x_1`, display: false },
    { latex: String.raw`\sqrt{a^2+b^2}`, display: false },
    { latex: String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`, display: true },
    { latex: 'E = mc^{2}', display: true },
    { latex: String.raw`\int_0^1 x\,dx = \tfrac{1}{2}`, display: true },
    { latex: String.raw`\alpha`, display: false },
    { latex: String.raw`\lambda^4`, display: false },
  ]);
});

test('dollar amounts are never math', () => {
  for (const s of [
    'Ana saved $40,000 by 65; Ben put in $3, $4 and then $5 a week.',
    'The ticket was $6.',
    'It costs $5 and $10 at the door.',
    'Between $5-$10, or $1,000 × 10% = **$100**.',
    'Pay $5 to $10 dollars, or more.',
    'A \\$5 note and an escaped \\$x\\$ pair.',
  ]) {
    const { math, text } = mathNodes(s);
    assert.deepEqual(math, [], s);
    assert.ok(text.includes(s.replace(/\\\$/g, '$').replace(/\*\*/g, '')), `${s} -> ${text}`);
  }
  // a price next to a formula: only the formula is math
  const mixed = mathNodes('A $5 prism and $x^2$ later, then $10.');
  assert.deepEqual(mixed.math, [{ latex: 'x^2', display: false }]);
  assert.match(mixed.text, /A \$5 prism and/);
  assert.match(mixed.text, /later, then \$10\./);
});

test('math inside code fences and code spans is untouched', () => {
  const src = '```\n$x^2$ and \\(y\\) and <math>z</math>\n```\n\nUse `$\\frac{a}{b}$` literally.';
  const p = protectMath(src);
  assert.equal(p.source, src);
  assert.deepEqual(p.latex, []);
  const { math } = mathNodes(src);
  assert.deepEqual(math, []);
});

test('math is never applied inside tags or raw primitives', () => {
  const src = '<FunctionGraph title="$1 at $x$" fn="x" xRange={[0,1]} yRange={[0,1]}/>\n\n<code>$a$</code>';
  const p = protectMath(src);
  assert.equal(p.source, src);
});

const MATH_HEAVY = [
  '# Averages',
  '',
  String.raw`The mean of $n$ values is $\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i$, costs $5 or $10 to compute by hand.`,
  '',
  REAL,
  '',
  String.raw`$$\sigma^2 = \frac{1}{n}\sum_{i=1}^{n} (x_i - \bar{x})^2$$`,
  '',
  String.raw`\[ \sigma = \sqrt{\sigma^2} \]`,
  '',
  String.raw`So \(\sigma\) is in the data's units; $40,000 salaries give $\sigma$ in dollars.`,
  '',
  String.raw`<LessonStepper title="Worked" steps={[{"label":"Sum","text":"$\frac{2+4}{2} = 3$"},{"label":"Spread","text":"\\(\sigma = 1\\) and $3, $4 prices"}]}/>`,
  '',
].join('\n');

test('every streamed prefix of a math-heavy lesson compiles, runs and never shows raw LaTeX', () => {
  const finalMath = new Set(mathNodes(MATH_HEAVY).math.map((m) => m.latex));
  assert.equal(finalMath.size, 7); // \sigma appears twice; the stepper shows its first step
  for (let n = 0; n <= MATH_HEAVY.length; n++) {
    const r = compileWonder(MATH_HEAVY.slice(0, n), { partial: true, salt: 'm', fallback: false });
    assert.doesNotMatch(r.code, /__wonder_[hm]/, `prefix ${n}`);
    try { new Function('DIL', '__dil', 'GenUI', r.code); } catch (e) { assert.fail(`prefix ${n} produced invalid JS: ${e.message}`); }
    const env = runProgram(r);
    assert.deepEqual(env.errors, [], `prefix ${n}`);
    // text outside math never contains LaTeX commands; every math node is a complete formula
    const isInMath = (node) => { for (let p = node; p; p = p.parent) if (p.type === 'math') return true; return false; };
    for (const t of env.mirror.findAll((x) => x.type === '#text' && !isInMath(x))) {
      assert.doesNotMatch(t.text, /\\(frac|text|sigma|bar|sum|sqrt)|\$\\|\\\(|\\\[|\$\$/, `prefix ${n}: raw LaTeX "${t.text}"`);
    }
    for (const m of env.mirror.findAll((x) => x.type === 'math')) {
      const latex = env.mirror.text(m);
      assert.ok(finalMath.has(latex), `prefix ${n}: partial formula "${latex}"`);
    }
  }
});

test('lenient JSON keeps LaTeX commands instead of decoding \\f \\t \\b \\n \\r', () => {
  assert.ok(LATEX_COMMANDS.size >= 80);
  const raw = String.raw`{"text":"\frac{1}{n} \text{mean} \theta \times \tau \beta \bar{x} \nu \neq \nabla \rho \right) \left( \lambda \sigma \vec{v} \underline{u} \xi"}`;
  assert.equal(tryParseExpression(raw).value.text, String.raw`\frac{1}{n} \text{mean} \theta \times \tau \beta \bar{x} \nu \neq \nabla \rho \right) \left( \lambda \sigma \vec{v} \underline{u} \xi`);
  // a correctly escaped "\\frac" is the same LaTeX
  assert.equal(tryParseExpression(String.raw`["\\frac{1}{2}", "\\\\"]`).value.join('|'), String.raw`\frac{1}{2}|\\`);
  // genuine escapes still decode
  const v = tryParseExpression(String.raw`{"a":"line\nNext\tTab \"q\" back\\slash \u00e9 \nx \r\n end", "b":"tab\there"}`).value;
  assert.equal(v.a, 'line\nNext\tTab "q" back\\slash é \nx \r\n end');
  assert.equal(v.b, 'tab\there');
  // single-quoted lenient strings get the same treatment
  assert.deepEqual(parseLenientJSON(String.raw`{text: '\frac{a}{b} it\'s \nfine'}`), { text: String.raw`\frac{a}{b} it's ` + '\nfine' });
  // no backslash: strict fast path unchanged
  assert.deepEqual(tryParseExpression('{"a":[1,2]}').value, { a: [1, 2] });
});

test('catalog inline math in a LessonStepper step and a Quiz option', () => {
  const src = String.raw`<LessonStepper title="Mean" steps={[{"label":"Formula","text":"The mean is $\frac{1}{n}\sum x_i$, which costs $5 and $10 to print."},{"label":"Paren","text":"Also \\(\theta^2\\) and **bold**."},{"label":"Display","text":"$$\bar{x} = 3$$"}]}/>`;
  const r = compileWonder(src);
  assert.equal(r.components[0].status, 'valid');
  const env = runProgram(r);
  assert.deepEqual(env.errors, []);
  const stepper = catalogNodes(env.mirror, 'LessonStepper')[0];
  const math = env.mirror.findAll((n) => n.type === 'math', stepper);
  assert.deepEqual(math.map((n) => env.mirror.text(n)), [String.raw`\frac{1}{n}\sum x_i`]);
  assert.match(env.mirror.text(stepper), /which costs \$5 and \$10 to print\./);
  const q = String.raw`<Quiz questions={[{"id":"q1","prompt":"What is $\tau$ when $x = 2$?","question_type":"single_select","options":[{"value":"a","label":"$\frac{1}{2}$"},{"value":"b","label":"$3, $4"}],"correct_values":["a"],"hint":"h","explanation":"e"}]}/>`;
  const qenv = runProgram(compileWonder(q));
  assert.deepEqual(qenv.errors, []);
  const qm = qenv.mirror.findAll((n) => n.type === 'math').map((n) => qenv.mirror.text(n));
  assert.deepEqual(qm, [String.raw`\tau`, 'x = 2', String.raw`\frac{1}{2}`]);
  assert.match(qenv.mirror.text(), /\$3, \$4/);
});

test('every math formula in the demo lessons typesets with KaTeX', () => {
  let count = 0;
  for (const file of DEMO_FILES) {
    const { env } = mathNodes(demo(file), { salt: file });
    for (const m of env.mirror.findAll((n) => n.type === 'math')) {
      const latex = env.mirror.text(m);
      const html = katex.renderToString(latex, { ...KATEX_OPTIONS, throwOnError: true, displayMode: !!m.props.display });
      assert.match(html, /class="katex/);
      count++;
    }
  }
  assert.ok(count >= 4, `found ${count} formulas`);
  const sky = mathNodes(demo('sky-blue.md')).math;
  assert.deepEqual(sky.slice(0, 3), [
    { latex: String.raw`\text{scattering} \propto \frac{1}{\lambda^4}`, display: true },
    { latex: String.raw`\lambda`, display: false },
    { latex: '2^4 = 16', display: false },
  ]);
});

test('Unicode fallback stays readable when KaTeX is unavailable', () => {
  assert.equal(prettyLatex(String.raw`\text{scattering} \propto \frac{1}{\lambda^4}`), 'scattering ∝ 1⁄λ⁴');
  assert.equal(prettyLatex(String.raw`\text{mean} = \frac{x_1 + x_2 + \dots + x_n}{n}`), 'mean = (x₁ + x₂ + … + xₙ)⁄n');
});

let server;
let base;
before(async () => {
  server = createWonderServer({ mode: 'demo', demoDelayMs: 0, logger: { warn() {}, error() {}, log() {} }, memoryFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

test('KaTeX is served read-only from /vendor/katex/; traversal is refused', async () => {
  for (const [p, type] of [['/vendor/katex/katex.min.css', 'text/css'], ['/vendor/katex/katex.min.js', 'text/javascript'], ['/vendor/katex/fonts/KaTeX_Main-Regular.woff2', 'font/woff2']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
    assert.ok((await r.arrayBuffer()).byteLength > 100, p);
  }
  for (const p of ['/vendor/katex/../package.json', '/vendor/katex/%2e%2e/package.json', '/vendor/katex/%2e%2e/%2e%2e/%2e%2e/package.json', '/vendor/katex/README.md', '/vendor/katex/%2e%2e/%2e%2e/%2e%2e/server/claude.js', '/vendor/katex/nope.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    await r.arrayBuffer();
  }
  // the page (Next.js layout) bundles KaTeX's stylesheet; the script still loads from /vendor/katex/
  const layout = fs.readFileSync(new URL('../app/layout.js', import.meta.url), 'utf8');
  assert.match(layout, /import 'katex\/dist\/katex\.min\.css'/);
});
