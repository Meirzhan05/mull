// Sample lesson in the shipped shape {name, hook, meaning, concepts, keywords, pages:[{heading, content}]}
// (findings §1.5). Pages mix hand-written markers (spread params, quoted values,
// data= JSON) with markers produced by the embed pipeline (embedToMarker +
// insertEmbedAfterParagraph), exactly how generated lessons arrive.

import { embedToMarker, insertEmbedAfterParagraph } from "./embeds.js";

const j = (o) => JSON.stringify(o).replace(/'/g, "\\u0027");

// ---------------------------------------------------------------- page 1

const page1 = `Type “The cat sat on the” into a chatbot and it answers “mat” almost every time. Nobody wrote a rule that says *cats sit on mats*. The model **guessed**, and it guesses one token at a time, millions of times a day.

{{interactive:wondering-lens title="The whole trick in one sentence" body="A language model is a very large function that reads everything written so far and returns a probability for every possible next token."}}

Before we open the box, make a prediction. You already run a tiny version of this model in your head whenever you finish someone's sentence.

{{interactive:lesson-reveal data='${j({
  title: "Predict, then check",
  items: [
    { label: "What does the model output at each step?", content: "Not a word, but a list of scores, one for each of roughly 100,000 tokens in its vocabulary. A word is picked from that list afterwards." },
    { label: "Does it plan the whole sentence first?", content: "No. It produces one token, appends it to the input, and runs again. Long answers are just that loop repeated." },
    { label: "Where does its ‘knowledge’ live?", content: "In billions of learned weights. Nothing is looked up in a database while it predicts." },
  ],
})}'}}`;

// ---------------------------------------------------------------- page 2

let page2 = `Models never see letters or words directly. A **tokenizer** first chops text into pieces it has seen often, then swaps each piece for an id number.

Common words usually become one token. Rare words split into several, which is why models sometimes stumble on spelling or counting letters.

{{interactive:lesson-table data='${j({
  title: "“The cat sat on the” as tokens",
  columns: ["Token", "Id", "Note"],
  rows: [["The", 791, "capitalised form has its own id"], [" cat", 8415, "the leading space is part of the token"], [" sat", 7731, ""], [" on", 389, ""], [" the", 279, "lower-case, different id from “The”"]],
})}'}}

Before any math happens, check you can name what goes in and what comes out.

{{interactive:visual-list data='${j({
  title: "Tokenizer checklist",
  variant: "checklist",
  items: [
    { text: "Input is raw text", status: "done" },
    { text: "Output is a list of integers", checked: true },
    { text: "Same text always gives the same ids", status: "yes" },
    { text: "Ids carry meaning on their own", status: "no" },
  ],
})}'}}

{{interactive:lesson-stepper title="What happens to your prompt before the first layer" data='${j({
  steps: [
    { label: "Normalise", text: "Unicode and whitespace are cleaned up." },
    { label: "Split", description: "Text is cut into the longest pieces found in the vocabulary." },
    { label: "Map", text: "Each piece becomes its integer id, ready for the embedding table." },
  ],
})}'}}`;
page2 = insertEmbedAfterParagraph(
  page2,
  embedToMarker({
    type: "transform",
    title: "What the tokenizer does",
    before: { label: "Text", text: "unbelievably" },
    after: { label: "Tokens", items: ["un", "believ", "ably"] },
    changes: ["each piece mapped to an id: 359, 32924, 2915"],
    transformLabel: "tokenize",
  }),
  1
);

// ---------------------------------------------------------------- page 3

const page3 = `An id like 8415 says nothing about cats. So the first layer looks each id up in a giant table and returns an **embedding**: a list of a few thousand numbers. Similar tokens end up with similar lists.

{{interactive:visual-cards data='${j({
  title: "Two things every token vector carries",
  cards: [
    { category: "WHAT", title: "Token embedding", description: "Learned meaning of the token itself.", points: ["“cat” sits near “dog”", "“mat” sits near “rug”"], tone: "primary" },
    { category: "WHERE", title: "Position signal", description: "Where the token sits in the sequence.", points: ["“dog bites man” differs from “man bites dog”"] },
  ],
})}'}}

{{interactive:visual-venn data='${j({
  title: "“bank” in two sentences",
  leftLabel: "river bank",
  rightLabel: "money bank",
  onlyLeft: ["water", "mud", "fishing"],
  shared: ["same token id", "same starting embedding"],
  onlyRight: ["loan", "account", "interest"],
})}'}}

The starting vector for “bank” is identical in both sentences. Telling them apart is the job of the next step: attention.

{{interactive:concept-map-visualization data='${j({
  title: "Where meaning comes from",
  centerConcept: "Token vector",
  nodes: [
    { id: "emb", label: "Embedding table", level: 1, highlighted: true },
    { id: "pos", label: "Position", level: 1 },
    { id: "att", label: "Attention", level: 1 },
    { id: "ctx", label: "Context words", level: 2 },
    { id: "train", label: "Training data", level: 2 },
  ],
  connections: [
    { from: "emb", to: "center", relationship: "initialises" },
    { from: "pos", to: "center", relationship: "adds order" },
    { from: "att", to: "center", relationship: "mixes in" },
    { from: "ctx", to: "att", relationship: "feeds" },
    { from: "train", to: "emb", relationship: "shapes" },
  ],
})}'}}`;

// ---------------------------------------------------------------- page 4

const page4 = `**Attention** lets every token look back at the earlier tokens and borrow information from the relevant ones. In “The animal didn't cross the street because it was too tired”, the vector for “it” pulls most of its update from “animal”.

{{interactive:lesson-stepper-worked-example data='${j({
  title: "Worked example: who does “it” attend to?",
  context: "One attention head, four earlier tokens. Scores are dot products between the query for “it” and each key.",
  steps: [
    { label: "Score", text: "Dot product of the query with each key.", example: "animal: 4.1   street: 1.2   cross: 0.3   tired: 2.0" },
    { label: "Normalise", text: "Softmax turns scores into weights that sum to 1.", example: "animal: 0.72  tired: 0.09  street: 0.04 …", hints: ["Bigger gaps between scores mean a sharper distribution."] },
    { label: "Blend", text: "The new vector for “it” is the weighted mix of the value vectors.", example: "new_it ≈ 0.72·v_animal + 0.09·v_tired + …" },
  ],
  revealLabel: "Show the numbers",
})}'}}

{{interactive:lesson-compare-toggle data='${j({
  title: "Reading a sentence",
  left: { label: "Older RNNs", points: ["Read one word at a time", "Early words fade by the end", "Hard to run in parallel"] },
  right: { label: "Transformers", points: ["See every earlier token at once", "Any token can attend to any other", "Whole sequence trains in parallel"] },
})}'}}

{{interactive:visual-quadrant data='${j({
  title: "What an attention head might specialise in",
  xAxis: { label: "Distance", low: "nearby", high: "far back" },
  yAxis: { label: "Signal", low: "grammar", high: "meaning" },
  quadrants: [
    { position: "top-left", label: "Local meaning", items: ["adjective → noun"] },
    { position: "top-right", label: "Long-range meaning", items: ["“it” → “animal”"] },
    { position: "bottom-left", label: "Local grammar", items: ["previous token"] },
    { position: "bottom-right", label: "Long-range grammar", items: ["closing a quote"] },
  ],
})}'}}`;

// ---------------------------------------------------------------- page 5

let page5 = `After dozens of attention layers, only the vector of the **last** token is used. It is multiplied against every row of the vocabulary to give one raw score per token, called a **logit**.

A **softmax** turns logits into probabilities: \\(p_i = \\frac{e^{z_i / T}}{\\sum_j e^{z_j / T}}\\), where $T$ is the **temperature**.

Temperature is the one dial you can usually set yourself. Drag it and watch the pick change.

{{interactive:lesson-input-output-slider title="Temperature" inputLabel="Temperature T" outputLabel="Likely continuation" unit="" data='${j({
  stops: [
    { value: 0, label: "0", output: "“mat” every single time", description: "Greedy: always the top token." },
    { value: 0.7, label: "0.7", output: "“mat”, sometimes “floor”", description: "The usual chat setting." },
    { value: 1, label: "1.0", output: "“mat”, “floor”, “couch”…", description: "Samples the raw distribution." },
    { value: 1.5, label: "1.5", output: "“roof”, even “moon”", description: "Flattened, creative, error-prone." },
  ],
})}'}}

{{interactive:visual-stat-bars data='${j({
  title: "Share of probability mass in the top 5 tokens",
  unit: "%",
  items: [
    { label: "T = 0.2", value: 99, max: 100 },
    { label: "T = 0.7", value: 91, note: "most chat apps" },
    { label: "T = 1.0", value: 78 },
    { label: "T = 1.5", value: 54 },
  ],
})}'}}`;
page5 = insertEmbedAfterParagraph(
  page5,
  embedToMarker({
    type: "bar_chart",
    title: "Probabilities after “The cat sat on the” (T = 1)",
    unit: "%",
    xLabel: "Next token",
    yLabel: "Probability",
    bars: [
      { label: "mat", value: 41, highlighted: true, description: "Top choice: “sat on the mat” is everywhere in training text." },
      { label: "floor", value: 22 },
      { label: "couch", value: 17 },
      { label: "windowsill", value: 9 },
      { label: "moon", value: 0.4, description: "Possible, just very unlikely here." },
    ],
  }),
  1
);

// ---------------------------------------------------------------- page 6

let page6 = `Picking a token is not the end. The chosen token is appended to the input and the whole model runs again. That loop is the only thing a chatbot does, and it explains why answers appear word by word.

{{interactive:flowchart-visualization data='${j({
  title: "How a reply gets written",
  nodes: [
    { id: "s", label: "Prompt", type: "start" },
    { id: "f", label: "Run the transformer", type: "process" },
    { id: "p", label: "Softmax + sample a token", type: "process", highlighted: true },
    { id: "d", label: "End token?", type: "decision" },
    { id: "a", label: "Append token to input", type: "process" },
    { id: "e", label: "Reply done", type: "end" },
  ],
  connections: [
    { from: "s", to: "f" },
    { from: "f", to: "p" },
    { from: "p", to: "d" },
    { from: "d", to: "e", label: "yes" },
    { from: "d", to: "a", label: "no" },
    { from: "a", to: "f", label: "repeat" },
  ],
})}'}}

The same loop drives training, with one difference: the model is told the true next token and its weights are nudged toward it.

{{interactive:cycle-visualization data='${j({
  title: "Training loop",
  centerLabel: "billions of times",
  stages: [
    { label: "Predict next token", description: "Run the model on a text snippet." },
    { label: "Compare with truth", description: "Loss = how surprised it was by the real token." , highlighted: true },
    { label: "Nudge the weights", description: "Gradient descent moves every weight a tiny bit." },
    { label: "Next snippet" },
  ],
})}'}}

{{interactive:comparison-visualization data='${j({
  title: "Three ways to pick from the distribution",
  commonFeatures: ["Use the same logits", "Run once per token"],
  items: [
    { label: "Greedy", attributes: { Picks: "top token", Variety: "none", "Good for": "short factual answers" } },
    { label: "Sampling", attributes: { Picks: "random by probability", Variety: "tunable (temperature)", "Good for": "chat, writing" }, details: { "Also called": "top-p / nucleus when truncated" } },
    { label: "Beam search", attributes: { Picks: "best few sequences", Variety: "low", "Good for": "translation" } },
  ],
})}'}}`;
page6 = insertEmbedAfterParagraph(
  page6,
  embedToMarker({
    type: "timeline",
    title: "How we got here",
    events: [
      { date: "2013", label: "word2vec", description: "Embeddings that capture meaning." },
      { date: "2017", label: "Transformer", description: "“Attention Is All You Need”.", highlighted: true },
      { date: "2018", label: "GPT-1 / BERT", description: "Pre-train, then fine-tune." },
      { date: "2020", label: "GPT-3", description: "Scale makes few-shot prompting work." },
      { date: "2022", label: "ChatGPT", description: "Instruction tuning + RLHF on top." },
    ],
  }),
  2
);

// ---------------------------------------------------------------- page 7 (renderer edge cases)

const page7 = `This page is for the renderer, not the learner. It shows how markers that are not renderable behave on a **lesson page** (\`rejectInvalidMarkers\` off) as in the shipped app.

A registered widget that this lab did not rebuild gets a graceful placeholder, here a hand-authored course widget with a bare boolean param:

{{interactive:movie-script-simulator hasButton=true}}

A chart variant from the registry, also a placeholder:

{{interactive:pie-chart-visualization data='{"slices":[{"label":"mat","value":41}]}'}}

An unknown name is warned about once per session and, on lesson pages, left as raw text:

{{interactive:quantum-tokenizer-3000 data='{"a":1}'}}

A widget that throws while rendering is caught by the error boundary:

{{interactive:demo-crash}}

A marker with \`data=\` that is not a JSON object is invalid. Lesson pages still mount the component, which renders nothing for empty data:

{{interactive:lesson-stepper data='[1,2,3]'}}`;

export const SAMPLE_LESSON = {
  name: "How transformers predict the next word",
  hook: "Every chatbot reply is a chain of educated guesses. Here is how one guess gets made.",
  meaning: "Tokens become vectors, attention mixes in context, and a softmax over the vocabulary picks the next token. Repeat.",
  concepts: [
    { name: "Tokenization", description: "Splitting text into known pieces with integer ids." },
    { name: "Attention", description: "Letting each token borrow information from earlier tokens." },
    { name: "Softmax sampling", description: "Turning scores into probabilities and picking one." },
  ],
  keywords: [
    { name: "tokenizer", description: "The component that splits text into tokens and maps them to ids." },
    { name: "token", description: "A chunk of text (word, part of a word, or symbol) the model reads and writes." },
    { name: "embedding", description: "A learned vector of numbers that represents a token." },
    { name: "attention", description: "A mechanism that weights how much each earlier token influences the current one." },
    { name: "logit", description: "A raw, unnormalised score for one vocabulary entry." },
    { name: "softmax", description: "A function that turns scores into probabilities that sum to 1." },
    { name: "temperature", description: "A divisor applied to logits before softmax; higher means more random." },
  ],
  pages: [
    { heading: "The guessing game", content: page1 },
    { heading: "From words to tokens", content: page2 },
    { heading: "Turning tokens into vectors", content: page3 },
    { heading: "Attention: who looks at whom", content: page4 },
    { heading: "Scoring the vocabulary", content: page5 },
    { heading: "The loop that writes", content: page6 },
    { heading: "Renderer edge cases", content: page7 },
  ],
};

export const SAMPLE_PRACTICES = [
  {
    id: "pr-mcq",
    type: "mcq",
    question: "After the final layer, which vector is used to score the next token?",
    options: {
      choices: [
        { id: "a", text: "The average of all token vectors" },
        { id: "b", text: "The vector of the last token", isCorrect: true },
        { id: "c", text: "The vector of the first token" },
        { id: "d", text: "A fresh random vector" },
      ],
    },
    explanation: "Only the last position's vector is multiplied against the vocabulary to give logits.",
  },
  {
    id: "pr-cloze",
    type: "cloze",
    question: "A {{c1::softmax}} turns logits into probabilities, and raising the {{c2::temperature}} makes the distribution flatter.",
    options: {
      clozes: [
        { id: "c1", answer: "softmax", acceptableAnswers: ["soft max", "soft-max"] },
        { id: "c2", answer: "temperature", acceptableAnswers: ["temp", "T"] },
      ],
    },
    explanation: "Softmax normalises scores; temperature divides the logits first.",
  },
  {
    id: "pr-binary",
    type: "binary_choice",
    question: "True or false: the model plans the whole sentence before writing the first token.",
    options: { choices: [{ id: "true", text: "True" }, { id: "false", text: "False", isCorrect: true }] },
    explanation: "It writes one token, appends it, and runs again.",
  },
];
