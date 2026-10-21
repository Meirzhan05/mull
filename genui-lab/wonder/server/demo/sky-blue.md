# Why the sky is blue

Sunlight looks white. Space is black. Yet on a clear day the sky above you glows blue, and at sunset the same sky turns orange and red. Nothing in the air is painted blue, so where does the color come from? The answer is a tiny bias in how air treats different colors of light.

## Sunlight is a mix of colors

White sunlight is every color of the rainbow traveling together. What makes the colors different is their <KeyTerm term="wavelength" definition="The distance between two crests of a light wave. For visible light it is measured in nanometers (nm), billionths of a meter."/>: violet light has the shortest waves, red the longest.

<row gap={2} wrap>
<box padding={3} radius="lg" background="#7B5CD6" gap={0}><text size="xs" weight="semibold" color="#ffffff">Violet · 410 nm</text></box>
<box padding={3} radius="lg" background="#2F7BF5" gap={0}><text size="xs" weight="semibold" color="#ffffff">Blue · 470 nm</text></box>
<box padding={3} radius="lg" background="#2BA84A" gap={0}><text size="xs" weight="semibold" color="#ffffff">Green · 530 nm</text></box>
<box padding={3} radius="lg" background="#F2C230" gap={0}><text size="xs" weight="semibold" color="#2A1E17">Yellow · 580 nm</text></box>
<box padding={3} radius="lg" background="#E0452B" gap={0}><text size="xs" weight="semibold" color="#ffffff">Red · 680 nm</text></box>
</row>

When all of these reach your eye at once, your brain reports "white". Remove some of them and the mix shifts color. That is exactly what the atmosphere does. You can split the mix yourself: a $5 glass prism spreads sunlight into a rainbow just as well as a $40 one.

<Reveal title="Predict, then check" items={[{"label":"If you went above the atmosphere, what color would the daytime sky be?","content":"**Black.** Astronauts see a blazing white sun against a black sky. With no air, there is nothing to send sunlight sideways into your eyes."}]}/>

## Air scatters short waves the most

Air molecules are far smaller than a wavelength of light. When light hits them, a bit of it gets bounced off in a random direction. This is <KeyTerm term="Rayleigh scattering" definition="Scattering of light by particles much smaller than its wavelength. Its strength grows steeply as the wavelength gets shorter."/>, and it is wildly unfair to long waves. Its strength goes with one over the wavelength to the fourth power:

<math>\text{scattering} \propto \frac{1}{\lambda^4}</math>

Here $\lambda$ is the wavelength, so halving it makes scattering $2^4 = 16$ times stronger.

<LessonStepper title="Worked example: blue vs red" steps={[{"label":"Pick two colors","text":"Blue light at **470 nm** and red light at **680 nm**."},{"label":"Take the ratio","text":"680 ÷ 470 ≈ **1.45**. Blue waves are about 1.45 times shorter."},{"label":"Raise it to the 4th power","text":"$1.45^4 = 1.45 \\times 1.45 \\times 1.45 \\times 1.45 \\approx 4.4$, so about **4.4**."},{"label":"Read the result","text":"Blue light is scattered about **4.4 times** more than red. Look anywhere away from the sun and you mostly see that scattered blue."}]}/>

<BarChart title="How strongly each color scatters" unit="× red" bars={[{"label":"Violet","value":7.6,"description":"The most scattered of all, but see the next page."},{"label":"Blue","value":4.4,"highlighted":true,"description":"Scattered about 4.4× more than red: this light fills the sky."},{"label":"Green","value":2.7},{"label":"Yellow","value":1.9},{"label":"Red","value":1,"description":"The baseline: long waves mostly travel straight through."}]}/>

## So why isn't the sky violet?

If violet scatters even more than blue, the sky "should" be violet. Three things tip the balance. Sunlight contains less violet than blue to begin with. Some violet is absorbed high in the atmosphere. And your eyes are much more sensitive to blue than to violet, so the mix of scattered light looks sky blue.

<Callout title="Same idea, different particles" tone="insight">
Clouds are white because water droplets are much **bigger** than light's wavelength. Big particles scatter all colors about equally (<KeyTerm term="Mie scattering" definition="Scattering by particles about as large as, or larger than, the wavelength. It treats all colors roughly equally, so it looks white or gray."/>), so the mix stays white.
</Callout>

<CompareToggle title="Tiny vs large particles" left={{"label":"Air molecules","points":["Much smaller than a light wave","Scatter short (blue) waves far more","Make the sky blue"]}} right={{"label":"Cloud droplets","points":["Larger than a light wave","Scatter every color about equally","Make clouds white or gray"]}}/>

## Sunsets: the long way through the air

At noon, sunlight crosses a fairly thin slice of atmosphere to reach you. Near the horizon, it skims through the air sideways, a path up to about 38 times longer. Along the way almost all the blue gets scattered out of the beam, and what survives the trip is yellow, orange and red.

<InputOutputSlider title="Lower the sun" inputLabel="Sun height above horizon" outputLabel="What you see" unit="°" stops={[{"value":90,"label":"90°","output":"White sun, deep blue sky","description":"Light crosses 1× the atmosphere."},{"value":30,"label":"30°","output":"Still a blue sky","description":"About 2× the air path; a little more blue lost."},{"value":10,"label":"10°","output":"Sun turns yellow-orange","description":"Nearly 6× the air path."},{"value":2,"label":"2°","output":"Orange sun, pink clouds","description":"Around 19× the air path: most blue is gone."},{"value":0,"label":"0°","output":"Deep red sun","description":"Roughly 38× the air path; only the longest waves get through."}]}/>

<Callout title="On Mars it's backwards" tone="example">
Mars has a thin atmosphere full of fine reddish dust. Its daytime sky looks butterscotch, and its sunsets glow **blue**, because that dust scatters blue light forward, toward the setting sun.
</Callout>

## Check your understanding

<Quiz title="Check your understanding" questions={[{"id":"q1","prompt":"Rayleigh scattering is strongest for which light?","question_type":"single_select","options":[{"value":"a","label":"Long wavelengths, like red"},{"value":"b","label":"Short wavelengths, like blue and violet"},{"value":"c","label":"All wavelengths equally"}],"correct_values":["b"],"hint":"Remember the 1 / wavelength⁴ rule.","explanation":"Scattering grows as one over the wavelength to the fourth power, so short blue and violet waves scatter far more than red."},{"id":"q2","prompt":"Why does the setting sun look red?","question_type":"single_select","options":[{"value":"a","label":"The sun cools down in the evening"},{"value":"b","label":"Its light crosses much more air, so most blue is scattered away"},{"value":"c","label":"Clouds absorb the blue light"},{"value":"d","label":"Your eyes get tired of blue"}],"correct_values":["b"],"hint":"Lower the sun on the slider and watch the air path.","explanation":"Near the horizon sunlight travels through up to ~38× more air. Blue is scattered out along the way, leaving reds and oranges."},{"id":"q3","prompt":"Clouds look white because their droplets scatter all visible colors about equally.","question_type":"true_false","options":[{"value":"true","label":"True"},{"value":"false","label":"False"}],"correct_values":["true"],"hint":"Compare tiny air molecules with big droplets.","explanation":"Droplets are larger than light's wavelength, so they scatter every color about equally (Mie scattering) and the mix stays white."}]}/>
