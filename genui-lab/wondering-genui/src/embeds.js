// Model-facing embed schema: {embed:{type:<snake_case>, ...fields}, insertAfterParagraph:n}
// Port of the ModelBenchmarkReportPage chunk (@1057): map G, marker builder T(),
// page splice Q() (findings §1.3). DOM-free.

export const EMBED_TYPE_TO_COMPONENT = Object.freeze({
  stepper: "lesson-stepper",
  flowchart: "flowchart-visualization",
  stepper_worked_example: "lesson-stepper-worked-example",
  reveal: "lesson-reveal",
  compare: "lesson-compare-toggle",
  slider: "lesson-input-output-slider",
  table: "lesson-table",
  list: "visual-list",
  cards: "visual-cards",
  loop: "cycle-visualization",
  infographic: "infographic-visualization",
  hierarchy: "hierarchy-visualization",
  comparison: "comparison-visualization",
  quadrant: "quadrant-visualization",
  quadrant_matrix: "quadrant-matrix-visualization",
  timeline: "timeline-visualization",
  pyramid: "pyramid-visualization",
  rings: "rings-visualization",
  bar_chart: "bar-chart-visualization",
  line_chart: "line-chart-visualization",
  pie_chart: "pie-chart-visualization",
  scatter_plot: "scatter-plot-visualization",
  area_chart: "area-chart-visualization",
  heatmap: "heatmap-visualization",
  concept_map: "concept-map-visualization",
  wondering_lens: "wondering-lens",
  venn: "visual-venn",
  stat_bars: "visual-stat-bars",
  transform: "visual-transform",
});

export const EMBED_TYPES = Object.freeze(Object.keys(EMBED_TYPE_TO_COMPONENT));

/**
 * Port of T(): embed object -> `{{interactive:<name> data='<json>'}}`.
 * Single quotes in the JSON are written as the JSON escape ' so the
 * single-quoted attribute can never terminate early; JSON.parse restores them.
 * Accepts either an entry `{embed:{...}}` (shipped signature) or a bare embed.
 */
export function embedToMarker(entryOrEmbed) {
  const embed = entryOrEmbed && typeof entryOrEmbed === "object" && "embed" in entryOrEmbed ? entryOrEmbed.embed : entryOrEmbed;
  const type = typeof embed?.type === "string" ? embed.type : "";
  const name = EMBED_TYPE_TO_COMPONENT[type];
  if (!embed || !name) return null;
  const rest = Object.fromEntries(Object.entries(embed).filter(([k]) => k !== "type"));
  const json = JSON.stringify(rest).replace(/'/g, "\\u0027");
  return `{{interactive:${name} data='${json}'}}`;
}

/** Splits page markdown into paragraphs the way the pipeline does. */
export function splitParagraphs(content) {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Inserts `marker` after paragraph `n` (0 = before the first paragraph).
 * n is clamped to [0, paragraphs.length]. Paragraphs are re-joined by "\n\n".
 */
export function insertEmbedAfterParagraph(content, marker, n) {
  const paragraphs = splitParagraphs(content);
  const at = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, paragraphs.length));
  paragraphs.splice(at, 0, marker);
  return paragraphs.join("\n\n");
}

/** Port of Q(page, entry): returns a new page with the embed spliced in (or the page unchanged). */
export function applyEmbedEntry(page, entry) {
  const marker = embedToMarker(entry);
  if (!marker) return page;
  return { ...page, content: insertEmbedAfterParagraph(page.content, marker, entry.insertAfterParagraph) };
}

/** Applies several {pageIndex, embed, insertAfterParagraph} entries to a lesson's pages. */
export function applyEmbedEntries(pages, entries = []) {
  const out = pages.map((p) => ({ ...p }));
  for (const entry of entries) {
    const i = entry.pageIndex;
    if (Number.isInteger(i) && out[i]) out[i] = applyEmbedEntry(out[i], entry);
  }
  return out;
}
