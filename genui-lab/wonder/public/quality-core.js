// Phase 7: the lesson quality report (server/critic.js -> control `quality-report`), summarized
// for the lesson's end panel. Pure, so it is tested under node:test.

const KIND_LABEL = { quiz_key: 'Quiz answer', factual: 'Fact', math: 'Numbers', citation: 'Citation', level: 'Level', widget: 'Diagram', clarity: 'Clarity' };

/**
 * {tone: 'ok'|'fixed'|'warn'|'lint', headline, items:[{label, text}]} or null without a report.
 * tone: ok = checked, nothing found; fixed = quiz fixes applied, nothing else; warn = open
 * issues remain; lint = the critic did not run (demo mode, off, or failed), format checks only.
 */
export function qualitySummary(report) {
  if (!report || typeof report !== 'object' || !report.lint) return null;
  const fixed = Array.isArray(report.critic?.fixed) ? report.critic.fixed : [];
  const issues = Array.isArray(report.critic?.issues) ? report.critic.issues : [];
  const items = [
    ...fixed.map((f) => ({ label: 'Fixed', text: `Quiz question ${f.question_id}: the answer key was corrected.` })),
    ...issues.filter((i) => !(i.kind === 'quiz_key' && fixed.length)).map((i) => ({ label: KIND_LABEL[i.kind] || 'Note', text: `${i.page ? `Page ${i.page}: ` : ''}${i.problem}`, major: i.severity === 'major' })),
  ];
  const fmt = `${report.lint.passed}/${report.lint.total} format checks passed`;
  if (report.critic?.skipped) {
    return { tone: 'lint', headline: `Format check only: ${fmt}.`, items: (report.lint.failed || []).map((f) => ({ label: 'Format', text: f.detail })) };
  }
  const open = items.filter((i) => i.label !== 'Fixed').length;
  if (!items.length) return { tone: 'ok', headline: `Checked by a second AI pass: no problems found. ${fmt}.`, items };
  if (!open) return { tone: 'fixed', headline: `Checked by a second AI pass: ${fixed.length} quiz answer${fixed.length === 1 ? '' : 's'} corrected.`, items };
  return { tone: 'warn', headline: `Checked by a second AI pass: ${open} thing${open === 1 ? '' : 's'} to read with care${fixed.length ? `, ${fixed.length} fixed` : ''}.`, items };
}
