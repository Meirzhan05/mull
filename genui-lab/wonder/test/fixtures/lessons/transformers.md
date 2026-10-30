# How transformers predict the next word

Type "The cat sat on the" into a chatbot and it will almost certainly say "mat". It has no list of cat facts and no grammar rulebook. It does one thing, over and over, astonishingly well: it guesses the next word. By the end of this lesson you will know exactly how that guess is made.

## Words become numbers

A model can't read letters, so the first job is to chop text into <KeyTerm term="tokens" definition="The small pieces of text a model reads: whole words, parts of words, or punctuation."/>. Common words are a single token; rare words get split into pieces, so "unbelievable" might become "un", "believ" and "able".

<row gap={2} wrap>
<badge color="info">The</badge>
<badge color="info">␣cat</badge>
<badge color="info">␣sat</badge>
<badge color="info">␣on</badge>
<badge color="info">␣the</badge>
</row>

Each token is then swapped for an <KeyTerm term="embedding" definition="A long list of numbers that represents a token's meaning. Tokens with similar meanings get similar lists."/>: a list of thousands of numbers. You can think of it as a point on a giant map of meaning, where "cat" sits near "kitten" and far from "carburetor".

<LessonStepper title="From text to numbers" steps={[{"label":"1. Split into tokens","text":"\"The cat sat on the\" becomes five tokens: **The**, **␣cat**, **␣sat**, **␣on**, **␣the**. The leading space is part of the token."},{"label":"2. Look up token IDs","text":"Each token has an ID in the model's vocabulary of roughly 100,000 entries, for example **␣cat → 8415**."},{"label":"3. Swap IDs for embeddings","text":"Each ID is replaced by its embedding: a vector of a few thousand numbers learned during training."},{"label":"4. Add position","text":"The model also mixes in where each token sits, so **dog bites man** and **man bites dog** look different even though they use the same tokens."}]}/>

## Attention: every word looks at every other word

Here is a sentence a rule-based program would trip over: "The trophy didn't fit in the suitcase because **it** was too big." What is "it"? You knew instantly. A transformer figures it out with <KeyTerm term="attention" definition="The step where each token scores how relevant every other token is, then blends in information from the most relevant ones."/>.

For every token, attention asks: which other tokens matter for understanding me right now? It scores them, then blends their information into the token's own numbers. After this step, the numbers for "it" carry a lot of "trophy".

<BarChart title="Where does &quot;it&quot; look?" unit="% of attention" bars={[{"label":"trophy","value":61,"highlighted":true,"description":"Most of the attention goes to the trophy: big things don't fit."},{"label":"suitcase","value":22},{"label":"big","value":9},{"label":"fit","value":5},{"label":"The","value":3}]}/>

<Reveal title="Predict, then check" items={[{"label":"Change one word: \"...because it was too **small**.\" Now what does \"it\" refer to?","content":"**The suitcase.** One word flips the meaning, and attention shifts its weight from \"trophy\" to \"suitcase\". Nobody wrote that rule; the model learned it from billions of sentences."}]}/>

## Layers refine the meaning

One round of attention isn't enough. A transformer stacks dozens of <KeyTerm term="layers" definition="Repeated blocks of attention plus a small neural network. Each layer refines every token's numbers a little more."/>, and each layer has two parts: attention (gather context from other tokens) and a feed-forward network (think about what was gathered). Early layers tend to capture grammar; later layers capture meaning, facts and tone.

<Flowchart title="One pass through the model" nodes={[{"id":"in","label":"Tokens + positions","type":"start"},{"id":"emb","label":"Look up embeddings","type":"process"},{"id":"att","label":"Attention: gather context","type":"process"},{"id":"ff","label":"Feed-forward: process it","type":"process"},{"id":"more","label":"More layers left?","type":"decision"},{"id":"out","label":"Scores for every possible next token","type":"end"}]} connections={[{"from":"in","to":"emb"},{"from":"emb","to":"att"},{"from":"att","to":"ff"},{"from":"ff","to":"more"},{"from":"more","to":"att","label":"Yes, next layer"},{"from":"more","to":"out","label":"No"}]}/>

<Callout title="It's the same recipe, repeated" tone="insight">
Large models don't contain special modules for grammar or facts. They repeat the same attention + feed-forward block 30 to 100+ times, and the specialization emerges during training.
</Callout>

## Picking the next word

After the last layer, the model gives a score to every token in its vocabulary. A function called softmax turns those scores into probabilities that add up to 100%. For "The cat sat on the", it might look like this:

<BarChart title="Next token after &quot;The cat sat on the&quot;" unit="%" bars={[{label: "mat", value: 41, highlighted: true}, {label: "floor", value: 18}, {label: "couch", value: 12}, {label: "bed", value: 9}, {label: "roof", value: 4},]}/>

The model then samples one token. A setting called <KeyTerm term="temperature" definition="A dial that sharpens or flattens the probabilities before sampling. Low = predictable, high = surprising."/> controls how adventurous that pick is.

<InputOutputSlider title="Turn the temperature dial" inputLabel="Temperature" outputLabel="What you get" stops={[{"value":0,"label":"0","output":"\"mat\" every single time","description":"Always picks the top token. Predictable, sometimes repetitive."},{"value":0.7,"label":"0.7","output":"Usually \"mat\", sometimes \"floor\"","description":"A common default: sensible but not robotic."},{"value":1,"label":"1.0","output":"Varied picks across the list","description":"Samples exactly from the model's probabilities."},{"value":1.5,"label":"1.5","output":"Surprises like \"moon\"","description":"Flattened probabilities: creative, and more likely to go off the rails."}]}/>

Then the chosen token is glued onto the text and the whole process runs again. A 500-word answer is simply this loop running hundreds of times.

<Cycle title="The generation loop" centerLabel="one token per turn" stages={[{"label":"Read the text so far","description":"Your prompt plus everything generated so far."},{"label":"Score every token","description":"Layers of attention and feed-forward produce a score for each vocabulary entry."},{"label":"Pick one","description":"Softmax turns scores into probabilities; temperature shapes the sample."},{"label":"Append and repeat","description":"The new token becomes part of the input for the next turn."}]}/>

<ExplainBack prompt="In your own words, how does a transformer decide what word comes next?" concept="Next-token prediction" rubric={["Mentions turning words into numbers (tokens or embeddings)", "Explains that attention lets each word use context from the other words", "Says it outputs probabilities for the next token and picks one"]} sampleAnswer="The text is split into tokens and turned into lists of numbers. Layers of attention let every token look at the others to build up the meaning in context. At the end the model gives a probability to every possible next token, picks one, adds it to the text and repeats."/>

## Check your understanding

<Quiz title="Check your understanding" questions={[{"id":"q1","prompt":"What does a transformer actually produce at each step?","question_type":"single_select","options":[{"value":"a","label":"The whole answer at once"},{"value":"b","label":"A probability for every possible next token"},{"value":"c","label":"A word chosen from a rule list"},{"value":"d","label":"A summary of the prompt"}],"correct_values":["b"],"hint":"Think about the bar chart for \"The cat sat on the\".","explanation":"Each step ends with a probability for every token in the vocabulary; one is sampled, appended, and the loop runs again.","concept":"Next-token prediction"},{"id":"q2","prompt":"In \"The trophy didn't fit in the suitcase because it was too big\", what lets the model link \"it\" to \"trophy\"?","question_type":"single_select","options":[{"value":"a","label":"Tokenization"},{"value":"b","label":"Attention"},{"value":"c","label":"Temperature"}],"correct_values":["b"],"hint":"Which step lets a token look at the other tokens?","explanation":"Attention lets \"it\" score every other token and pull in information from the most relevant one, \"trophy\".","concept":"Attention"},{"id":"q3","prompt":"Raising the temperature makes the model's word choices more predictable.","question_type":"true_false","options":[{"value":"true","label":"True"},{"value":"false","label":"False"}],"correct_values":["false"],"hint":"Remember what happened at 1.5 on the dial.","explanation":"Higher temperature flattens the probabilities, so less likely tokens get picked more often. Low temperature is the predictable setting.","concept":"Temperature"}]}/>
