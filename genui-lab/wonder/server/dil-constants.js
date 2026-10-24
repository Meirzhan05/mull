// Reading server-resolved component props back out of a compiled DIL program: the compiler
// hoists every catalog prop into __dilConstants, so `"key":__dilConstants["n"]` inside a
// `__dil.jsx(Name,{…})` call names the constant that holds it. Used by grounding.js (Cite) and
// figures.js (Figure) and media-resolver.js (Video).

/** The constants index of `key` inside one compiled props object body, or null. */
export function constRef(body, key) {
  const m = new RegExp(`"${key}":__dilConstants\\["(\\d+)"\\]`).exec(body);
  return m ? m[1] : null;
}
