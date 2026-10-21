// Demo inputs for the playground and the LearningQuiz tab. The quiz state uses the field
// names observed in LearningQuiz.generated (findings §3.5); content is written for this demo.

export const PLAYGROUND_SAMPLE = `## Weekend trip checklist

Here's a quick summary card. Edit this text and the preview recompiles on every keystroke.

<box border radius="xl" padding={4} gap={3}>
  <row align="center" gap={3}>
    <icon name="map-pin" color="danger" size="xl"/>
    <box flex="1" gap={0}>
      <title size="lg">Kyoto, Japan</title>
      <text color="secondary" size="sm">Sat 24 – Sun 25 · 2 nights</text>
    </box>
    <badge color="success">Booked</badge>
  </row>
  <divider color="subtle"/>
  <grid columns={3} gap={2}>
    <grid-item>
      <text color="secondary" size="xs">Budget</text>
      <title size="md">¥48,000</title>
    </grid-item>
    <grid-item>
      <text color="secondary" size="xs">Weather</text>
      <row gap={1}><icon name="cloud-sun" color="#D6A54A" size="md"/><title size="md">21°C</title></row>
    </grid-item>
    <grid-item>
      <text color="secondary" size="xs">Steps / day</text>
      <title size="md">~14k</title>
    </grid-item>
  </grid>
  <box background="surface-tertiary" height="6px" radius="full">
    <box background="#10a37f" height="6px" radius="full" width="70%"/>
  </box>
  <text size="sm">Packing is **70% done** — still need an *umbrella* and a \`JR pass\`.</text>
</box>

- Book the Fushimi Inari early-morning slot
- Reserve dinner in Pontochō
- Charge the camera batteries

Unknown catalog components degrade gracefully: <WeatherWidget location="Kyoto"/> renders nothing because it is not loaded, exactly like \`__dilSafe\` in the server output.`;

export const QUIZ_RESOLUTION_ID = 'demo-quiz-0001';

export const QUIZ_MARKUP = `## Quick check: the Pythagorean theorem

<LearningQuiz topic="pythagorean theorem" questions={3}/>`;

export const QUIZ_STATE = {
  title: 'Pythagorean theorem',
  attempt: 0,
  revision: 0,
  phase: 'quiz',
  current_index: 0,
  answers: [],
  selected_values: [],
  feedback_status: '',
  hint_open: false,
  generation_complete: true,
  share_button_variant: 'none',
  copy_quiz_text: '',
  question_progress_labels: ['1 of 3', '2 of 3', '3 of 3'],
  correct_count_labels: { 0: '0 of 3 correct', 1: '1 of 3 correct', 2: '2 of 3 correct', 3: '3 of 3 correct · nice work!' },
  submit_answer_label: 'Check answer',
  next_question_label: 'Next',
  see_results_label: 'See results',
  hint_label: 'Hint',
  restart_label: 'Try again',
  next_quiz_label: 'Next quiz',
  next_quiz_query: 'Give me a harder quiz on the Pythagorean theorem',
  questions: [
    {
      id: 'q1',
      prompt: 'A right triangle has legs of length **3** and **4**. How long is the hypotenuse?',
      question_type: 'single_select',
      options: [
        { value: 'A', label: '`5`', feedback: '3² + 4² = 9 + 16 = 25, and √25 = 5.' },
        { value: 'B', label: '`6`', feedback: '6² = 36, which is more than 3² + 4² = 25.' },
        { value: 'C', label: '`7`', feedback: '7 is just 3 + 4. Side lengths don’t add like that.' },
        { value: 'D', label: '`12`', feedback: '12 is 3 × 4. The theorem uses squares, not products.' },
      ],
      correct_values: ['A'],
      hint: 'Square both legs, add them, then take the square root.',
    },
    {
      id: 'q2',
      prompt: 'In $a^2 + b^2 = c^2$, which side is $c$?',
      question_type: 'single_select',
      options: [
        { value: 'A', label: 'The shortest side', feedback: 'The shortest side is one of the legs.' },
        { value: 'B', label: 'Either leg', feedback: 'The legs are a and b.' },
        { value: 'C', label: 'The side opposite the right angle', feedback: 'Right: c is the hypotenuse, opposite the 90° angle.' },
        { value: 'D', label: 'Any side you choose', feedback: 'The equation only holds when c is the hypotenuse.' },
      ],
      correct_values: ['C'],
      hint: 'It is always the longest side of a right triangle.',
    },
    {
      id: 'q3',
      prompt: 'A triangle has sides 5, 12 and 13. Is it a right triangle?',
      question_type: 'true_false',
      options: [
        { value: 'true', label: 'True', feedback: '5² + 12² = 25 + 144 = 169 = 13², so yes.' },
        { value: 'false', label: 'False', feedback: 'Check it: 25 + 144 = 169, which equals 13².' },
      ],
      correct_values: ['true'],
      hint: 'Test whether 5² + 12² equals 13².',
    },
  ],
};

export const QUIZ_APP_DATA = {
  opGenui: {
    componentResults: { [QUIZ_RESOLUTION_ID]: { status: 'resolved', state: QUIZ_STATE, componentName: 'LearningQuiz' } },
    modelDataBindings: {},
    interactionSurface: 'mainline',
    nativeServerActions: { ready: false }, // logged-out: answers stay local (findings §3.6)
  },
};
