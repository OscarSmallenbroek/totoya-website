#!/usr/bin/env node
// Run one source scraper live and print a summary.
//   node scraper/test/try-source.mjs <id> [--all] [--json]
//   --all   print every event (one line each) instead of 3 samples
//   --json  print the full RawEvent[] as JSON
import { makeCtx } from '../lib/http.mjs';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id) {
  console.error('usage: node scraper/test/try-source.mjs <id> [--all] [--json]');
  process.exit(2);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

function validate(ev) {
  const problems = [];
  if (ev.source !== id) problems.push(`source="${ev.source}"`);
  if (!ev.title || typeof ev.title !== 'string') problems.push('title missing');
  if (!/^https?:\/\//.test(ev.url || '')) problems.push(`url invalid "${ev.url}"`);
  if (!DATE_RE.test(ev.start || '')) problems.push(`start invalid "${ev.start}"`);
  if (ev.end != null && !DATE_RE.test(ev.end)) problems.push(`end invalid "${ev.end}"`);
  if (ev.end && ev.end.slice(0, 10) < ev.start.slice(0, 10)) problems.push('end before start');
  if (ev.description && ev.description.length > 1500) problems.push('description > 1500');
  if (ev.image && !/^https?:\/\//.test(ev.image)) problems.push(`image not absolute "${ev.image}"`);
  if (ev.tags && !Array.isArray(ev.tags)) problems.push('tags not array');
  return problems;
}

const mod = await import(`../sources/${id}.mjs`);
const ctx = makeCtx({ log: (...a) => console.error(`[${id}]`, ...a) });
const t0 = Date.now();
const events = await mod.scrape(ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (args.includes('--json')) {
  console.log(JSON.stringify(events, null, 2));
} else {
  report(events);
}

function report(events) {
let bad = 0;
for (const ev of events) {
  const p = validate(ev);
  if (p.length) {
    bad++;
    console.log('INVALID:', p.join('; '), '→', ev.title);
  }
}

console.log(`\n${id}: ${events.length} events in ${secs}s, ${bad} invalid`);
const ranges = events.filter((e) => e.end && e.end.slice(0, 10) !== e.start.slice(0, 10)).length;
console.log(`  with time: ${events.filter((e) => e.start.includes('T')).length}, multi-day/range: ${ranges}`);

if (args.includes('--all')) {
  for (const e of events) {
    console.log(`  ${e.start}${e.end ? ' → ' + e.end : ''} | ${e.title} | ${e.venueName || ''} | ${e.priceText || ''}`);
  }
} else {
  const step = Math.max(1, Math.floor(events.length / 3));
  for (const e of [events[0], events[step], events[2 * step]].filter(Boolean)) {
    console.log('\n' + JSON.stringify({ ...e, description: e.description?.slice(0, 200) }, null, 2));
  }
}
process.exitCode = bad ? 1 : 0;
}
