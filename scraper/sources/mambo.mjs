// MAMBO — Museo de Arte Moderno de Bogotá (WordPress/Divi).
// Exhibitions: listing pages /exposicionesactuales/ and /proximas/ link to /exposicion/<slug>/
// detail pages that carry the run as <div class="expo-date">13.08.2026 <br/>— 11.01.2027</div>.
// Activities: /programacion/ is only a grid of poster images (no text, no links) and the site's
// The Events Calendar API (/wp-json/tribe/events/v1/events) is unused since 2025 — so for now only
// exhibitions are scraped. We still read the tribe API in case they start using it again.
import { load } from 'cheerio';
import {
  cleanTitle, htmlToText, overlapsHorizon, parseDateRangeEs, horizonWindow, mapLimit,
} from './_dates-es.mjs';

const SOURCE = 'mambo';
const SITE = 'https://www.mambogota.com';
const LISTINGS = [`${SITE}/exposicionesactuales/`, `${SITE}/proximas/`];
const VENUE = 'MAMBO — Museo de Arte Moderno de Bogotá';
const ADDRESS = 'Calle 24 # 6-00, Bogotá';
const PRICE = 'Entrada con boleta (consultar tarifas; descuentos para persona mayor)';
const MAX_DETAILS = 30;

async function exhibitionLinks(ctx) {
  const links = new Set();
  let ok = 0;
  for (const url of LISTINGS) {
    try {
      const $ = load(await ctx.fetchText(url));
      ok++;
      $('a[href*="/exposicion/"]').each((_, a) => {
        const href = $(a).attr('href');
        if (href) links.add(new URL(href, SITE).href.replace(/[?#].*$/, ''));
      });
    } catch (err) {
      ctx.log(`listing ${url} failed: ${err.message}`);
    }
  }
  if (!ok) throw new Error('MAMBO exhibition listings unreachable');
  return [...links];
}

async function exhibitionDetail(ctx, url) {
  const html = await ctx.fetchText(url);
  const $ = load(html);
  const dateText = $('.expo-date').first().text() || '';
  const range = parseDateRangeEs(dateText.replace(/\s+/g, ' '), ctx.now);
  const title =
    cleanTitle($('#main-content h1').first().text()) ||
    cleanTitle(($('meta[property="og:title"]').attr('content') || '').replace(/\s*-\s*MAMBO\s*$/i, ''));
  if (!title) return { skip: `no title at ${url}` };
  if (!range) return { skip: `no dates for "${title}" (${dateText.trim() || 'missing .expo-date'})` };

  // Divi text modules; the first one with real prose is the curatorial text.
  const paras = $('#main-content .et_pb_text_inner')
    .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t.length > 80 && !/expo-date/.test(t));
  const description = htmlToText([...new Set(paras)].join('\n'), 1500);
  const ev = {
    source: SOURCE,
    title,
    url,
    start: range.start,
    venueName: VENUE,
    address: ADDRESS,
    priceText: PRICE,
    tags: ['Exposición'],
  };
  if (range.end && range.end !== range.start) ev.end = range.end;
  if (description) ev.description = description;
  const img = $('meta[property="og:image"]').attr('content');
  if (img) ev.image = new URL(img, SITE).href;
  return { ev };
}

// The Events Calendar REST API — empty today, kept so that events show up if MAMBO starts using it.
async function tribeEvents(ctx) {
  const { from, to } = horizonWindow(ctx);
  const q = new URLSearchParams({ start_date: from, end_date: to, per_page: '50' });
  const data = await ctx.fetchJson(`${SITE}/wp-json/tribe/events/v1/events?${q}`);
  return (data?.events || []).map((e) => {
    const ev = {
      source: SOURCE,
      title: cleanTitle(e.title),
      url: e.url,
      start: e.all_day ? e.start_date.slice(0, 10) : e.start_date.slice(0, 16).replace(' ', 'T'),
      venueName: cleanTitle(e.venue?.venue) || VENUE,
      address: ADDRESS,
    };
    const end = e.all_day ? e.end_date.slice(0, 10) : e.end_date.slice(0, 16).replace(' ', 'T');
    if (end > ev.start) ev.end = end;
    if (e.cost) ev.priceText = cleanTitle(e.cost);
    const desc = htmlToText(e.excerpt || e.description, 1500);
    if (desc) ev.description = desc;
    const tags = (e.categories || []).map((c) => cleanTitle(c.name)).filter(Boolean);
    if (tags.length) ev.tags = tags;
    if (e.image?.url) ev.image = new URL(e.image.url, SITE).href;
    return ev;
  });
}

export async function scrape(ctx) {
  const links = (await exhibitionLinks(ctx)).slice(0, MAX_DETAILS);
  const results = await mapLimit(links, 3, (url) => exhibitionDetail(ctx, url));
  const events = [];
  results.forEach((r, i) => {
    if (r?.error) ctx.log(`detail ${links[i]} failed: ${r.error.message}`);
    else if (r?.skip) ctx.log(`skip: ${r.skip}`);
    else if (r?.ev && overlapsHorizon(ctx, r.ev.start, r.ev.end)) events.push(r.ev);
  });
  try {
    const t = await tribeEvents(ctx);
    events.push(...t.filter((e) => e.title && overlapsHorizon(ctx, e.start, e.end)));
  } catch (err) {
    ctx.log(`tribe events API failed: ${err.message}`);
  }
  ctx.log(`${events.length} events (${links.length} exhibition pages); /programacion/ is poster-only, not scraped`);
  return events;
}

