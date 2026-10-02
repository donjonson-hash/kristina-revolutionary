(() => {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), {once: true});
  const tool = {
    name: 'get_comparison_status',
    title: "Comparison status",
    description: 'Read the visible comparison state and result summary without returning document contents.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    annotations: {readOnlyHint: true, untrustedContentHint: true},
    execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object');
      const results = document.getElementById('results');
      const notice = document.getElementById('notice');
      return {hasResult: !!results && !results.hidden, requiresClarification: !document.getElementById('setup-question').hidden, notice: notice.hidden ? '' : notice.textContent.trim(), changes: results.hidden ? '' : document.getElementById('change-count').textContent.trim()};
    }
  };
  try { Promise.resolve(context.registerTool(tool, {signal:lifecycle.signal})).catch(() => {}); } catch (_) { /* Optional API; comparison remains available. */ }
})();
