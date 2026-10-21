// Catalog components evaluated inside the sandbox (DIL_COMPONENT_SOURCES / lazy
// <Name>.generated chunks in the real client, findings §3.4). They are written only in DIL
// primitives and read server-resolved data from
//   appData.opGenui.componentResults[props.__resolutionId] = {status, state, code?, retryable?}
// following the ResolvedComponent<Name> -> OpGenuiResolvedComponentBoundary wrapper pattern.

export const CATALOG_NAMES = ['OpGenuiResolvedComponentBoundary', 'AsyncImage', 'Entity', 'Cite', 'Citation', 'StockChart', 'LearningQuiz'];

export function createCatalog({ __dil, DIL, GenUI }) {
  const h = __dil.jsx;

  // Widget-scoped GenUI: server actions become dispatchWidgetAction with the resolution id.
  function widgetGenUI(componentName, resolutionId) {
    return {
      ...GenUI,
      dispatchAction(action) {
        if (action.handler !== 'server') return GenUI.dispatchAction(action);
        return GenUI.dispatchWidgetAction({ ...action, nativeWidgetResolutionId: resolutionId, componentName });
      },
    };
  }

  function useComponentResult(props) {
    const id = props.__resolutionId;
    const result = DIL.useAppData((appData) => appData?.opGenui?.componentResults?.[id]);
    if (!result) return { status: 'pending', state: null };
    return result;
  }

  function OpGenuiResolvedComponentBoundary({ componentName, componentProps, Component, Skeleton }) {
    const result = useComponentResult(componentProps);
    const genui = widgetGenUI(componentName, componentProps.__resolutionId);
    if (result.status === 'resolved' && result.state) {
      return h(Component, { ...componentProps, state: result.state, genui });
    }
    if (result.status === 'failed') {
      return componentProps.fallback ?? (Skeleton ? null : null);
    }
    return Skeleton ? h(Skeleton, componentProps) : h('loading-block', { __component: componentName, height: 48, radius: 'lg' });
  }

  const resolved = (name, Component, Skeleton) => {
    const Wrapper = (props) => h(OpGenuiResolvedComponentBoundary, { componentName: name, componentProps: props, Component, Skeleton });
    Object.defineProperty(Wrapper, 'name', { value: `ResolvedComponent${name}` });
    return Wrapper;
  };

  // ---------------------------------------------------------------- AsyncImage
  const pxOr = (v, d) => (v == null || v === 'auto' ? d : v);
  function AsyncImageSkeleton(props) {
    return h('loading-block', { __component: 'AsyncImage', aspectRatio: props.aspectRatio || '1:1', width: pxOr(props.maxWidth, '100%'), radius: 'xl' });
  }
  function AsyncImageView(props) {
    const { state } = props;
    const images = state.images || [];
    const img = images[0];
    if (!img) return props.fallback ?? null;
    const aspectRatio = props.aspectRatio || state.frame_aspect_ratio || '1:1';
    const maxWidth = props.maxWidth || state.frame_max_width;
    const radius = state.presentation?.radius || 'xl';
    const width = maxWidth && /px$/.test(maxWidth) ? maxWidth : pxOr(state.frame_width, '100%');
    return h('pressable', {
      __component: 'AsyncImage',
      width, maxWidth, flex: '0 0 auto', radius,
      ariaLabel: img.title || 'Image',
      onClick: () => (state.default_on_click_action
        ? props.genui.dispatchAction(state.default_on_click_action)
        : GenUI.openImageLightbox(images.map((i) => ({ url: i.url, content_url: i.content_url, title: i.title })), 0)),
    }, h('image', {
      src: img.thumbnail_url || img.content_url,
      fullSrc: img.content_url,
      alt: img.title || '',
      aspectRatio, fit: state.image_fit || 'cover', radius, frame: state.presentation?.frame !== false, width: '100%',
      crop: img.thumbnail_crop_info ? { x: img.thumbnail_crop_info.center_x_percent, y: img.thumbnail_crop_info.center_y_percent } : undefined,
    }));
  }
  const AsyncImage = resolved('AsyncImage', AsyncImageView, AsyncImageSkeleton);

  // -------------------------------------------------------------------- Entity
  function EntitySkeleton(props) {
    return h('text', { __component: 'Entity', inline: true }, props.value || '');
  }
  function EntityView(props) {
    const { state } = props;
    const value = state.value ?? props.value;
    return h('pressable', {
      __component: 'Entity',
      inline: true,
      variant: 'entity',
      ariaLabel: state.view_details_label || value,
      onClick: () => (state.click_action
        ? props.genui.dispatchAction(state.click_action)
        : GenUI.openEntityDetail(props.category, value, { disambiguation: props.disambig })),
    }, value);
  }
  const Entity = resolved('Entity', EntityView, EntitySkeleton);

  // ---------------------------------------------------------------------- Cite
  function CiteSkeleton() {
    return h('badge', { __component: 'Cite', variant: 'citation', color: 'subtle' }, '…');
  }
  function CiteView(props) {
    const items = props.state.items || [];
    if (!items.length) return null;
    const first = items[props.state.active_index || 0] || items[0];
    const label = items.length > 1 ? `${first.source_label} +${items.length - 1}` : first.source_label;
    return h('pressable', {
      __component: 'Cite',
      inline: true,
      variant: 'citation',
      tooltip: items.map((i) => `${i.source_label}: ${i.title}`).join('\n'),
      ariaLabel: props.state.sources_title || label,
      onClick: () => GenUI.openUrl(first.url),
    }, label);
  }
  const Cite = resolved('Cite', CiteView, CiteSkeleton);

  // ---------------------------------------------------------------- StockChart
  const W = 640;
  const H = 180;
  function chartPaths(data) {
    const closes = data.map((d) => d.close).filter((v) => typeof v === 'number');
    if (closes.length < 2) return null;
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const pad = 8;
    const pts = closes.map((v, i) => [
      (i / (closes.length - 1)) * W,
      pad + (1 - (v - min) / span) * (H - pad * 2),
    ]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const baseY = pts[0][1].toFixed(1);
    return { line, area, baseY, min, max, last: pts[pts.length - 1] };
  }
  function StockChartSkeleton() {
    return h('loading-block', { __component: 'StockChart', height: 260, radius: 'xl', label: 'Loading chart' });
  }
  function StockChartView(props) {
    const { state } = props;
    const order = state.timeframe_order || Object.keys(state.timeframe_configs || {});
    const [range, setRange] = DIL.useState(state.default_range || order[0]);
    const isMobile = DIL.useIsMobile();
    const cfg = state.timeframe_configs?.[range];
    const summary = cfg?.summary || state.fallback_summary || {};
    const color = summary.price_change_color === 'danger' ? 'danger' : summary.price_change_color === 'success' ? 'success' : 'secondary';
    const data = cfg?.chart?.data || [];
    const paths = state.has_timeframe_data !== false ? chartPaths(data) : null;
    const labels = data.length ? [data[0], data[Math.floor(data.length / 2)], data[data.length - 1]].map((d) => d.formatted) : [];
    const metrics = (isMobile ? state.metrics_display_mobile : state.metrics_display) || [];
    const ah = state.after_hours;
    return h('col', { __component: 'StockChart', gap: 3, width: '100%' },
      h('col', { gap: 1 },
        h('text', { size: 'sm', color: 'secondary' }, state.asset_display_name || props.ticker),
        h('row', { align: 'baseline', gap: 2, wrap: true },
          h('title', { size: 'xl' }, summary.price_text || state.current_price_text || ''),
          h('text', { color, weight: 'medium', tabularNums: true }, summary.price_change_text || ''),
          h('text', { size: 'xs', color: 'tertiary' }, range)),
        h('text', { size: 'xs', color: 'secondary' }, summary.trade_date_text || state.price_status_text || ''),
        ah ? h('row', { gap: 1, align: 'center', wrap: true },
          h('text', { size: 'xs', color: 'secondary' }, `${ah.label}:`),
          h('text', { size: 'xs', weight: 'medium', tabularNums: true }, ah.price_text),
          h('text', { size: 'xs', color: ah.color || 'secondary', tabularNums: true }, `${ah.change_text} ${ah.percent_text}`)) : null),
      paths
        ? h('box', { width: '100%', gap: 1 },
          h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: isMobile ? 140 : 180, preserveAspectRatio: 'none', role: 'img', ariaLabel: `${props.ticker || ''} ${range} price chart` },
            h('path', { d: paths.area, fill: color, fillOpacity: 0.1, stroke: 'none' }),
            h('line', { x1: 0, x2: W, y1: paths.baseY, y2: paths.baseY, stroke: 'tertiary', strokeWidth: 1, strokeDasharray: '3 4', vectorEffect: 'non-scaling-stroke' }),
            h('path', { d: paths.line, fill: 'none', stroke: color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
            h('circle', { cx: paths.last[0], cy: paths.last[1], r: 3.5, fill: color })),
          h('row', { justify: 'between' }, ...labels.map((l, i) => h('text', { key: i, size: 'xs', color: 'tertiary', tabularNums: true }, l || ''))))
        : h('box', { height: 120, align: 'center', justify: 'center', background: 'surface-secondary', radius: 'lg' },
          h('text', { size: 'sm', color: 'secondary' }, state.labels?.no_chart_data || 'No chart data available')),
      h('row', { gap: 1, wrap: true, role: 'tablist' }, ...order.map((r) => h('pressable', {
        key: r,
        variant: r === range ? 'selected' : 'ghost',
        radius: 'full',
        padding: { x: 3, y: 1 },
        ariaPressed: r === range,
        onClick: () => setRange(r),
      }, h('text', { size: 'xs', weight: r === range ? 'semibold' : 'medium', color: r === range ? 'primary' : 'secondary' }, r)))),
      state.show_metrics && metrics.length
        ? h('col', { gap: 0 }, h('divider', { color: 'subtle' }), ...metrics.map((row, ri) => h('row', { key: ri, gap: 4 },
          ...row.cols.map((c, ci) => h('row', { key: ci, flex: 1, justify: 'between', padding: { y: 1 } },
            h('text', { size: 'sm', color: 'secondary' }, c.label),
            h('text', { size: 'sm', weight: 'medium', tabularNums: true }, c.value))))))
        : null);
  }
  const StockChart = resolved('StockChart', StockChartView, StockChartSkeleton);

  // -------------------------------------------------------------- LearningQuiz
  // Simplified port of LearningQuiz.generated (findings §3.5): same state fields
  // (questions, attempt, current_index, answers, selected_values, hint_open, labels…), local
  // progress via DIL.useState, server actions only when nativeServerActions.ready.
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  function QuizIconButton({ label, onClick, disabled, children }) {
    return h('pressable', { size: 36, radius: 'full', align: 'center', justify: 'center', ariaLabel: label, disabled, dimWhenDisabled: true, variant: 'ghost', onClick }, children);
  }

  function QuizChoiceRow({ option, index, question, answer, selected, onSelect }) {
    const hasFeedback = !!answer;
    const isSel = selected.includes(option.value);
    const correct = question.correct_values.includes(option.value);
    const marked = hasFeedback ? correct || isSel : isSel;
    const wrong = hasFeedback && isSel && !correct;
    const background = hasFeedback && correct ? 'green-500' : wrong ? 'red-400' : isSel ? '#0d0d0d' : 'transparent';
    const letter = question.question_type === 'true_false' ? (option.value === 'true' ? 'T' : 'F') : LETTERS[index] || option.value;
    return h('pressable', {
      key: option.value,
      variant: 'ghost',
      radius: 'lg',
      padding: { x: 3, y: '7px' },
      disabled: hasFeedback,
      dimWhenDisabled: hasFeedback && !(correct || isSel),
      ariaPressed: isSel,
      onClick: onSelect,
    }, h('row', { align: 'start', gap: 3, width: '100%' },
      h('box', {
        size: 32, radius: 'full', align: 'center', justify: 'center', background, flex: '0 0 auto',
        border: marked ? false : { size: 1, color: hasFeedback ? 'default' : 'strong' },
      }, hasFeedback && (correct || wrong)
        ? h('icon', { name: correct ? 'check' : 'x', size: 'lg', color: 'white' })
        : h('text', { size: 'sm', weight: 'medium', color: marked ? 'white' : 'primary' }, letter)),
      h('col', { flex: 1, gap: 1, minWidth: 0, padding: { top: '5px' } },
        h('text-only-markdown', null, option.label),
        hasFeedback && (isSel || correct) && option.feedback ? h('text', { size: 'sm', color: 'secondary' }, option.feedback) : null)));
  }

  function LearningQuizView(props) {
    const s = props.state;
    const actionsReady = DIL.useAppData((ad) => !!ad?.opGenui?.nativeServerActions?.ready);
    const isDesktop = DIL.useBreakpoint('sm');
    const [p, setP] = DIL.useState(() => ({
      attempt: s.attempt || 0,
      current_index: s.current_index || 0,
      answers: s.answers || [],
      selected_values: s.selected_values || [],
      hint_open: !!s.hint_open,
    }));
    const questions = s.questions || [];
    const n = questions.length;
    if (questions.some((q) => !['single_select', 'multi_select', 'true_false'].includes(q.question_type))) {
      return h('box', { __component: 'LearningQuiz', padding: 4, border: true, radius: 'xl' }, h('text', { color: 'danger' }, 'Unsupported question type'));
    }
    const idx = p.current_index;
    const q = questions[idx];
    const phase = q ? 'quiz' : 'results';
    const answer = q ? p.answers.find((a) => a.index === idx && a.question_id === q.id) : null;
    const selected = answer ? answer.selected_values : p.selected_values;
    const correctCount = p.answers.filter((a) => a.is_correct).length;

    const send = (type, payload) => {
      if (actionsReady) props.genui.dispatchAction({ handler: 'server', type, payload: { attempt: p.attempt, ...payload } });
    };
    const submit = (values) => {
      if (!q || answer || !values.length) return;
      const isCorrect = values.length === q.correct_values.length && values.every((v) => q.correct_values.includes(v));
      setP({ ...p, answers: [...p.answers, { index: idx, question_id: q.id, selected_values: values, is_correct: isCorrect }], selected_values: values, hint_open: false });
      send('learning_quiz_answer', { question_index: idx, selected_values: values, prior_answers: p.answers });
    };
    const select = (value) => {
      if (answer) return;
      if (q.question_type === 'multi_select') {
        const has = p.selected_values.includes(value);
        setP({ ...p, selected_values: has ? p.selected_values.filter((v) => v !== value) : [...p.selected_values, value] });
      } else submit([value]);
    };
    const go = (i) => setP({ ...p, current_index: i, selected_values: [], hint_open: false });
    const restart = () => {
      setP({ attempt: p.attempt + 1, current_index: 0, answers: [], selected_values: [], hint_open: false });
      send('learning_quiz_restart', {});
    };

    if (phase === 'results') {
      const nextQuery = s.next_quiz_query;
      return h('col', { __component: 'LearningQuiz', border: true, radius: '2xl', gap: 0, clip: true },
        h('celebration', { trigger: correctCount > 0, key: `c${p.attempt}` }),
        h('row', { align: 'center', justify: 'between', padding: { x: 5, top: 4 } },
          h('text', { size: 'md', color: 'secondary' }, s.title || 'Quiz')),
        h('box', { padding: { x: 5, top: 1, bottom: 3 } },
          h('title', { size: 'lg' }, s.correct_count_labels?.[correctCount] ?? `${correctCount}/${n} correct`)),
        h('col', { gap: 0 }, ...p.answers.map((a) => {
          const qq = questions[a.index];
          const correctOpts = qq.options.filter((o) => qq.correct_values.includes(o.value));
          return h('row', { key: a.question_id, align: 'start', gap: 3, padding: { x: 4, y: 2 } },
            h('box', { size: 30, radius: 'full', align: 'center', justify: 'center', background: a.is_correct ? 'green-500' : 'red-400', flex: '0 0 auto' },
              h('icon', { name: a.is_correct ? 'check' : 'x', size: 'lg', color: 'white' })),
            h('col', { flex: 1, minWidth: 0, gap: 1 },
              h('text-only-markdown', null, qq.prompt),
              ...correctOpts.map((o) => h('text', { key: o.value, size: 'sm', color: 'secondary' }, o.feedback || o.label))));
        })),
        h('row', { justify: 'between', align: 'center', gap: 3, padding: { x: 5, y: 4 }, wrap: true },
          h('button', { variant: 'outline', size: 'lg', onClick: restart }, s.restart_label || 'Restart'),
          nextQuery && s.generation_complete !== false
            ? h('button', {
              size: 'lg',
              onClick: () => GenUI.dispatchAction({
                handler: 'client', type: 'issue_new_turn', loadingBehavior: 'none',
                payload: { query: nextQuery, append_to_current_leaf: true, event_name: 'chatgpt_widget_action', event_data: { widget_affordance: 'OPTION', widget_action_target: 'next_quiz', surface_location: 'RESPONSE', content_reference_type: 'learning_quiz' } },
              }),
            }, s.next_quiz_label || 'Next quiz')
            : null));
    }

    const progressLabel = s.question_progress_labels?.[idx] ?? `${idx + 1} of ${n}`;
    const isLast = idx === n - 1;
    return h('col', { __component: 'LearningQuiz', border: true, radius: '2xl', gap: 0, clip: true },
      h('row', { align: 'start', gap: 3, padding: { x: 5, top: 4, bottom: 2 }, wrap: !isDesktop },
        h('col', { flex: '999 1 300px', minWidth: 0, gap: 1 },
          h('text', { size: 'sm', color: 'secondary' }, s.title || ''),
          h('text-only-markdown', { size: 'lg', weight: 'medium' }, q.prompt)),
        h('row', { flex: '0 0 auto', align: 'center', gap: '5px' },
          h(QuizIconButton, { label: s.previous_question_label || 'Previous question', disabled: idx === 0, onClick: () => go(idx - 1) },
            h('icon', { name: 'chevron-left', size: 'xl', color: idx === 0 ? 'tertiary' : 'secondary' })),
          h('box', { width: 48, align: 'center', justify: 'center' }, h('text', { size: 'sm', color: 'secondary', tabularNums: true }, progressLabel)),
          h(QuizIconButton, { label: s.next_question_label || 'Next question', disabled: !answer, onClick: () => go(idx + 1) },
            h('icon', { name: 'chevron-right', size: 'xl', color: answer ? 'secondary' : 'tertiary' })),
          q.hint ? h(QuizIconButton, { label: s.hint_label || 'Hint', disabled: !!answer, onClick: () => setP({ ...p, hint_open: !p.hint_open }) },
            h('icon', { name: 'lightbulb', size: 'xl', color: p.hint_open ? 'warning' : 'secondary' })) : null)),
      p.hint_open && q.hint
        ? h('row', { key: 'hint', margin: { x: 5 }, gap: 2, padding: 3, radius: 'lg', background: 'surface-secondary', align: 'start' },
          h('icon', { name: 'lightbulb', size: 'md', color: 'warning' }),
          h('text', { size: 'sm' }, q.hint))
        : null,
      h('col', { gap: 0, padding: { x: 2, y: 2 } }, ...q.options.map((o, i) => h(QuizChoiceRow, {
        key: `${q.id}:${o.value}`, option: o, index: i, question: q, answer, selected, onSelect: () => select(o.value),
      }))),
      h('row', { align: 'center', padding: { x: 5, bottom: 4, top: 1 }, gap: 3 },
        answer ? h('text', { size: 'sm', weight: 'medium', color: answer.is_correct ? 'success' : 'danger' }, answer.is_correct ? (s.correct_feedback_label || 'Correct!') : (s.incorrect_feedback_label || 'Not quite')) : null,
        h('spacer', null),
        q.question_type === 'multi_select' && !answer
          ? h('button', { size: 'md', disabled: !p.selected_values.length, onClick: () => submit(p.selected_values) }, s.submit_answer_label || 'Submit')
          : null,
        answer ? h('button', { size: 'md', onClick: () => go(idx + 1) }, isLast ? (s.see_results_label || 'See results') : (s.next_question_label || 'Next')) : null));
  }
  function LearningQuizSkeleton() {
    return h('col', { __component: 'LearningQuiz', border: true, radius: '2xl', padding: 5, gap: 3 },
      h('loading-block', { height: 20, width: '70%', radius: 'full' }),
      ...LETTERS.slice(0, 4).map((l) => h('row', { key: l, gap: 3, align: 'center' },
        h('box', { size: 32, radius: 'full', border: { size: 1, color: 'strong' }, align: 'center', justify: 'center' }, h('text', { size: 'sm' }, l)),
        h('loading-block', { height: 16, width: '60%', radius: 'full' }))));
  }
  const LearningQuiz = resolved('LearningQuiz', LearningQuizView, LearningQuizSkeleton);

  return { OpGenuiResolvedComponentBoundary, AsyncImage, Entity, Cite, Citation: Cite, StockChart, LearningQuiz };
}
