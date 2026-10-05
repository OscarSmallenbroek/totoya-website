// Idartes agenda (https://www.idartes.gov.co/es/agenda) — Drupal 10, server-rendered.
// The listing page shows every upcoming event (no pager, ~40 cards) with a <time datetime>
// per card. Drupal emits the *local* Bogotá time with a misleading "Z" suffix
// (e.g. datetime="2026-10-14T20:00:00Z" is shown as "8:00 pm"), so we take the digits as-is.
// Detail pages add venue (Escenario), address (Lugar), price type and the description.
import * as cheerio from 'cheerio';
import { cleanTitle, htmlToText, mapLimit, overlapsHorizon } from './_dates-es.mjs';

const BASE = 'https://www.idartes.gov.co';
const LIST_URL = `${BASE}/es/agenda`;
const MAX_DETAILS = 60;

// Card categories that are clearly aimed at children only.
const SKIP_CATEGORIES = /^ni[ñn]os y j[óo]venes$/i;

function localFromDatetimeAttr(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return null;
  return m[2] === '00:00' ? m[1] : `${m[1]}T${m[2]}`;
}

function parseListing(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.item-ev').each((_, el) => {
    const c = $(el);
    const a = c.find('.titulo_cajashomeeventos a').first();
    const href = a.attr('href');
    const title = cleanTitle(a.text());
    if (!href || !title) return;
    const times = c.find('time[datetime]').map((_, t) => localFromDatetimeAttr($(t).attr('datetime'))).get().filter(Boolean);
    const img = c.find('img').first().attr('src');
    out.push({
      url: new URL(href, BASE).href,
      title,
      category: cleanTitle(c.find('.ctg-ev-24').first().text()),
      start: times[0] || null,
      end: times.length > 1 ? times[times.length - 1].slice(0, 10) : undefined,
      priceText: cleanTitle(c.find('.tipo_cajashomeeventos').first().text()) || undefined,
      summary: cleanTitle(c.find('.descripcion_cajashomeeventos').first().text()) || undefined,
      image: img ? new URL(img, BASE).href : undefined,
    });
  });
  return out;
}

function parseDetail(html) {
  const $ = cheerio.load(html);
  const field = (name) => cleanTitle($(`.field--name-${name} .field__item`).first().text()) || undefined;
  const bodyHtml = $('.field--name-field-evento-contenido').html() || $('.field--name-body').first().html() || '';
  const resumen = field('field-event-resumen');
  let description = htmlToText(bodyHtml, 1500);
  if (resumen && !description.startsWith(resumen.slice(0, 40))) description = htmlToText(`${resumen}\n${bodyHtml}`, 1500);
  const buy = $('.field--name-field-link-sitio-de-compra a').attr('href');
  return {
    venueName: field('field-evento-escenario'),
    address: field('field-lugar-del-evento'),
    priceText: field('field-tipo-de-entrada'),
    description: description || undefined,
    buyUrl: buy,
  };
}

export async function scrape(ctx) {
  const html = await ctx.fetchText(LIST_URL);
  const cards = parseListing(html);
  if (!cards.length) throw new Error('idartes: no event cards found on agenda page (layout changed?)');

  const kept = [];
  for (const c of cards) {
    if (!c.start) { ctx.log('skip (no date):', c.title); continue; }
    if (SKIP_CATEGORIES.test(c.category)) continue;
    if (!overlapsHorizon(ctx, c.start, c.end)) continue;
    kept.push(c);
  }

  const details = await mapLimit(kept.slice(0, MAX_DETAILS), 3, async (c) => parseDetail(await ctx.fetchText(c.url)));

  return kept.map((c, i) => {
    const d = details[i] && !details[i].error ? details[i] : {};
    if (details[i]?.error) ctx.log('detail failed:', c.url, details[i].error.message);
    let description = d.description || c.summary;
    if (description && d.buyUrl && description.length < 1400) description += `\nBoletería: ${d.buyUrl}`;
    const ev = {
      source: 'idartes',
      title: c.title,
      url: c.url,
      start: c.start,
      venueName: d.venueName,
      address: d.address ? `${d.address}, Bogotá` : undefined,
      priceText: d.priceText || c.priceText,
      description: description ? description.slice(0, 1500) : undefined,
      tags: c.category ? [c.category] : undefined,
      image: c.image,
    };
    if (c.end && c.end !== c.start.slice(0, 10)) ev.end = c.end;
    return ev;
  });
}
