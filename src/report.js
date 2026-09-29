// Plain-text rendering of analysis results (CLI, live test script, test reports).
const trunc = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

export function formatChecks(checks, { base = '' } = {}) {
  const rel = (u) => (u ? String(u).replace(base, '') || '/' : '');
  const lines = [];
  lines.push(`${'check'.padEnd(21)} ${'result'.padEnd(15)} ${'conf'.padEnd(5)} ${'http'.padEnd(5)} evidence`);
  for (const c of checks) {
    const ev = c.evidence_url ? rel(c.evidence_url) : (c.evidence?.reason ?? '');
    lines.push(`${c.check_type.padEnd(21)} ${c.result.padEnd(15)} ${String(c.confidence ?? '-').padEnd(5)} ${String(c.http_status ?? '-').padEnd(5)} ${trunc(ev, 60)}`);
  }
  return lines.join('\n');
}

export function summarize(checks) {
  const s = { yes: 0, no: 0, unknown: 0, not_applicable: 0 };
  for (const c of checks) s[c.result]++;
  return s;
}
