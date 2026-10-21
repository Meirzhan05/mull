// Demo mode for Phase 3: deterministic citations so Cite pills and the Sources list can be
// exercised offline. Each anchor is an exact phrase of the demo lesson; the Cite tag goes
// right after it, the way the live path places a cite after the cited text span. The snippets
// are short paraphrases written for the demo (not quotes from the pages).

import { citeTag } from './grounding.js';

export const DEMO_CITATIONS = Object.freeze({
  'sky-blue': [
    { after: 'and it is wildly unfair to long waves', url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering', title: 'Rayleigh scattering - Wikipedia', cited_text: 'Rayleigh scattering intensity is inversely proportional to the fourth power of the wavelength, so blue light scatters far more than red.' },
    { after: 'your eyes are much more sensitive to blue than to violet', url: 'https://spaceplace.nasa.gov/blue-sky/en/', title: 'Why Is the Sky Blue? | NASA Space Place', cited_text: 'Blue light is scattered in all directions by the gases and particles in the air, which is why we see a blue sky most of the time.' },
    { after: 'a path up to about 38 times longer', url: 'https://en.wikipedia.org/wiki/Air_mass_(astronomy)', title: 'Air mass (astronomy) - Wikipedia', cited_text: 'At the horizon the relative air mass reaches roughly 38, compared with 1 when the sun is directly overhead.' },
    { after: 'its sunsets glow **blue**', url: 'https://en.wikipedia.org/wiki/Atmosphere_of_Mars', title: 'Atmosphere of Mars - Wikipedia', cited_text: 'Fine dust in the Martian atmosphere scatters blue light toward the sun, so sunsets on Mars appear blue.' },
  ],
});

/**
 * Insert Cite tags into a demo lesson and register its sources (in document order).
 * Returns the grounded markdown; unknown lessons are returned unchanged.
 */
export function groundDemoLesson(id, markdown, registry) {
  const cites = DEMO_CITATIONS[id];
  if (!cites || !registry) return markdown;
  const placed = cites
    .map((c) => ({ ...c, at: markdown.indexOf(c.after) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at);
  let out = '';
  let pos = 0;
  for (const c of placed) {
    const end = c.at + c.after.length;
    const ref = registry.cite({ type: 'web_search_result_location', url: c.url, title: c.title, cited_text: c.cited_text });
    out += markdown.slice(pos, end) + citeTag([ref]);
    pos = end;
  }
  return out + markdown.slice(pos);
}
