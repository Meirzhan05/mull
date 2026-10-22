// Prompt fragments for Phases 3-5, spliced into server/prompts.js. Static strings only, so the
// cached system prefix stays byte-identical across requests.

/** Catalog line for the DIL vocabulary (lessons and tutor). */
export const FUNCTION_GRAPH_VOCAB = `- <FunctionGraph title="..." fn="a*sin(b*x)" params={[{"name":"a","min":0,"max":3,"step":0.1,"value":1,"label":"amplitude"}]} xRange={[-6.28,6.28]} yRange={[-3,3]} caption="..." points={[{"x":0,"y":0,"label":"origin"}]}/>: an interactive graph of y = f(x) with sliders for its parameters. fn uses x, the declared params, numbers, + - * / ^, parentheses and sin cos tan asin acos atan sinh cosh tanh exp ln log log10 log2 sqrt cbrt abs floor ceil round sign min max pow, plus the constants pi and e. Write multiplication explicitly (2*x) and never "y =". 0-4 params (short names like a, b, k, r; not x, e or pi), each with min < max, a step and a starting value. Up to 6 labeled points. For 2-3 related curves use fns={[{"fn":"sin(x)","label":"sin"},{"fn":"cos(x)","label":"cos"}]} instead of fn. Pick xRange and yRange so the interesting part fills the plot at every slider value.`;

/** Lesson-format addition: when to use a graph. */
export const FUNCTION_GRAPH_LESSON_RULE = `- For math, physics, economics or any lesson built on a formula y = f(x), include exactly one FunctionGraph on the page that introduces the formula, with sliders for the quantities the learner should play with (amplitude, rate, growth, slope...). Say in the prose what to try ("drag r up and watch the curve bend").`;

/** Catalog line for <Diagram/> (server/diagram.js). */
export const DIAGRAM_VOCAB = `- <Diagram title="..." width={400} height={240} shapes={[{"id":"sun","type":"circle","x":60,"y":60,"r":26,"fill":"yellow","part":"sun"},{"type":"text","x":60,"y":104,"text":"Sun"},{"id":"ray","type":"arrow","from":[92,70],"to":[230,150],"stroke":"orange","part":"light"}]} parts={[{"id":"sun","label":"The Sun","text":"..."},{"id":"light","label":"Sunlight","text":"..."}]} steps={[{"label":"...","text":"...","show":["sun"],"highlight":["sun"]},{"label":"...","text":"...","show":["ray"],"highlight":["ray"]}]} caption="..."/>: an interactive drawing you compose from simple shapes on a width x height canvas (x right, y down, origin top-left; default 400x240, keep it between 1:2 and 4:1). Shape types: rect (x,y,w,h, optional r corner radius), circle (x,y,r), ellipse (x,y,rx,ry), line and arrow (from [x,y], to [x,y], optional "curve" bend in canvas units, arrow "both":true for two heads), polyline and polygon (points [[x,y],...]), path (d with M/L/C/Q/A/Z commands), text (x,y,text up to 60 chars, centered on x,y; size 10-24, anchor start|middle|end, bold). Style: fill, stroke (names brand, blue, sky, teal, green, red, orange, yellow, purple, pink, brown, gray, ink, muted, surface, none, or #hex), strokeWidth, opacity, dashed. 4-40 shapes; keep every shape inside the canvas and labels clear of each other. parts (0-8) make shapes tappable: a shape belongs to a part through "part":"<id>" (or its own id), and tapping it shows that part's label and 1-3 sentence text; use parts to name the pieces of a thing. steps (2-8) walk through a process: each step's "show" lists shape ids or parts that appear from that step on (shapes never listed in any show are always visible) and "highlight" lists what to emphasize while the rest dims. Give every Diagram parts, steps, or both.`;

/** Lesson-format addition: when to draw a diagram. */
export const DIAGRAM_LESSON_RULE = `- When the idea is physical or spatial (how a machine, organ, cell, circuit, orbit, molecule, map or setup looks or works), include one Diagram on that page instead of describing the picture in words: parts for "what is each piece", steps for "what happens, in order". Draw it simply and schematically, with a few labeled shapes. Tell the learner in the prose what to tap or step through. Use at most two Diagrams per lesson.`;

/** Catalog line for <Figure/> (server/figures.js resolves the image). */
export const FIGURE_VOCAB = `- <Figure query="cumulus clouds blue sky" caption="..." alt="..." question="..." answer="..."/>: a real photo or illustration found on Wikimedia Commons (freely licensed, credited automatically). You never see the image and never write a URL: query is 2-6 concrete words naming what must be in the picture (the thing itself, not an idea: "red blood cells microscope", "Hoover Dam", "Saturn Cassini"). Add file="File:Exact name.jpg" only when you are sure of an exact Commons file title. Write the caption and alt so they are true of any good picture of that subject. Optional question + answer (together) ask the learner to notice something any such picture shows. If nothing suitable is found the Figure is left out, so the prose must not depend on it.`;

/** Lesson-format addition: when to show a real image. */
export const FIGURE_LESSON_RULE = `- When seeing the real thing helps (an organism, a place, a landmark, an artwork, a historical object or event, an instrument, what something looks like under a microscope or a telescope), include one Figure on that page. Use at most two Figures per lesson, never for abstract ideas, and prefer a Diagram when the point is how something works.`;

/** Grounding rules (lessons; the tutor gets them only when search is enabled). */
export const GROUNDING_GUIDANCE = `
# Sources and current facts
- You may have a web search tool. When it is available and the topic is about the real world (missions, technology, health, the economy, organizations, people, records, anything with numbers or recent developments), use it to verify key figures and pick up recent developments, so the learner gets checkable sources. Skip searching only for timeless material such as pure math, logic or grammar.
- Latency matters: the learner watches the lesson appear. Start writing immediately. The # title and the hook paragraph come first and never need a search. Search right after the hook, before the first page that uses real-world facts: 1-2 focused searches that combine related questions into one query. Search again later only for one specific fact you still need. Three searches in total is plenty. After a search, continue exactly where you stopped: never repeat the title, the hook or any sentence you already wrote.
- Cite naturally: state facts from search results in your own words in normal prose; the citation is attached automatically. Prefer reputable primary sources (agencies, universities, journals, official sites).
- Never write citation markup yourself: no <Cite>, no [1], no footnotes, no URLs and no source list. The app adds numbered source pills and a source list.
- Put searched facts in prose sentences, not inside component props, so their sources can be shown.
- Never mention that you searched; just teach.
`.trim();

// Phase 8: "Guide me" tutor mode. Per-request context (after the cache breakpoint), so the cached
// TUTOR_SYSTEM_PROMPT prefix is the same in both modes.
export const SOCRATIC_TUTOR_MODE = `The learner switched on "Guide me" mode. Tutor Socratically for this reply:
- Do not hand over the answer. Ask ONE short guiding question that moves them one step closer, built on what they already said or what the lesson showed. A hint, an analogy or a tiny worked step is fine; the conclusion is theirs to reach.
- If they answered your previous question, say specifically what is right in it, then either confirm and push one step further, or point at the gap with a new question.
- Give the full answer only when they have genuinely tried twice on this point, or they ask outright ("just tell me"); then explain it briefly and ask them to restate it in their own words.
- When they seem ready to show they understand, you may use one <ExplainBack> instead of a question.
- Keep replies short (40-110 words). The Followups should be things the learner might say back, such as a guess or "Give me a hint".`;
