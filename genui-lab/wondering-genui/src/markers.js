// Marker grammar for model-authored interactive components.
// Port of processInteractiveComponents / parseComponentParams / parseValue /
// removeUnrenderableInteractiveMarkers / reserveUnknownComponentReport
// (main bundle index-7fdxy4xw.js @4090800-4093900, findings §1.1).
// DOM-free: importable from Node.

import { getInteractiveComponent } from "./components/registry.js";

export const INTERACTIVE_MARKER_PREFIX = "{{interactive:";

// Exact regex from @4091499. Group 1: name (with params), group 2: raw params,
// group 3: name (bare marker).
export const INTERACTIVE_MARKER_SOURCE =
  "\\{\\{interactive:([^\\s}]+)(?:\\s+((?:[^}'\"]|'[^']*'|\"[^\"]*\")*))\\}\\}|\\{\\{interactive:([^\\s}]+)\\}\\}";

export function createMarkerRegex() {
  return new RegExp(INTERACTIVE_MARKER_SOURCE, "g");
}

export const PLACEHOLDER_PATTERN = /%%%INTERACTIVE_\d+%%%/g;

// --- unknown component telemetry (deduped, LRU caps) -----------------------

export const MAX_TRACKED_LESSON_SESSIONS = 100;
export const MAX_REPORTED_UNKNOWN_COMPONENTS_PER_SESSION = 100;
export const INTERACTIVE_COMPONENT_UNKNOWN = "interactive_component_unknown";

const reportedUnknownComponentsBySession = new Map();

/** Returns true the first time (session, name) is seen; false when deduped or capped. */
export function reserveUnknownComponentReport(sessionId, name) {
  let set = reportedUnknownComponentsBySession.get(sessionId);
  if (!set) {
    if (reportedUnknownComponentsBySession.size >= MAX_TRACKED_LESSON_SESSIONS) {
      const oldest = reportedUnknownComponentsBySession.keys().next().value;
      if (oldest) reportedUnknownComponentsBySession.delete(oldest);
    }
    set = new Set();
    reportedUnknownComponentsBySession.set(sessionId, set);
  }
  if (set.has(name) || set.size >= MAX_REPORTED_UNKNOWN_COMPONENTS_PER_SESSION) return false;
  set.add(name);
  return true;
}

export function resetUnknownComponentReports() {
  reportedUnknownComponentsBySession.clear();
}

export function trackedUnknownSessionCount() {
  return reportedUnknownComponentsBySession.size;
}

// --- param parsing ---------------------------------------------------------

/** Port of parseValue: JSON for [ { true false null (with \" un-escape retry), numbers, else string. */
export function parseValue(raw) {
  if (raw.startsWith("[") || raw.startsWith("{") || raw === "true" || raw === "false" || raw === "null") {
    try {
      return { value: JSON.parse(raw), isValid: true };
    } catch {
      const unescaped = raw.replace(/\\"/g, '"');
      if (unescaped !== raw) {
        try {
          return { value: JSON.parse(unescaped), isValid: true };
        } catch {
          /* fall through */
        }
      }
      return { value: raw, isValid: false };
    }
  }
  if (/^-?\d+\.?\d*$/.test(raw)) {
    const n = JSON.parse(raw.endsWith(".") ? raw.slice(0, -1) : raw);
    if (typeof n === "number" && !isNaN(n)) return { value: n, isValid: true };
  }
  return { value: raw, isValid: true };
}

/** Port of parseComponentParams (@4093110). */
export function parseComponentParams(input) {
  if (!input || !input.trim()) return { params: {}, isValid: true };
  const params = {};
  const text = input.trim();
  let isValid = true;
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  let last = 0;
  while ((m = re.exec(text)) !== null) {
    // Junk between pairs invalidates the marker.
    if (text.slice(last, m.index).trim()) isValid = false;
    const key = m[1];
    const raw = m[2] ?? m[3] ?? m[4];
    const parsed = parseValue(raw);
    params[key] = parsed.value;
    isValid = isValid && parsed.isValid;
    if (key === "data" && (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value))) {
      isValid = false;
    }
    last = re.lastIndex;
  }
  if (text.slice(last).trim()) isValid = false;
  return { params, isValid };
}

// --- streaming-safe trimming -----------------------------------------------

/**
 * Port of removeUnrenderableInteractiveMarkers: drop any remaining complete
 * marker, any unterminated `{{interactive:` tail, and (while streaming) any
 * trailing prefix of `{{interactive:` such as `{{inter`.
 */
export function removeUnrenderableInteractiveMarkers(text, isStreaming = false) {
  let out = text.replace(/\{\{interactive:[\s\S]*?\}\}/g, "").replace(/\{\{interactive:[\s\S]*$/g, "");
  if (!isStreaming) return out;
  const max = Math.min(INTERACTIVE_MARKER_PREFIX.length - 1, out.length);
  for (let i = max; i > 0; i -= 1) {
    if (out.endsWith(INTERACTIVE_MARKER_PREFIX.slice(0, i))) {
      out = out.slice(0, -i);
      break;
    }
  }
  return out;
}

// --- main pass -------------------------------------------------------------

/**
 * Port of processInteractiveComponents(content, experimentContext, options).
 * options: { rejectInvalidMarkers, isStreaming, getComponent, warn, track }
 *  - getComponent(name) -> component|undefined (defaults to INTERACTIVE_COMPONENTS)
 *  - warn(msg) defaults to console.warn
 *  - track(eventName, props) telemetry callback (PostHog stand-in)
 * Returns { processedContent, placeholderMap: Map<placeholder, entry> }.
 */
export function processInteractiveComponents(content, experimentContext, options = {}) {
  const {
    rejectInvalidMarkers = false,
    isStreaming = false,
    getComponent = getInteractiveComponent,
    warn = (msg) => console.warn(msg),
    track,
  } = options;
  const placeholderMap = new Map();
  const seenInstanceIds = new Set();
  let index = 0;
  const re = createMarkerRegex();
  const replaced = content.replace(re, (whole, nameWithParams, rawParams, bareName) => {
    const name = (nameWithParams || bareName).trim();
    if (!name) {
      warn("Interactive component marker has empty name, skipping");
      return whole;
    }
    const Component = getComponent(name);
    if (!Component) {
      warn(`Interactive component "${name}" not found in registry, skipping`);
      if (experimentContext && reserveUnknownComponentReport(experimentContext.lessonSessionId, name) && track) {
        // The shipped code literally sends componentName:"unknown" then spreads the context.
        track(INTERACTIVE_COMPONENT_UNKNOWN, { componentName: "unknown", requestedName: name, ...experimentContext });
      }
      return rejectInvalidMarkers ? "" : whole;
    }
    // In chat surfaces, markers are never rendered mid-stream.
    if (rejectInvalidMarkers && isStreaming) return "";
    const parsed = rawParams ? parseComponentParams(rawParams) : { params: {}, isValid: true };
    if (rejectInvalidMarkers && !parsed.isValid) return "";
    const { instanceId, altText, ...params } = parsed.params;
    const alt = typeof altText === "string" && altText.trim() ? altText.trim() : undefined;
    const stableId =
      typeof instanceId === "string" && instanceId.length > 0 && !seenInstanceIds.has(instanceId) ? instanceId : undefined;
    if (stableId) seenInstanceIds.add(stableId);
    const placeholder = `%%%INTERACTIVE_${index}%%%`;
    index += 1;
    placeholderMap.set(placeholder, {
      componentName: name,
      Component,
      params,
      instanceId: stableId,
      altText: alt,
      isValid: parsed.isValid,
      experimentContext,
    });
    return placeholder;
  });
  return {
    processedContent: rejectInvalidMarkers ? removeUnrenderableInteractiveMarkers(replaced, isStreaming) : replaced,
    placeholderMap,
  };
}

/** Lists every marker in `content` without replacing (debug / tests). */
export function findInteractiveMarkers(content) {
  const out = [];
  const re = createMarkerRegex();
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = (m[1] || m[3]).trim();
    const parsed = m[2] ? parseComponentParams(m[2]) : { params: {}, isValid: true };
    out.push({ name, raw: m[0], index: m.index, ...parsed });
  }
  return out;
}
