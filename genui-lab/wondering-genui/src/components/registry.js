// INTERACTIVE_COMPONENTS registry: the full 100-key list from @4084974.
// Keys that have a reconstruction point at it (the *-d3 variants share the
// implementation, exactly like the shipped map). Everything else gets a
// graceful placeholder so markers using those names still resolve.
// Importable in Node: components only touch `document` when called.

import {
  LessonStepper,
  LessonStepperWorkedExample,
  LessonReveal,
  LessonCompareToggle,
  LessonInputOutputSlider,
  LessonTable,
  WonderingLensCard,
} from "./lesson.js";
import { VisualList, VisualStepper, VisualCards, VisualStatBars, VisualVenn, VisualTransform, VisualQuadrant } from "./visual.js";
import {
  FlowchartVisualization,
  TimelineVisualization,
  BarChartVisualization,
  ConceptMapVisualization,
  CycleVisualization,
  ComparisonVisualization,
} from "./dataviz.js";
import { h } from "./dom.js";

export const INTERACTIVE_COMPONENT_NAMES = Object.freeze([
  "animated-graph", "simple-simulation", "lesson-stepper", "lesson-stepper-worked-example", "lesson-reveal",
  "lesson-compare-toggle", "lesson-input-output-slider", "lesson-table", "wondering-lens", "lesson-figure",
  "visual-list", "visual-stepper", "visual-cards", "visual-table", "diagram-visualization", "flowchart-visualization",
  "visual-loop", "visual-hierarchy", "visual-quadrant", "visual-venn", "visual-stat-bars", "visual-transform",
  "concept-map-visualization", "comparison-visualization", "hierarchy-visualization", "cycle-visualization",
  "infographic-visualization", "timeline-visualization", "quadrant-visualization", "quadrant-matrix-visualization",
  "pyramid-visualization", "rings-visualization", "bar-chart-visualization", "line-chart-visualization",
  "pie-chart-visualization", "scatter-plot-visualization", "area-chart-visualization", "heatmap-visualization",
  "diagram-visualization-d3", "flowchart-visualization-d3", "concept-map-visualization-d3", "comparison-visualization-d3",
  "timeline-visualization-d3", "hierarchy-visualization-d3", "cycle-visualization-d3", "infographic-visualization-d3",
  "deprecated-diagram-visualization", "deprecated-flowchart-visualization", "deprecated-concept-map-visualization",
  "deprecated-comparison-visualization", "deprecated-hierarchy-visualization", "deprecated-cycle-visualization",
  "deprecated-infographic-visualization", "deprecated-timeline-visualization", "deprecated-quadrant-visualization",
  "deprecated-bar-chart-visualization", "deprecated-line-chart-visualization", "deprecated-pie-chart-visualization",
  "deprecated-scatter-plot-visualization", "deprecated-area-chart-visualization",
  "movie-script-simulator", "word-prediction-visualizer", "probability-distribution", "output-variety-table",
  "randomness-simulator", "timeline-scale", "data-scale-comparison", "parameter-scale-visualizer", "parameter-weight-demo",
  "before-after-training", "training-loop-animation", "accuracy-progress-chart", "computation-time-calculator",
  "rlhf-simulator", "feedback-loop-visualization", "post-training-comparison-table", "two-stage-training",
  "parallel-processing-visualizer", "gpu-speed-comparison", "transformer-architecture-diagram", "word-encoding-animation",
  "word-embedding-visualizer", "vector-space-explorer", "attention-mechanism-visualizer", "context-disambiguation",
  "feed-forward-architecture", "layer-stack-visualizer", "layer-data-flow-animation", "prediction-probability-chart",
  "prompt-comparison-tool", "prompt-builder", "parameter-dial-board", "historical-time-comparison",
  "gpu-architecture-diagram", "sequential-vs-parallel-comparison", "transformer-timeline", "emergence-demonstrator",
  "black-box-visualizer", "llm-capabilities-showcase", "model-evolution-comparison",
]);

export const IMPLEMENTED_COMPONENTS = Object.freeze({
  "lesson-stepper": LessonStepper,
  "lesson-stepper-worked-example": LessonStepperWorkedExample,
  "lesson-reveal": LessonReveal,
  "lesson-compare-toggle": LessonCompareToggle,
  "lesson-input-output-slider": LessonInputOutputSlider,
  "lesson-table": LessonTable,
  "wondering-lens": WonderingLensCard,
  "visual-list": VisualList,
  "visual-stepper": VisualStepper,
  "visual-cards": VisualCards,
  "visual-quadrant": VisualQuadrant,
  "visual-venn": VisualVenn,
  "visual-stat-bars": VisualStatBars,
  "visual-transform": VisualTransform,
  "flowchart-visualization": FlowchartVisualization,
  "concept-map-visualization": ConceptMapVisualization,
  "comparison-visualization": ComparisonVisualization,
  "cycle-visualization": CycleVisualization,
  "timeline-visualization": TimelineVisualization,
  "bar-chart-visualization": BarChartVisualization,
  // d3 variants share the implementation in the shipped registry too.
  "flowchart-visualization-d3": FlowchartVisualization,
  "concept-map-visualization-d3": ConceptMapVisualization,
  "comparison-visualization-d3": ComparisonVisualization,
  "timeline-visualization-d3": TimelineVisualization,
  "cycle-visualization-d3": CycleVisualization,
  // visual-loop is the generic-widget sibling of cycle-visualization.
  "visual-loop": CycleVisualization,
});

function describeParams(props) {
  const data = props && typeof props.data === "object" && props.data ? props.data : null;
  const keys = data ? Object.keys(data) : Object.keys(props || {});
  return keys.length ? `params: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}` : "no params";
}

export function createPlaceholderComponent(name) {
  const Placeholder = (props) =>
    h(
      "div",
      { class: "w-placeholder", role: "note", "data-component": name },
      h("div", { class: "w-placeholder__name" }, name),
      h("div", { class: "w-placeholder__body" }, "Registered in INTERACTIVE_COMPONENTS but not reconstructed in this lab (hand-authored, chart-variant or legacy widget)."),
      h("div", { class: "w-placeholder__meta" }, describeParams(props))
    );
  Placeholder.isPlaceholder = true;
  Placeholder.componentName = name;
  return Placeholder;
}

export const INTERACTIVE_COMPONENTS = Object.freeze(
  Object.fromEntries(INTERACTIVE_COMPONENT_NAMES.map((name) => [name, IMPLEMENTED_COMPONENTS[name] ?? createPlaceholderComponent(name)]))
);

export function getInteractiveComponent(name) {
  return Object.prototype.hasOwnProperty.call(INTERACTIVE_COMPONENTS, name) ? INTERACTIVE_COMPONENTS[name] : undefined;
}

export function isInteractiveComponent(name) {
  return Object.prototype.hasOwnProperty.call(INTERACTIVE_COMPONENTS, name);
}

export function isImplemented(name) {
  return Object.prototype.hasOwnProperty.call(IMPLEMENTED_COMPONENTS, name);
}
