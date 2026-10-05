#!/usr/bin/env node
// Orchestrator: scrape → normalise → classify → merge places → write site/data/events.json (Contract 2).
//
// Usage: node scraper/run.mjs [--only=id,id] [--no-ai] [--dry]
//   --only=…   run only these source ids (other enabled sources keep their previous events)
//   --no-ai    force the keyword classifier
//   --dry      print stats, don't write files
// Testing flags: --sources-dir=<dir> --out-dir=<dir> --places=<file> --cache=<file>
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCtx } from './lib/http.mjs';
import { loadYaml, loadJson, bogotaDate, mapLimit, withTimeout, isEvening } from './lib/util.mjs';
import { normaliseRaw, inHorizon, dedupe, assignIds, sortEvents } from './lib/normalize.mjs';
import { classifyEvents } from './lib/classify.mjs';
import { buildPlaces } from './lib/places.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY = 3;
const SOURCE_TIMEOUT_MS = 3 * 60 * 1000;
// Statuses for which we keep last run's (still upcoming) events for that source.
const CARRY_OVER = new Set(['failed', 'timeout', 'empty', 'not-run']);

function parseArgs(argv) {
  const args = { only: null, ai: true, dry: false };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split(/=(.*)/s);
    if (k === 'only') args.only = new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (k === 'no-ai') args.ai = false;
    else if (k === 'dry') args.dry = true;
    else if (k === 'sources-dir') args.sourcesDir = resolve(v);
    else if (k === 'out-dir') args.outDir = resolve(v);
    else if (k === 'places') args.placesFile = resolve(v);
    else if (k === 'cache') args.cacheFile = resolve(v);
    else if (k === 'help' || k === 'h') {
      console.log('node scraper/run.mjs [--only=id,id] [--no-ai] [--dry]');
      process.exit(0);
    } else console.warn(`unknown flag: ${a}`);
  }
  return args;
}

function toEvent(ev, c) {
  const out = {
    id: ev.id,
    title: ev.title,
    summary: c.summary,
    kind: c.kind,
    category: c.category,
    span: c.span,
    start: ev.start,
  };
  if (ev.end) out.end = ev.end;
  out.evening = isEvening(ev.start);
  out.venue = { name: ev.venueName || ev.address || 'Lugar por confirmar' };
  if (ev.address) out.venue.address = ev.address;
  out.venue.zone = c.zone;
  out.nearHome = Boolean(c.nearHome);
  out.price = { free: Boolean(c.price.free), text: c.price.text || (c.price.free ? 'Gratis' : 'Consultar precio') };
  out.accessibility = c.accessibility;
  out.forSeniors = Boolean(c.forSeniors);
  out.url = ev.url;
  out.source = ev.source;
  out.sourceName = ev.sourceName;
  if (ev.image) out.image = ev.image;
  return out;
}

async function runSource(src, { sourcesDir, now, horizonDays }) {
  const started = Date.now();
  const rep = { name: src.name, status: 'ok', raw: 0, valid: 0, invalid: 0, invalidSamples: [], error: null, durationMs: 0, logs: 0 };
  const file = join(sourcesDir, `${src.id}.mjs`);
  if (!existsSync(file)) {
    rep.status = 'missing';
    console.log(`[${src.id}] no scraper at scraper/sources/${src.id}.mjs — skipped`);
    return { rep, events: [] };
  }
  const log = (...a) => {
    rep.logs++;
    console.log(`[${src.id}]`, ...a);
  };
  const events = [];
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.scrape !== 'function') throw new Error('module does not export scrape(ctx)');
    const ctx = makeCtx({ log, now, horizonDays });
    const raw = await withTimeout(Promise.resolve().then(() => mod.scrape(ctx)), SOURCE_TIMEOUT_MS, `source ${src.id}`);
    if (!Array.isArray(raw)) throw new Error('scrape() did not return an array');
    rep.raw = raw.length;
    for (const r of raw) {
      const { event, reason } = normaliseRaw(r, src.id);
      if (!event) {
        rep.invalid++;
        if (rep.invalidSamples.length < 5) rep.invalidSamples.push(reason);
        continue;
      }
      event.sourceName = src.name;
      events.push(event);
    }
    rep.valid = events.length;
    if (!events.length) rep.status = 'empty';
  } catch (err) {
    rep.status = err.code === 'ETIMEOUT' ? 'timeout' : 'failed';
    rep.error = String(err?.message || err).slice(0, 300);
    console.log(`[${src.id}] ${rep.status.toUpperCase()}: ${rep.error}`);
  }
  rep.durationMs = Date.now() - started;
  console.log(`[${src.id}] ${rep.status} — ${rep.raw} raw, ${rep.valid} valid, ${rep.invalid} invalid (${(rep.durationMs / 1000).toFixed(1)} s)`);
  return { rep, events };
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const sourcesDir = args.sourcesDir || join(ROOT, 'scraper', 'sources');
  const outDir = args.outDir || join(ROOT, 'site', 'data');
  const placesFile = args.placesFile || join(ROOT, 'config', 'places.yml');
  const cacheFile = args.cacheFile || join(ROOT, 'scraper', '.cache', 'classify.json');
  const eventsPath = join(outDir, 'events.json');

  const settings = (await loadYaml(join(ROOT, 'config', 'settings.yml'), {})) || {};
  const sourcesDoc = (await loadYaml(join(ROOT, 'config', 'sources.yml'), { sources: [] })) || {};
  const horizonDays = Number(settings.horizonDays) || 75;
  const now = new Date();
  const today = bogotaDate(now);
  const previous = await loadJson(eventsPath, null);
  const prevEvents = Array.isArray(previous?.events) ? previous.events : [];

  console.log(`Totoya pipeline — today ${today} (Bogotá), horizon ${horizonDays} days, AI ${args.ai ? 'on' : 'off'}${args.dry ? ', DRY RUN' : ''}`);

  // ---- 1. scrape
  const report = { generatedAt: null, today, horizonDays, flags: { only: args.only ? [...args.only] : null, ai: args.ai, dry: args.dry }, sources: {} };
  const toRun = [];
  for (const src of sourcesDoc.sources || []) {
    if (!src?.id) continue;
    if (src.enabled === false) {
      report.sources[src.id] = { name: src.name, status: 'disabled' };
    } else if (args.only && !args.only.has(src.id)) {
      report.sources[src.id] = { name: src.name, status: 'not-run' };
    } else {
      toRun.push(src);
    }
  }
  if (args.only) {
    for (const id of args.only) if (!(sourcesDoc.sources || []).some((s) => s.id === id)) console.warn(`--only: unknown source id "${id}"`);
  }
  const results = await mapLimit(toRun, CONCURRENCY, (src) => runSource(src, { sourcesDir, now, horizonDays }));
  let scraped = [];
  results.forEach(({ rep, events }, i) => {
    report.sources[toRun[i].id] = rep;
    scraped.push(...events);
  });

  // ---- 2. horizon + dedupe + ids
  const beforeHorizon = scraped.length;
  scraped = scraped.filter((ev) => inHorizon(ev, today, horizonDays));
  const outOfHorizon = beforeHorizon - scraped.length;
  const dd = dedupe(scraped);
  scraped = assignIds(dd.events);
  console.log(`normalise: ${beforeHorizon} valid → ${outOfHorizon} outside horizon, ${dd.dropped} duplicates → ${scraped.length} to classify`);

  // ---- 3. classify
  const cls = await classifyEvents(scraped, {
    useAi: args.ai,
    ollamaSettings: settings.ollama || {},
    cachePath: cacheFile,
    writeCache: !args.dry,
    log: console.log,
  });
  const kept = [];
  const dropped = [];
  scraped.forEach((ev, i) => {
    const c = cls.results[i];
    const srcRep = report.sources[ev.source];
    if (c.keep) {
      kept.push(toEvent(ev, c));
      srcRep.kept = (srcRep.kept || 0) + 1;
    } else {
      dropped.push({ source: ev.source, title: ev.title, start: ev.start, reason: c.reason, by: c.method });
      srcRep.dropped = (srcRep.dropped || 0) + 1;
    }
  });
  console.log(`classify (${cls.classifier}): ${kept.length} kept, ${dropped.length} dropped; ai=${cls.stats.ai} cache=${cls.stats.cacheHits} keywords=${cls.stats.keywords}`);

  // ---- 4. carry over previous events for sources that failed / returned nothing / weren't run
  const ids = new Set(kept.map((e) => e.id));
  const carried = [];
  for (const [id, rep] of Object.entries(report.sources)) {
    if (!CARRY_OVER.has(rep.status)) continue;
    const prev = prevEvents.filter((e) => e.source === id && (e.end || e.start || '').slice(0, 10) >= today && !ids.has(e.id));
    if (prev.length) {
      rep.carriedOver = prev.length;
      carried.push(...prev);
      prev.forEach((e) => ids.add(e.id));
      console.log(`[${id}] ${rep.status}: keeping ${prev.length} upcoming events from the previous run`);
    }
  }

  // ---- 5. places + recurring
  let placesDoc = { places: [] };
  let placesError = null;
  try {
    placesDoc = await loadYaml(placesFile, { places: [] });
  } catch (err) {
    // A typo in places.yml must not stop the weekly update: keep the previous places instead.
    placesError = `places.yml could not be read: ${String(err.message).split('\n')[0]}`;
    console.warn(placesError);
    placesDoc = { places: [] };
  }
  const pl = buildPlaces(placesDoc, today, horizonDays);
  if (placesError) {
    pl.errors.unshift(placesError);
    if (Array.isArray(previous?.places)) pl.places = previous.places;
    const prevRecurring = prevEvents.filter((e) => e.source === 'lugares' && (e.end || e.start || '').slice(0, 10) >= today);
    pl.events = prevRecurring;
  }
  if (pl.errors.length) console.warn('places.yml problems:', pl.errors);
  const recurring = pl.events.filter((e) => !ids.has(e.id));
  report.sources.lugares = { name: 'config/places.yml', status: placesError ? 'failed' : 'ok', places: pl.places.length, recurringEvents: recurring.length, errors: pl.errors };

  // ---- 6. write
  const events = sortEvents([...kept, ...carried, ...recurring]);
  const generatedAt = new Date().toISOString();
  const file = { generatedAt, classifier: cls.classifier, events, places: pl.places };
  report.generatedAt = generatedAt;
  report.classifier = cls.classifier;
  report.classification = cls.stats;
  report.totals = {
    scrapedValid: beforeHorizon,
    outOfHorizon,
    duplicates: dd.dropped,
    classified: scraped.length,
    kept: kept.length,
    dropped: dropped.length,
    carriedOver: carried.length,
    recurring: recurring.length,
    events: events.length,
    places: pl.places.length,
  };
  report.dropped = dropped.slice(0, 300);
  report.durationMs = Date.now() - t0;

  const summaryRows = Object.entries(report.sources).map(([id, r]) => ({
    id,
    status: r.status,
    raw: r.raw ?? '',
    valid: r.valid ?? '',
    kept: r.kept ?? '',
    dropped: r.dropped ?? '',
    carried: r.carriedOver ?? '',
    error: r.error ? r.error.slice(0, 60) : '',
  }));
  console.table(summaryRows);
  console.log(`events.json: ${events.length} events (${kept.length} new, ${carried.length} carried over, ${recurring.length} recurring), ${pl.places.length} places, classifier=${cls.classifier}`);

  if (args.dry) {
    console.log('dry run — nothing written');
    return;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify(file, null, 1)}\n`, 'utf8');
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  console.log(`wrote ${eventsPath} and report.json in ${(report.durationMs / 1000).toFixed(1)} s`);
}

main()
  .then(() => process.exit(0)) // exit even if a timed-out scraper left sockets/timers open
  .catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
