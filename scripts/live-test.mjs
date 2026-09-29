#!/usr/bin/env node
// Run the analyzer against REAL public websites (no database involved).
//
//   node scripts/live-test.mjs https://site-one.com https://site-two.com|restaurant https://site-three.com|barber
//   node scripts/live-test.mjs --file scripts/sites.txt      (one "url|industry" per line)
//
// Writes reports/live-<timestamp>.json and prints a table per site.
// Nothing here writes to Supabase. Requires normal outbound internet access.
import fs from 'node:fs';
import { analyzeOne } from '../src/cli.js';
import { formatChecks, summarize } from '../src/report.js';

const argv = process.argv.slice(2);
let entries = [];
const fi = argv.indexOf('--file');
if (fi >= 0) entries = fs.readFileSync(argv[fi + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
else entries = argv;
if (!entries.length) { console.error('Give at least one URL (optionally url|industry) or --file <list>'); process.exit(2); }

const results = [];
for (const entry of entries) {
  const [url, industry] = entry.split('|');
  const t0 = Date.now();
  try {
    const r = await analyzeOne({ url, industry });
    console.log(`\n=== ${url}  (${industry || 'industry unspecified'})  state=${r.siteState}  conclusive=${r.conclusive}  ${Date.now() - t0}ms`);
    console.log(formatChecks(r.checks));
    console.log('summary:', JSON.stringify(summarize(r.checks)), r.crawl?.inconclusive_reasons?.length ? `inconclusive: ${r.crawl.inconclusive_reasons.join(', ')}` : '');
    results.push({ url, industry, ok: true, result: r });
  } catch (err) {
    console.log(`\n=== ${url}  ERROR ${err.message}`);
    results.push({ url, industry, ok: false, error: String(err.message) });
  }
}
fs.mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
const file = new URL(`../reports/live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nfull JSON (with evidence): ${file.pathname}`);
