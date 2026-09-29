#!/usr/bin/env node
// Ad-hoc analysis WITHOUT touching any database (dry run):
//   node src/cli.js analyze --url https://example-restaurant.com --industry restaurant [--json] [--verbose]
import { analyzeBusiness } from './analyze.js';
import { formatChecks, summarize } from './report.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export async function analyzeOne({ url, industry, name, sourceUrl, allowPrivate = false, respectRobots = true }) {
  return analyzeBusiness(
    { business_id: null, owner_id: null, name, industry, website_url: url ?? null, source: 'cli', source_url: sourceUrl ?? null },
    { http: { allowPrivate }, respectRobots },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== 'analyze' || (!args.url && !args['no-website'])) {
    console.error('Usage: node src/cli.js analyze --url <website> [--industry restaurant|pizza|cafe|barber|salon|cleaning|auto_repair] [--source-url <listing url>] [--json] [--verbose]');
    process.exit(2);
  }
  const started = Date.now();
  const r = await analyzeOne({ url: args.url, industry: args.industry, name: args.name, sourceUrl: args['source-url'], allowPrivate: !!args['allow-private'] });
  if (args.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`\n${args.url}   industry=${r.profile.key}${r.profile.known ? '' : ' (unrecognised: nothing marked not_applicable)'}   site_state=${r.siteState}   conclusive=${r.conclusive}   ${Date.now() - started}ms\n`);
  console.log(formatChecks(r.checks));
  const s = summarize(r.checks);
  console.log(`\nsummary: yes=${s.yes} no=${s.no} unknown=${s.unknown} not_applicable=${s.not_applicable}`);
  if (r.crawl) {
    console.log(`pages inspected: ${r.crawl.pages_inspected.length}${r.crawl.inconclusive_reasons.length ? `   inconclusive because: ${r.crawl.inconclusive_reasons.join(', ')}` : ''}`);
  }
  if (args.verbose) for (const c of r.checks) console.log(`\n[${c.check_type}] ${c.result}\n  url: ${c.evidence_url}\n  excerpt: ${c.evidence_excerpt}\n  evidence: ${JSON.stringify(c.evidence)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
