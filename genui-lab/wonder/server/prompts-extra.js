// Prompt fragments for Phases 3-5, spliced into server/prompts.js. Static strings only, so the
// cached system prefix stays byte-identical across requests.

/** Catalog line for the DIL vocabulary (lessons and tutor). */
export const FUNCTION_GRAPH_VOCAB = `- <FunctionGraph title="..." fn="a*sin(b*x)" params={[{"name":"a","min":0,"max":3,"step":0.1,"value":1,"label":"amplitude"}]} xRange={[-6.28,6.28]} yRange={[-3,3]} caption="..." points={[{"x":0,"y":0,"label":"origin"}]}/>: an interactive graph of y = f(x) with sliders for its parameters. fn uses x, the declared params, numbers, + - * / ^, parentheses and sin cos tan asin acos atan sinh cosh tanh exp ln log log10 log2 sqrt cbrt abs floor ceil round sign min max pow, plus the constants pi and e. Write multiplication explicitly (2*x) and never "y =". 0-4 params (short names like a, b, k, r; not x, e or pi), each with min < max, a step and a starting value. Up to 6 labeled points. For 2-3 related curves use fns={[{"fn":"sin(x)","label":"sin"},{"fn":"cos(x)","label":"cos"}]} instead of fn. Pick xRange and yRange so the interesting part fills the plot at every slider value.`;

/** Lesson-format addition: when to use a graph. */
export const FUNCTION_GRAPH_LESSON_RULE = `- For math, physics, economics or any lesson built on a formula y = f(x), include exactly one FunctionGraph on the page that introduces the formula, with sliders for the quantities the learner should play with (amplitude, rate, growth, slope...). Say in the prose what to try ("drag r up and watch the curve bend").`;

/** Grounding rules (lessons; the tutor gets them only when search is enabled). */
export const GROUNDING_GUIDANCE = `
# Sources and current facts
- You may have a web search tool. When it is available and the topic is about the real world (missions, technology, health, the economy, organizations, people, records, anything with numbers or recent developments), search before writing (1-3 focused searches) to verify key figures and pick up recent developments, so the learner gets checkable sources. Skip searching only for timeless material such as pure math, logic or grammar.
- Cite naturally: state facts from search results in your own words in normal prose; the citation is attached automatically. Prefer reputable primary sources (agencies, universities, journals, official sites).
- Never write citation markup yourself: no <Cite>, no [1], no footnotes, no URLs and no source list. The app adds numbered source pills and a source list.
- Put searched facts in prose sentences, not inside component props, so their sources can be shown.
- Never mention that you searched; just teach.
`.trim();
