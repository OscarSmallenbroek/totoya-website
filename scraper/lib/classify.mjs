// Classification stage: cache → Ollama (batched) → keyword fallback, then light consistency fixes.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { classifyKeywords } from './keywords.mjs';
import { createOllamaClassifier } from './ollama.mjs';
import { sha1, loadJson, daysBetween } from './util.mjs';

// Bump when the prompt/schema changes meaningfully so cached AI answers are refreshed.
export const PROMPT_VERSION = 2;

export function contentHash(ev) {
  return sha1(
    [PROMPT_VERSION, ev.title, ev.description, ev.start, ev.end, ev.venueName, ev.address, ev.priceText, (ev.tags || []).join(',')]
      .map((x) => x ?? '')
      .join('|'),
  ).slice(0, 16);
}

const OFF_TOPIC =
  /\b(idiomas?|conversaci[oó]n en|biblovacaciones|vacaciones recreativas|inteligencia artificial|\bIA\b|migrantes digitales|cocina|reposter[ií]a|[aá]ngeles|sanaci[oó]n|crochet|tejido|lencer[ií]a|excel|word|finanzas|emprendimiento)\b/i;

/** Combine an AI answer with the keyword answer for robustness. */
export function mergeAi(ev, ai, kw) {
  const out = { ...ai, accessibility: { ...ai.accessibility }, price: { ...ai.price } };
  // Hard geographic rule wins even if the model kept it.
  if (!kw.keep && /^Fuera de Bogotá/.test(kw.reason)) {
    out.keep = false;
    out.reason = kw.reason;
  }
  // Only her interests: anything the model couldn't place in an arts category is out.
  if (out.keep && out.category === 'otro') {
    out.keep = false;
    out.reason = 'Categoría "otro": fuera de sus intereses';
  }
  if (!ev.end || daysBetween(ev.start, ev.end) <= 1) out.span = 'single';
  if (out.zone === 'desconocida' && kw.zone !== 'desconocida') out.zone = kw.zone;
  out.nearHome = out.zone === 'norte' && (out.nearHome || kw.nearHome);
  if (!out.summary) out.summary = kw.summary;
  if (!out.price.text) out.price.text = kw.price.text;
  if (!out.accessibility.note) out.accessibility.note = kw.accessibility.note;
  out.forSeniors = out.forSeniors || kw.forSeniors;
  return out;
}

/**
 * @param {object[]} events normalised events (with id)
 * @param {{useAi:boolean, ollamaSettings:object, cachePath:string, log:Function, fetchImpl?:Function, apiKey?:string, delayMs?:number}} opts
 * @returns {Promise<{results: object[], classifier: 'ollama'|'keywords'|'mixed', stats: object}>}
 *   results[i] = classification fields + method ('ollama'|'keywords') + model?
 */
export async function classifyEvents(events, opts) {
  const { useAi, ollamaSettings = {}, cachePath, writeCache = true, log = console.log, fetchImpl, apiKey = process.env.OLLAMA_API_KEY, delayMs } = opts;
  const cache = (cachePath && (await loadJson(cachePath, null))) || { version: PROMPT_VERSION, entries: {} };
  if (!cache.entries) cache.entries = {};
  const kw = events.map((ev) => classifyKeywords(ev));
  const results = new Array(events.length).fill(null);
  const hashes = events.map(contentHash);
  const stats = { total: events.length, cacheHits: 0, ai: 0, keywords: 0, aiEnabled: Boolean(useAi && apiKey), ollama: null };

  // 1) cache hits
  const todo = [];
  events.forEach((ev, i) => {
    const hit = useAi ? cache.entries[ev.id] : null;
    if (hit && hit.h === hashes[i] && hit.result) {
      results[i] = { ...mergeAi(ev, hit.result, kw[i]), method: 'ollama', model: hit.model };
      stats.cacheHits++;
    } else {
      todo.push(i);
    }
  });

  // 2) AI for the rest
  if (stats.aiEnabled && todo.length) {
    const client = createOllamaClassifier(ollamaSettings, { apiKey, fetchImpl, log, ...(delayMs != null ? { delayMs } : {}) });
    log(`classify: ${todo.length} events → ollama (${client.config.model}, batches of ${client.config.batchSize}); ${stats.cacheHits} from cache`);
    const ai = await client.classify(todo.map((i) => events[i]));
    ai.forEach((r, k) => {
      if (!r) return;
      const i = todo[k];
      const { model, ...result } = r;
      cache.entries[events[i].id] = { h: hashes[i], model, at: new Date().toISOString(), result };
      results[i] = { ...mergeAi(events[i], result, kw[i]), method: 'ollama', model };
    });
    stats.ollama = { ...client.stats, errors: client.stats.errors.slice(0, 20) };
  } else if (useAi && !apiKey) {
    log('classify: OLLAMA_API_KEY not set → keyword classifier');
  }

  // 3) keyword fallback
  results.forEach((r, i) => {
    if (!r) results[i] = { ...kw[i], method: 'keywords' };
  });
  // Hard topic blocklist on the title, regardless of classifier (cheap safety net).
  results.forEach((r, i) => {
    if (r.keep && OFF_TOPIC.test(events[i].title)) {
      r.keep = false;
      r.reason = 'Tema fuera de sus intereses';
    }
  });
  for (const r of results) r.method === 'ollama' ? stats.ai++ : stats.keywords++;

  const classifier = stats.ai === 0 ? 'keywords' : stats.keywords === 0 ? 'ollama' : 'mixed';

  // 4) persist cache: keep entries in use plus recent ones (a --only run must not wipe other sources).
  if (cachePath && useAi && writeCache) {
    const live = new Set(events.map((e) => e.id));
    const cutoff = Date.now() - 120 * 86400000;
    const entries = Object.fromEntries(
      Object.entries(cache.entries).filter(([id, e]) => live.has(id) || Date.parse(e.at || 0) > cutoff),
    );
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ version: PROMPT_VERSION, entries }), 'utf8');
  }

  stats.ai -= stats.cacheHits; // stats.ai = fresh AI answers; cacheHits counted separately
  return { results, classifier, stats };
}
