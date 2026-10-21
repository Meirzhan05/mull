# Compound interest: money that grows on its own growth

Put $1,000 away at 7% a year and leave it for 40 years. If you only ever earned interest on the original $1,000, you'd end up with $3,800. With compounding, the same money at the same rate grows to almost **$15,000**. The only difference is that your interest starts earning interest of its own.

## Simple vs compound

The money you start with is the <KeyTerm term="principal" definition="The original amount you invest or borrow, before any interest."/>. With <KeyTerm term="simple interest" definition="Interest paid only on the original principal, so you earn the same amount every year."/>, you earn interest on that principal and nothing else, so every year looks the same. With <KeyTerm term="compound interest" definition="Interest calculated on the principal plus all the interest already earned, so the yearly amount keeps growing."/>, each year's interest is added to the pile, and next year's interest is calculated on the bigger pile.

<CompareToggle title="Two ways to earn 7%" left={{"label":"Simple interest","points":["Interest is always 7% of the original $1,000","You earn $70 every year, forever","Growth is a straight line"]}} right={{"label":"Compound interest","points":["Interest is 7% of whatever the balance is now","$70 in year one, about $137 by year eleven","Growth curves upward faster and faster"]}}/>

## Watching it snowball

The best way to feel compounding is to work it out by hand once. Let's use round numbers.

<LessonStepper title="Worked example: $1,000 at 10% for 3 years" steps={[{"label":"Year 1","text":"Interest: $1,000 × 10% = **$100**. Balance: **$1,100**."},{"label":"Year 2","text":"Interest is now on $1,100: $1,100 × 10% = **$110**. Balance: **$1,210**."},{"label":"Year 3","text":"$1,210 × 10% = **$121**. Balance: **$1,331**."},{"label":"Compare","text":"Simple interest would give $1,300. Compounding earned an extra **$31**, and that gap widens every single year."}]}/>

All of that collapses into one formula, where P is the principal, r the yearly rate and t the number of years:

<math>A = P\,(1 + r)^{t}</math>

Drag the rate below and watch the two curves split apart. The straight line is simple interest; the curve that bends upward is compounding.

<FunctionGraph title="$1,000 over 40 years" fns={[{"fn":"1000*(1+r)^x","label":"compound"},{"fn":"1000*(1+r*x)","label":"simple"}]} params={[{"name":"r","min":0,"max":0.08,"step":0.01,"value":0.07,"label":"yearly rate (0.07 = 7%)"}]} xRange={[0,40]} yRange={[0,22000]} xLabel="years" yLabel="balance ($)" points={[{"x":10,"y":1967,"label":"10 years at 7%"},{"x":40,"y":14974,"label":"40 years at 7%"}]} caption="At 0% both lines stay flat at $1,000. Every extra point of interest bends the compound curve much more than it tilts the simple line."/>

Check it: $1,000 × 1.10³ = $1,331. Now watch what time does at 7%:

<BarChart title="$1,000 left alone at 7%" unit="$" bars={[{"label":"10 years","value":1967},{"label":"20 years","value":3870},{"label":"30 years","value":7612},{"label":"40 years","value":14974,"highlighted":true,"description":"Each decade roughly doubles the balance, so the last decade adds more than the first three combined."}]}/>

## Time is the secret ingredient

A handy shortcut is the <KeyTerm term="Rule of 72" definition="Divide 72 by the yearly interest rate (in %) to estimate how many years it takes money to double."/>: divide 72 by the interest rate to estimate how many years it takes your money to double.

<InputOutputSlider title="How fast does money double?" inputLabel="Yearly interest rate" outputLabel="Years to double (Rule of 72)" unit="%" stops={[{"value":2,"label":"2%","output":"About 36 years","description":"Exact answer: 35.0 years."},{"value":4,"label":"4%","output":"About 18 years","description":"Exact answer: 17.7 years."},{"value":6,"label":"6%","output":"About 12 years","description":"Exact answer: 11.9 years."},{"value":8,"label":"8%","output":"About 9 years","description":"Exact answer: 9.0 years."},{"value":12,"label":"12%","output":"About 6 years","description":"Exact answer: 6.1 years."}]}/>

Because doubling repeats, starting early matters more than investing more. Meet two savers who both earn 7% a year:

<grid columns={2} gap={3}>
<grid-item>
<box padding={4} radius="xl" background="surface-secondary" gap={1}>
<text size="sm" color="secondary">Ana · saves from 25 to 35, then stops</text>
<title size="xl">$252,000</title>
<text size="sm">at 65, from $24,000 put in</text>
</box>
</grid-item>
<grid-item>
<box padding={4} radius="xl" background="surface-secondary" gap={1}>
<text size="sm" color="secondary">Ben · saves from 35 to 65</text>
<title size="xl">$227,000</title>
<text size="sm">at 65, from $72,000 put in</text>
</box>
</grid-item>
</grid>

Both put in $200 a month while saving. Ana contributes a third as much, yet ends with more, because her money had ten extra years to double.

## Compounding works against you, too

Debt compounds exactly the same way. A credit card at 24% a year typically charges 2% a month, and unpaid interest is added to the balance. Leave $1,000 unpaid for a year and you owe **$1,268**, not $1,240.

<Cycle title="The debt snowball" centerLabel="every month" stages={[{"label":"A balance is left unpaid","description":"Say $1,000 on a card at 2% a month."},{"label":"Interest is added","description":"Month one adds $20."},{"label":"The balance grows","description":"Now interest is charged on $1,020."},{"label":"Next month's interest is bigger","description":"After a year the balance is about $1,268."}]}/>

<Callout title="Pay the expensive debt first" tone="warning">
Paying off a 24% card is like earning a guaranteed 24% return. Few investments come close, so high-interest debt is usually the first thing to clear.
</Callout>

## Check your understanding

<Quiz title="Check your understanding" questions={[{"id":"q1","prompt":"You invest $500 at 10% compounded yearly. How much do you have after 2 years?","question_type":"single_select","options":[{"value":"a","label":"$600"},{"value":"b","label":"$605"},{"value":"c","label":"$610"},{"value":"d","label":"$550"}],"correct_values":["b"],"hint":"Year two earns interest on $550, not $500.","explanation":"Year 1: $500 → $550. Year 2: $550 × 1.10 = $605. Simple interest would give $600."},{"id":"q2","prompt":"Using the Rule of 72, how long does money take to double at 9% a year?","question_type":"single_select","options":[{"value":"a","label":"About 6 years"},{"value":"b","label":"About 8 years"},{"value":"c","label":"About 9 years"},{"value":"d","label":"About 12 years"}],"correct_values":["b"],"hint":"Divide 72 by the rate.","explanation":"72 ÷ 9 = 8 years. (The exact answer is about 8.04 years.)"},{"id":"q3","prompt":"With compound interest, the amount of interest you earn each year stays the same.","question_type":"true_false","options":[{"value":"true","label":"True"},{"value":"false","label":"False"}],"correct_values":["false"],"hint":"Look at the worked example: $100, then $110, then $121.","explanation":"Interest is charged on a growing balance, so each year's interest is larger than the last. Constant yearly interest is simple interest."}]}/>
