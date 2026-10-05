// Colsubsidio — cultural agenda of Teatro Colsubsidio (Calle 26 # 25-40, Bogotá).
//
// colsubsidio.com itself is a Next.js + headless Drupal site whose "eventos recreativos" page holds
// only a hand-edited block (one family event per month, in clubs). The theatre's own site
// (teatrocolsubsidio.com) is behind Incapsula (HTTP 403 for scripts), and the course catalogue
// (diversioncolsubsidio.com, API PUT /v1/catalogo/explorar) is behind a Cloudflare challenge that
// blocks Node's fetch. So we use the theatre's ticketing venue page on Tuboleta (Drupal 11,
// server-rendered, no bot wall):
//   listing: https://www.tuboleta.com/es/venue/teatro-colsubsidio  (cards with "dd Mon" dates)
//   detail:  https://www.tuboleta.com/es/eventos/<slug> — each performance has
//            data-date="Sáb, 07/11/2026 - 15:30", a .location block with the venue name, and a
//            price table ("Precio + Servicio" / "Total"); JSON-LD Event gives description + image.
//
// `scrapeTuboletaVenue` is shared with cafam.mjs (Teatro Cafam is on the same ticketing site).
import * as cheerio from 'cheerio';
import { cleanTitle, foldEs, htmlToText, inferYear, mapLimit, monthFromEs, overlapsHorizon, toBogota, ymd } from './_dates-es.mjs';

const TUBOLETA = 'https://www.tuboleta.com';
const MAX_DETAILS = 60;
const SKIP_TITLE = /primaria|bachillerato|colegio|grado|ceremonia|infantil|dinosaurios|rockcito/i;

function parseVenueListing(html, now) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a.content-link-container[href^="/es/eventos/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (seen.has(href)) return;
    seen.add(href);
    const spans = a.find('.content-info span').map((_, s) => cleanTitle($(s).text())).get().filter(Boolean);
    const dates = a.find('.content-date').map((_, d) => {
      const txt = cleanTitle($(d).find('.d-md-none').first().text()); // "20 Dic"
      const m = txt.match(/(\d{1,2})\s+(\p{L}+)/u);
      if (!m) return null;
      const mo = monthFromEs(m[2]);
      const day = Number(m[1]);
      return mo ? ymd(inferYear(mo, day, now), mo, day) : null;
    }).get().filter(Boolean);
    const img = a.find('img').first().attr('src');
    out.push({
      url: TUBOLETA + href,
      title: spans[0] || '',
      venue: spans[1] || '',
      start: dates[0] || null,
      end: dates[1] || dates[0] || null,
      image: img ? new URL(img, TUBOLETA).href : undefined,
    });
  });
  return out;
}

function priceRange($) {
  const totals = [];
  $('table').each((_, t) => {
    const head = cleanTitle($(t).find('thead').text());
    if (!/total/i.test(head)) return;
    $(t).find('tbody tr').each((_, tr) => {
      const last = cleanTitle($(tr).find('td').last().text());
      const n = Number(last.replace(/[^\d]/g, ''));
      if (n > 0) totals.push(n);
    });
  });
  if (!totals.length) return undefined;
  const fmt = (n) => `$${n.toLocaleString('es-CO').replace(/,/g, '.')}`;
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  return min === max ? `${fmt(min)} (incluye servicio)` : `${fmt(min)} – ${fmt(max)} (incluye servicio)`;
}

function parseEventDetail(html, venueRe) {
  const $ = cheerio.load(html);
  let ld = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).contents().text());
      const ev = (j['@graph'] || [j]).find((x) => x['@type'] === 'Event');
      if (ev) ld = ev;
    } catch { /* ignore */ }
  });
  const perfs = new Set();
  $('[data-date]').each((_, el) => {
    const loc = cleanTitle($(el).find('.location').text());
    if (venueRe && loc && !venueRe.test(foldEs(loc))) return;
    const m = String($(el).attr('data-date')).match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})/);
    if (m) perfs.add(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`);
  });
  const title = cleanTitle($('h1 .field--name-title').first().text() || $('h1').first().text());
  return {
    title: title || undefined,
    performances: [...perfs].sort(),
    priceText: priceRange($),
    description: ld?.description ? htmlToText(ld.description, 1500) : undefined,
    image: ld?.image?.url ? String(ld.image.url).replace(/^http:/, 'https:') : undefined,
  };
}

/**
 * Scrape a Tuboleta venue page. One RawEvent per performance in the horizon.
 * @param ctx scraper ctx
 * @param {{source:string, venueSlug:string, venueName:string, address?:string, venueMatch:RegExp}} opts
 */
export async function scrapeTuboletaVenue(ctx, { source, venueSlug, venueName, address, venueMatch }) {
  const listUrl = `${TUBOLETA}/es/venue/${venueSlug}`;
  const cards = parseVenueListing(await ctx.fetchText(listUrl), ctx.now);
  if (!cards.length) throw new Error(`${source}: no event cards on ${listUrl} (layout changed?)`);
  const kept = cards.filter((c) => c.title && c.start && !SKIP_TITLE.test(c.title) && overlapsHorizon(ctx, c.start, c.end));
  const details = await mapLimit(kept.slice(0, MAX_DETAILS), 3, async (c) => parseEventDetail(await ctx.fetchText(c.url), venueMatch));
  const nowLocal = toBogota(ctx.now);
  const events = [];
  kept.forEach((c, i) => {
    const d = details[i] && !details[i].error ? details[i] : null;
    if (details[i]?.error) ctx.log('detail failed:', c.url, details[i].error.message);
    // Tuboleta titles are often ALL CAPS on cards; the detail <h1> has the proper casing.
    const title = d?.title || c.title;
    const starts = d?.performances?.length ? d.performances : [c.start];
    for (const start of starts) {
      if (!overlapsHorizon(ctx, start)) continue;
      if (start.length > 10 && start < nowLocal) continue;
      events.push({
        source,
        title,
        url: c.url,
        start,
        venueName,
        address,
        priceText: d?.priceText,
        description: d?.description,
        tags: ['Teatro', 'Boletería Tuboleta'],
        image: d?.image || c.image,
      });
    }
  });
  return events;
}

export async function scrape(ctx) {
  return scrapeTuboletaVenue(ctx, {
    source: 'colsubsidio',
    venueSlug: 'teatro-colsubsidio',
    venueName: 'Teatro Colsubsidio Roberto Arias Pérez',
    address: 'Calle 26 # 25-40, Bogotá',
    venueMatch: /colsubsidio/,
  });
}
