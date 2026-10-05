// Run: node --test "scraper/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { classifyKeywords } from '../lib/keywords.mjs';
import { normaliseRaw, inHorizon, dedupe, assignIds } from '../lib/normalize.mjs';
import { normDate, cleanText, bogotaDate, addDays, eventId } from '../lib/util.mjs';
import { zoneFromText } from '../lib/venues.mjs';
import { chat, parseChatResponse, createOllamaClassifier, RESPONSE_SCHEMA } from '../lib/ollama.mjs';
import { classifyEvents } from '../lib/classify.mjs';
import { buildPlaces, expandRecurring } from '../lib/places.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- util / normalise
test('normDate handles contract formats and junk', () => {
  assert.equal(normDate('2026-10-12'), '2026-10-12');
  assert.equal(normDate('2026-10-12T19:30'), '2026-10-12T19:30');
  assert.equal(normDate('2026-10-12T19:30:00'), '2026-10-12T19:30');
  assert.equal(normDate('2026-10-13T00:30:00Z'), '2026-10-12T19:30'); // UTC → Bogotá
  assert.equal(normDate('2026-02-30'), null);
  assert.equal(normDate('mañana'), null);
});

test('cleanText strips HTML and entities', () => {
  assert.equal(cleanText('<p>Hola&nbsp;<b>Totoya</b> &amp; familia</p>'), 'Hola Totoya & familia');
});

test('normaliseRaw drops invalid events and trims', () => {
  assert.equal(normaliseRaw({ title: '', url: 'https://x.co', start: '2026-10-10' }, 's').event, null);
  assert.equal(normaliseRaw({ title: 'A', url: 'notaurl', start: '2026-10-10' }, 's').event, null);
  assert.equal(normaliseRaw({ title: 'A', url: 'https://x.co', start: 'pronto' }, 's').event, null);
  const { event } = normaliseRaw({ title: '  <b>Concierto</b> ', url: 'https://x.co/a', start: '2026-10-10T18:00', end: '2026-10-01', description: '<p>x</p>' }, 's');
  assert.deepEqual(event, { source: 's', title: 'Concierto', url: 'https://x.co/a', start: '2026-10-10T18:00', description: 'x' });
});

test('horizon filter and dedupe', () => {
  const today = '2026-10-05';
  assert.equal(inHorizon({ start: '2026-10-01', end: '2026-10-20' }, today, 75), true); // running exhibition
  assert.equal(inHorizon({ start: '2026-10-04' }, today, 75), false);
  assert.equal(inHorizon({ start: addDays(today, 76) }, today, 75), false);
  const a = { source: 'a', title: 'Tango en el parque', url: 'https://a/1', start: '2026-10-10T15:00', venueName: 'Parque' };
  const b = { source: 'b', title: 'TANGO en el Parque!', url: 'https://b/1', start: '2026-10-10', venueName: 'parque', description: 'más info' };
  const { events, dropped } = dedupe([a, b]);
  assert.equal(dropped, 1);
  assert.equal(events.length, 1);
  assignIds(events);
  assert.match(events[0].id, /^[0-9a-f]{12}$/);
  assert.equal(eventId('s', 'u', 'd'), eventId('s', 'u', 'd'));
});

// ---------- keywords
test('keyword classifier: categories, kind, price, seniors, span', () => {
  const k1 = classifyKeywords({ title: 'Taller de acuarela para persona mayor', start: '2026-10-10T10:00', priceText: 'Entrada libre', venueName: 'Biblioteca Julio Mario Santo Domingo' });
  assert.equal(k1.keep, true);
  assert.equal(k1.category, 'pintura');
  assert.equal(k1.kind, 'participar');
  assert.equal(k1.forSeniors, true);
  assert.equal(k1.price.free, true);
  assert.equal(k1.zone, 'norte');
  assert.equal(k1.nearHome, true);

  const k2 = classifyKeywords({ title: 'Exposición: Botero y sus amigos', start: '2026-09-01', end: '2026-12-31', venueName: 'Museo Botero', priceText: '$20.000' });
  assert.equal(k2.category, 'arte');
  assert.equal(k2.span, 'range');
  assert.equal(k2.price.free, false);
  assert.equal(k2.zone, 'centro');
  assert.equal(k2.accessibility.wheelchair, 'parcial');

  assert.equal(classifyKeywords({ title: 'Noche de tango y bolero', start: '2026-10-10T19:00' }).category, 'danza');
  assert.equal(classifyKeywords({ title: 'Concierto en el Museo Nacional', start: '2026-10-10' }).category, 'musica');
});

test('keyword classifier drops hikes, sports, kids, virtual, outside Bogotá', () => {
  assert.equal(classifyKeywords({ title: 'Caminata ecológica por los cerros', start: '2026-10-10' }).keep, false);
  assert.equal(classifyKeywords({ title: 'Carrera 10K de la mujer', start: '2026-10-10' }).keep, false);
  assert.equal(classifyKeywords({ title: 'Taller infantil de títeres', start: '2026-10-10' }).keep, false);
  assert.equal(classifyKeywords({ title: 'Conversatorio virtual sobre pintura', start: '2026-10-10' }).keep, false);
  const out = classifyKeywords({ title: 'Festival de danza', start: '2026-10-10', venueName: 'Parque principal de Chía' });
  assert.equal(out.keep, false);
  assert.match(out.reason, /Fuera de Bogotá/);
  // Audience tags: kids-only drops, mixed audiences don't; "Biblioteca virtual" as a tag isn't "virtual-only".
  assert.equal(classifyKeywords({ title: 'Bestiario amazónico', start: '2026-10-10', tags: ['Taller', 'Infantil', 'Familias'] }).keep, false);
  assert.equal(classifyKeywords({ title: 'Laboratorio', start: '2026-10-10', tags: ['Jóvenes', '13 a 17 años'] }).keep, false);
  const mixed = classifyKeywords({ title: 'Trazos sobre piedra', start: '2026-10-10', tags: ['Exposición', 'Infantil', 'Jóvenes', 'Adultos', 'Adultos mayores'] });
  assert.equal(mixed.keep, true);
  assert.equal(mixed.forSeniors, false);
  assert.equal(classifyKeywords({ title: 'Del daguerrotipo a la fotografía', start: '2026-10-10', tags: ['Conversación', 'Red de Bibliotecas,Biblioteca virtual', 'Adultos'] }).keep, true);
  assert.equal(classifyKeywords({ title: 'Las ausencias', start: '2026-10-10', tags: ['Talleres y clubes', 'Visita guiada', 'Adultos'] }).kind, 'asistir');
  assert.equal(classifyKeywords({ title: 'Entra con confianza en la era de la IA', start: '2026-10-10', tags: ['Talleres y clubes', 'Taller', 'Adultos mayores'] }).forSeniors, true);
  // "Carrera" as an address must not drop.
  assert.equal(classifyKeywords({ title: 'Concierto de boleros', start: '2026-10-10', address: 'Carrera 7 # 28-66' }).keep, true);
});

test('zone from address', () => {
  assert.equal(zoneFromText('Calle 127 # 7-30'), 'norte');
  assert.equal(zoneFromText('Carrera 7 # 116-50'), 'norte');
  assert.equal(zoneFromText('Calle 11 # 4-41'), 'centro');
  assert.equal(zoneFromText('Calle 40 Sur # 20-10'), 'sur');
  assert.equal(zoneFromText('Teusaquillo'), 'centro');
  assert.equal(zoneFromText(''), 'desconocida');
});

// ---------- ollama client (mocked fetch)
const aiItem = (i, extra = {}) => ({
  i, keep: true, reason: 'Exposición de arte', kind: 'asistir', category: 'pintura', span: 'single',
  summary: 'Una muestra de pintura colombiana.', zone: 'centro', nearHome: false, free: true, priceText: 'Entrada libre',
  walking: 'moderada', seating: 'desconocido', wheelchair: 'si', accessNote: 'Ascensor en la entrada.', forSeniors: false, ...extra,
});

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const r = await handler(body, calls.length);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      json: async () => r.json,
      text: async () => (typeof r.json === 'string' ? r.json : JSON.stringify(r.json)),
    };
  };
  fn.calls = calls;
  return fn;
}

test('chat() sends the documented request shape', async () => {
  const f = mockFetch(() => ({ status: 200, json: { message: { role: 'assistant', content: '{"results":[]}' }, done: true } }));
  await chat({ baseUrl: 'https://ollama.com/', apiKey: 'k123', model: 'gemma4:31b', messages: [{ role: 'user', content: 'hi' }], format: RESPONSE_SCHEMA, fetchImpl: f });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://ollama.com/api/chat');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer k123');
  assert.equal(body.stream, false);
  assert.equal(body.model, 'gemma4:31b');
  assert.equal(body.options.temperature, 0);
  assert.deepEqual(body.format, RESPONSE_SCHEMA);
  assert.equal('think' in body, false);
  // gpt-oss gets a low thinking level
  await chat({ baseUrl: 'https://ollama.com', apiKey: 'k', model: 'gpt-oss:20b', messages: [], fetchImpl: f });
  assert.equal(f.calls[1].body.think, 'low');
});

test('parseChatResponse maps items by index and tolerates fences/missing items', () => {
  const content = '```json\n' + JSON.stringify({ results: [aiItem(1, { seating: 'si' }), { i: 0, keep: 'x' }] }) + '\n```';
  const out = parseChatResponse({ message: { content } }, 3);
  assert.equal(out[0], null); // invalid item
  assert.equal(out[1].category, 'pintura');
  assert.equal(out[1].accessibility.seating, true);
  assert.deepEqual(out[1].price, { free: true, text: 'Entrada libre' });
  assert.equal(out[2], null);
  assert.throws(() => parseChatResponse({ error: 'model not found' }, 1), /model not found/);
});

test('classifier falls back: primary error → fallback model; total failure → keywords', async () => {
  const events = Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, title: `Exposición de pintura ${i}`, start: '2026-10-10', url: 'https://x' }));
  // batch 1 (2 events): primary 500, fallback OK. batch 2 (1 event): both fail.
  const f = mockFetch((body, n) => {
    if (n === 1) return { status: 500, json: { error: 'boom' } };
    if (n === 2) return { status: 200, json: { message: { content: JSON.stringify({ results: [aiItem(0), aiItem(1)] }) } } };
    return { status: 502, json: { error: 'cloud model unreachable' } };
  });
  const client = createOllamaClassifier({ model: 'gemma4:31b', fallbackModel: 'gpt-oss:20b', batchSize: 2 }, { apiKey: 'k', fetchImpl: f, log: () => {}, delayMs: 0 });
  const out = await client.classify(events);
  assert.equal(f.calls[0].body.model, 'gemma4:31b');
  assert.equal(f.calls[1].body.model, 'gpt-oss:20b');
  assert.equal(out[0].model, 'gpt-oss:20b');
  assert.equal(out[1].category, 'pintura');
  assert.equal(out[2], null);
  assert.equal(client.stats.failedBatches, 1);

  // via classifyEvents → "mixed", and cache is used on the second run
  const dir = await mkdtemp(join(tmpdir(), 'totoya-'));
  const cachePath = join(dir, 'classify.json');
  const f2 = mockFetch((body) => {
    const n = JSON.parse(body.messages[1].content.split('Eventos:\n')[1]).length;
    if (n === 3) return { status: 200, json: { message: { content: JSON.stringify({ results: [aiItem(0), aiItem(1)] }) } } };
    return { status: 500, json: { error: 'x' } };
  });
  const r1 = await classifyEvents(events, { useAi: true, apiKey: 'k', ollamaSettings: { batchSize: 8, fallbackModel: null }, cachePath, fetchImpl: f2, log: () => {}, delayMs: 0 });
  assert.equal(r1.classifier, 'mixed');
  assert.equal(r1.results[2].method, 'keywords');
  const f3 = mockFetch(() => ({ status: 500, json: { error: 'down' } }));
  const r2 = await classifyEvents(events, { useAi: true, apiKey: 'k', ollamaSettings: { fallbackModel: null }, cachePath, fetchImpl: f3, log: () => {}, delayMs: 0 });
  assert.equal(r2.stats.cacheHits, 2);
  assert.equal(f3.calls.length, 1); // only the uncached event was sent
  assert.equal(JSON.parse(f3.calls[0].body.messages[1].content.split('Eventos:\n')[1]).length, 1);
});

test('classifier stops on 401 and with no key uses keywords', async () => {
  const f = mockFetch(() => ({ status: 401, json: { error: 'unauthorized' } }));
  const events = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, title: `Concierto ${i}`, start: '2026-10-10', url: 'https://x' }));
  const r = await classifyEvents(events, { useAi: true, apiKey: 'bad', ollamaSettings: { batchSize: 5, fallbackModel: 'gpt-oss:20b' }, fetchImpl: f, log: () => {}, delayMs: 0 });
  assert.equal(f.calls.length, 1);
  assert.equal(r.classifier, 'keywords');
  const r2 = await classifyEvents(events, { useAi: true, apiKey: '', log: () => {} });
  assert.equal(r2.classifier, 'keywords');
});

test('429 is retried once after waiting', async () => {
  const f = mockFetch((b, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' }, json: { error: 'rate' } } : { status: 200, json: { message: { content: JSON.stringify({ results: [aiItem(0)] }) } } }));
  const client = createOllamaClassifier({ fallbackModel: null }, { apiKey: 'k', fetchImpl: f, log: () => {}, delayMs: 0 });
  const t = Date.now();
  const out = await client.classify([{ id: 'a', title: 'Expo', start: '2026-10-10', url: 'https://x' }]);
  assert.ok(out[0]);
  assert.equal(f.calls.length, 2);
  assert.ok(Date.now() - t >= 900); // honoured Retry-After: 1
});

// ---------- places
test('places + recurring expansion', () => {
  const today = '2026-10-05'; // Monday
  const doc = {
    places: [
      { id: 'p', name: 'Plaza', zone: 'norte', url: 'https://p', price: { free: true, text: 'Libre' }, accessibility: { walking: 'mucha', seating: true, wheelchair: 'parcial', note: 'n' },
        recurring: [{ title: 'Mercado', weekday: 'domingo', time: '10:00', endTime: '17:00' }] },
    ],
    recurring: [{ title: 'Último domingo', weekday: 'domingo', weeks: ['last'], url: 'https://q', venue: { name: 'Museo', zone: 'centro' } }],
  };
  const { places, events, errors } = buildPlaces(doc, today, 30);
  assert.deepEqual(errors, []);
  assert.equal(places[0].nearHome, true);
  const market = events.filter((e) => e.title === 'Mercado');
  assert.deepEqual(market.map((e) => e.start), ['2026-10-11T10:00', '2026-10-18T10:00', '2026-10-25T10:00', '2026-11-01T10:00']);
  assert.equal(market[0].end, '2026-10-11T17:00');
  const last = events.filter((e) => e.title === 'Último domingo');
  assert.deepEqual(last.map((e) => e.start), ['2026-10-25']);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  assert.equal(expandRecurring({ title: 'x', weekday: 'nunca', url: 'https://x' }, null, today, 10).length, 0);
});

// ---------- end-to-end with fake sources
const EVENT_KEYS = ['id', 'title', 'summary', 'kind', 'category', 'span', 'start', 'evening', 'venue', 'nearHome', 'price', 'accessibility', 'forSeniors', 'url', 'source', 'sourceName'];

test('run.mjs end-to-end with fake sources (--no-ai)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'totoya-run-'));
  const srcDir = join(dir, 'sources');
  const outDir = join(dir, 'data');
  await mkdir(srcDir);
  await mkdir(outDir);
  const today = bogotaDate();
  const d = (n, t = '') => addDays(today, n) + t;
  await writeFile(join(srcDir, 'banrep.mjs'), `
    export async function scrape(ctx) {
      ctx.log('fake banrep');
      return [
        { source: 'banrep', title: 'Taller de acuarela para persona mayor', url: 'https://ex.org/1', start: '${d(3, 'T10:00')}', venueName: 'Museo del Oro', priceText: 'Gratis' },
        { source: 'banrep', title: 'Concierto de boleros', url: 'https://ex.org/2', start: '${d(4, 'T19:00')}', venueName: 'Sala de Conciertos Biblioteca Luis Ángel Arango' },
        { source: 'banrep', title: 'Concierto de boleros', url: 'https://ex.org/2b', start: '${d(4, 'T19:00')}', venueName: 'Sala de Conciertos Biblioteca Luis Ángel Arango', description: 'dup' },
        { source: 'banrep', title: 'Caminata ecológica', url: 'https://ex.org/3', start: '${d(5)}' },
        { source: 'banrep', title: 'Exposición permanente', url: 'https://ex.org/4', start: '${d(-30)}', end: '${d(60)}', venueName: 'Museo Botero' },
        { source: 'banrep', title: 'Muy lejos', url: 'https://ex.org/5', start: '${d(200)}' },
        { title: '', url: 'https://ex.org/6', start: '${d(2)}' },
      ];
    }`);
  await writeFile(join(srcDir, 'mambo.mjs'), `export async function scrape() { throw new Error('site changed'); }`);
  await writeFile(join(srcDir, 'idartes.mjs'), `export async function scrape() { return []; }`);
  const prevEvent = (id, start) => ({ id, title: 'Antiguo', summary: '', kind: 'asistir', category: 'arte', span: 'single', start, evening: false, venue: { name: 'MAMBO', zone: 'centro' }, nearHome: false, price: { free: false, text: '' }, accessibility: { walking: 'desconocida', seating: null, wheelchair: 'desconocido', note: '' }, forSeniors: false, url: 'https://m', source: 'mambo', sourceName: 'MAMBO' });
  await writeFile(join(outDir, 'events.json'), JSON.stringify({ generatedAt: '', classifier: 'keywords', events: [prevEvent('aaaaaaaaaaaa', d(10)), prevEvent('bbbbbbbbbbbb', d(-3))], places: [] }));

  const out = execFileSync(process.execPath, [join(ROOT, 'scraper', 'run.mjs'), '--no-ai', '--only=banrep,mambo,idartes', `--sources-dir=${srcDir}`, `--out-dir=${outDir}`, `--cache=${join(dir, 'c.json')}`], { encoding: 'utf8', env: { ...process.env, OLLAMA_API_KEY: '' } });
  assert.match(out, /mambo\] FAILED: site changed/);
  const file = JSON.parse(await readFile(join(outDir, 'events.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8'));
  assert.equal(file.classifier, 'keywords');
  assert.ok(file.places.length >= 10);
  const titles = file.events.map((e) => e.title);
  assert.ok(titles.includes('Taller de acuarela para persona mayor'));
  assert.equal(titles.filter((t) => t === 'Concierto de boleros').length, 1);
  assert.ok(!titles.includes('Caminata ecológica'));
  assert.ok(!titles.includes('Muy lejos'));
  assert.ok(titles.includes('Exposición permanente'));
  // carry-over: future mambo event kept, past one gone
  assert.ok(file.events.some((e) => e.id === 'aaaaaaaaaaaa'));
  assert.ok(!file.events.some((e) => e.id === 'bbbbbbbbbbbb'));
  // sorted, contract keys present
  const starts = file.events.map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort());
  for (const e of file.events) for (const k of EVENT_KEYS) assert.ok(k in e, `missing ${k} in ${e.title}`);
  const taller = file.events.find((e) => e.title.startsWith('Taller'));
  assert.equal(taller.kind, 'participar');
  assert.equal(taller.forSeniors, true);
  assert.equal(taller.price.free, true);
  assert.equal(file.events.find((e) => e.title === 'Concierto de boleros').evening, true);
  assert.equal(file.events.find((e) => e.title === 'Exposición permanente').span, 'range');
  // report
  assert.equal(report.sources.banrep.status, 'ok');
  assert.equal(report.sources.banrep.invalid, 1);
  assert.equal(report.sources.mambo.status, 'failed');
  assert.equal(report.sources.mambo.carriedOver, 1);
  assert.equal(report.sources.idartes.status, 'empty');
  assert.equal(report.sources.museonacional.status, 'not-run');
  assert.equal(report.totals.duplicates, 1);
  assert.ok(report.dropped.some((x) => x.title === 'Caminata ecológica'));
});
