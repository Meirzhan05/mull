// Demo-mode Teacher: a scripted stand-in for Claude that speaks the Messages streaming event
// protocol (message_start, content_block_start/delta/stop for text and tool_use with
// input_json_delta, message_delta, finalMessage). The real tool loop in teacher.js drives it,
// so demo turns exercise the same validation, execution, card splicing and NDJSON path.

import { chunkText, pickDemoLesson } from './demo.js';
import { componentsOf } from './practice.js';

const clean = (s, max = 80) => String(s ?? '').replace(/[<>{}"\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function topicOf(message) {
  const m = /(?:learn(?:ing)?|study(?:ing)?|understand(?:ing)?|get (?:good|better) at|master(?:ing)?|about|teach me|explain)\s+(.+?)(?=\s+(?:in|within|by|before|over|for)\s+(?:a|an|one|two|three|\d+|the|this|next)\b|[.?!,;]|\s+and\s+i\b|$)/i.exec(String(message || ''));
  const t = clean(m?.[1] || '', 60).replace(/^(the|some|more)\s+/i, '');
  return t || '';
}

function backgroundOf(message) {
  const m = /\bi (?:already )?(?:know|studied|took|can do)\s+([^.,;!?]+)/i.exec(String(message || ''));
  return m ? `Already knows ${clean(m[1], 100)}.` : '';
}

const followups = (items) => `\n\n<Followups items={${JSON.stringify(items)}}/>\n`;

function lastLearnerMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return { index: i, text: m.content };
  }
  return { index: -1, text: '' };
}

/** Tool results returned so far in this turn, by tool name (parsed JSON when possible). */
function resultsSoFar(messages, from) {
  const byId = {};
  const out = {};
  for (const m of messages.slice(from + 1)) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') byId[b.id] = b.name;
      if (b.type === 'tool_result') {
        let v = b.content;
        try { v = JSON.parse(b.content); } catch {}
        out[byId[b.tool_use_id] || 'unknown'] = v;
      }
    }
  }
  return out;
}

function planFor(topic) {
  const T = topic;
  return {
    goal: `Get good at ${T} in a week`,
    deadline: '',
    days: [
      { day: 1, focus: 'The big picture', items: [{ kind: 'lesson', title: `What ${T} is really about`, topic: `${T}: the big picture` }] },
      { day: 2, focus: 'Core ideas', items: [{ kind: 'lesson', title: `The core ideas of ${T}`, topic: `core ideas of ${T}` }, { kind: 'review', title: 'Review yesterday\'s cards' }] },
      { day: 3, focus: 'Check yourself', items: [{ kind: 'quiz', title: `Quick check: ${T} basics`, topic: `${T} basics` }, { kind: 'lesson', title: `${cap(T)} in practice`, topic: `${T} worked examples` }] },
      { day: 4, focus: 'Common traps', items: [{ kind: 'lesson', title: `Common mistakes in ${T}`, topic: `common misconceptions in ${T}` }, { kind: 'review', title: 'Review due cards' }] },
      { day: 5, focus: 'Put it together', items: [{ kind: 'quiz', title: 'Final check', topic: T }, { kind: 'review', title: 'Review everything due' }] },
    ],
  };
}

function quizQuestions(progress, topic) {
  const recent = progress?.recentLessons?.[0]?.title || topic;
  const pick = pickDemoLesson(recent || 'learning');
  const fromLesson = componentsOf(pick.markdown, 'Quiz')[0]?.questions || [];
  const qs = fromLesson.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, prompt: q.prompt, question_type: q.question_type === 'true_false' ? 'true_false' : 'single_select', options: q.options, correct_values: q.correct_values, hint: q.hint || 'Think back to the lesson.', explanation: q.explanation || '', concept: q.concept || pick.title }));
  return { topic: pick.title, questions: qs };
}

/** Steps for this learner message; step k is emitted on the k-th model call of the turn. */
function script(text, ctx) {
  const t = text.toLowerCase();
  const topic = topicOf(text) || 'the topic you picked';
  if (text.startsWith('[Wonder: the learner just opened the Teacher')) { // Phase 10 check-in
    return [
      { text: '', tools: [{ name: 'get_progress', input: {} }] },
      () => {
        const p = ctx.results.get_progress || {};
        const due = p.deck?.due || 0;
        const fading = p.outcomes?.fading?.[0];
        const plan = p.plans?.[0];
        const hi = p.streak ? `Welcome back: day ${p.streak + 1} of your streak is one review away.` : 'Welcome back.';
        if (fading && fading.recall != null && fading.recall < 65) {
          const slip = fading.hardCards?.[0] ? ` The card that keeps slipping: *${fading.hardCards[0]}*` : '';
          return { text: `${hi} One thing stands out: you recalled only **${fading.recall}%** of “${fading.title}” when its cards came back.${slip} Rereading won't fix that; a fresh angle will.`, tools: [{ name: 'create_lesson', input: { topic: fading.title, level: 'beginner', reason: 'Relearn it from a different angle, then your next reviews will tell us if it stuck.' } }] };
        }
        if (due) return { text: `${hi} You have **${due} card${due === 1 ? '' : 's'} due**. Start there: reviewing right as recall dips is the cheapest way to keep it.${followups(['Start my review', 'What is fading?', 'Make me a study plan'])}` };
        if (plan && plan.opened < plan.total) return { text: `${hi} Your plan for “${plan.goal}” is ${plan.opened} of ${plan.total} done. Today's item is waiting on your home screen.${followups(['What should I study today?', 'Quiz me'])}` };
        return { text: `${hi} Nothing is due, so it's a good day for something new.`, tools: [{ name: 'create_lesson', input: { topic: 'How memory works: the forgetting curve', level: 'beginner', reason: 'Five minutes on why your reviews are scheduled the way they are.' } }] };
      },
      { text: followups(['Make me a study plan', 'What is fading?', 'Quiz me']) },
    ];
  }
  if (/\b(forget|delete that|remove that)\b/.test(t)) {
    const id = ctx.memoryIds[0];
    return [
      id ? { text: 'Sure, I\'ll drop that.', tools: [{ name: 'forget', input: { id } }] } : { text: 'There\'s nothing in your memory yet, so there\'s nothing to forget.' + followups(['Make me a study plan', 'Quiz me']) },
      { text: 'Done. I won\'t use it from now on.' + followups(['What do you know about me?', 'Make me a study plan']) },
    ];
  }
  if (/\b(quiz|test me|check my|check me)\b/.test(t)) {
    return [
      { text: 'Let\'s see what stuck. One moment while I look at what you studied.', tools: [{ name: 'get_progress', input: {} }] },
      () => {
        const q = quizQuestions(ctx.results.get_progress, topic);
        return { text: `Here are ${q.questions.length} questions on **${q.topic}**. Use the hint before you guess.`, tools: [{ name: 'quiz_me', input: q }] };
      },
      { text: 'Answer in the card; if one trips you up, tap **Explain this** and we\'ll untangle it together.' + followups(['Make me a study plan', 'What should I review today?']) },
    ];
  }
  if (/\b(plan|schedule|week|days|get (good|better) at|exam|prepare)\b/.test(t)) {
    const bg = backgroundOf(text);
    const facts = [{ name: 'remember', input: { fact: `Wants to get good at ${topic} within a week.`, kind: 'goal' } }];
    if (bg) facts.push({ name: 'remember', input: { fact: bg, kind: 'background' } });
    return [
      { text: `Love this goal. A week is enough to build a real foundation in ${topic} if each day stays small. Let me note your goal and check where you are.`, tools: [...facts, { name: 'get_progress', input: {} }] },
      () => {
        const p = ctx.results.get_progress || {};
        const due = p.deck?.due || 0;
        const lead = due ? `You have ${due} card${due === 1 ? '' : 's'} due, so I folded short reviews into the week.` : 'Your review deck is clear, so we can start fresh.';
        const plan = planFor(topic);
        return { text: `${lead} Here's a five-day plan:`, tools: [{ name: 'plan_study', input: plan }, { name: 'create_lesson', input: { topic: plan.days[0].items[0].topic, level: 'beginner', reason: `Day 1 of your plan: the big picture of ${topic}, in about five minutes.` } }] };
      },
      { text: 'Tap **Start** when you\'re ready for day 1. Save the plan to keep it on your home screen.' + followups(['Quiz me after the lesson', 'Make the plan shorter', 'What should I review today?']) },
    ];
  }
  if (/\b(progress|how am i doing|what should i|review today|today)\b/.test(t)) {
    return [
      { text: 'Let me look at your week.', tools: [{ name: 'get_progress', input: {} }] },
      () => {
        const p = ctx.results.get_progress || {};
        const due = p.deck?.due || 0;
        const lessons = (p.recentLessons || []).length;
        const body = `You're on a **${p.streak || 0}-day streak**, ${lessons} recent lesson${lessons === 1 ? '' : 's'} and **${due} card${due === 1 ? '' : 's'} due**.`;
        if (due) return { text: `${body} Reviews first: ten minutes now saves you an hour of relearning later.${followups(['Start my review', 'Quiz me', 'Make me a study plan'])}` };
        const next = p.recentLessons?.[0]?.title;
        return { text: `${body} Nothing is due, so let's learn something new.`, tools: [{ name: 'create_lesson', input: { topic: next ? `next steps after ${next}` : 'How memory works: the forgetting curve', level: 'beginner', reason: 'A short lesson that builds on what you have already done.' } }] };
      },
      { text: 'Start it whenever you like.' + followups(['Make me a study plan', 'Quiz me']) },
    ];
  }
  if (/\b(i am|i'm|i know|i like|i prefer|my goal|i want)\b/.test(t)) {
    const bg = backgroundOf(text);
    const fact = bg || `${cap(clean(text, 180).replace(/^i\s+/i, 'Says they '))}${/[.!?]$/.test(text.trim()) ? '' : '.'}`;
    return [
      { text: 'Good to know.', tools: [{ name: 'remember', input: { fact, kind: bg ? 'background' : /\b(like|prefer)\b/.test(t) ? 'preference' : 'goal' } }] },
      { text: 'I\'ll keep that in mind for your lessons and plans.' + followups(['Make me a study plan', 'Suggest a lesson']) },
    ];
  }
  const lessonTopic = topicOf(text) || clean(text, 60) || 'How memory works';
  return [
    { text: `Great question to dig into. A short lesson is the fastest way in.`, tools: [{ name: 'create_lesson', input: { topic: lessonTopic, level: 'beginner', reason: `A five-minute, interactive introduction to ${lessonTopic}.` } }] },
    { text: 'Tap **Start** and I\'ll be here if you want a plan around it afterwards.' + followups(['Make me a study plan', 'Quiz me on it later']) },
  ];
}

function abortError() {
  const e = new Error('Request was aborted.');
  e.name = 'AbortError';
  return e;
}

/** Fake Anthropic client for demo mode: only `beta.messages.stream` is implemented. */
export function createDemoTeacherClient({ delayMs = 22 } = {}) {
  let toolSeq = 0;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  return {
    demo: true,
    beta: {
      messages: {
        stream(params, opts = {}) {
          const messages = params.messages || [];
          const learner = lastLearnerMessage(messages);
          const step = messages.slice(learner.index + 1).filter((m) => m.role === 'assistant').length;
          const ctxText = (params.system || []).slice(1).map((b) => b.text).join('\n');
          const ctx = { results: resultsSoFar(messages, learner.index), memoryIds: [...ctxText.matchAll(/\((mem-[\w-]+)\)/g)].map((m) => m[1]) };
          const steps = script(learner.text, ctx);
          let s = steps[Math.min(step, steps.length - 1)];
          if (typeof s === 'function') s = s();
          const tools = s.tools || [];
          const content = [];
          if (s.text) content.push({ type: 'text', text: s.text });
          for (const tl of tools) content.push({ type: 'tool_use', id: `toolu_demo_${++toolSeq}`, name: tl.name, input: tl.input });
          const stop = tools.length ? 'tool_use' : 'end_turn';
          const signal = opts.signal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { id: `msg_demo_${toolSeq}`, content: [] } };
              let index = 0;
              for (const block of content) {
                if (signal?.aborted) throw abortError();
                if (block.type === 'text') {
                  yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
                  for (const piece of chunkText(block.text, { seed: block.text.length + step })) {
                    if (signal?.aborted) throw abortError();
                    yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } };
                    await sleep(delayMs);
                  }
                } else {
                  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } };
                  for (const piece of chunkText(JSON.stringify(block.input), { seed: 3, min: 40, max: 90 })) {
                    yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } };
                  }
                  await sleep(delayMs * 4);
                }
                yield { type: 'content_block_stop', index };
                index++;
              }
              yield { type: 'message_delta', delta: { stop_reason: stop } };
              yield { type: 'message_stop' };
            },
            async finalMessage() { return { id: 'msg_demo', role: 'assistant', stop_reason: stop, content }; },
          };
        },
      },
    },
  };
}
