// BibloRed — Bibliotecas Públicas de Bogotá (https://www.biblored.gov.co/eventos), Drupal 10.
// The /eventos view is server-rendered, 10 rows per page, and only lists the next ~1–2 weeks
// (≈100 events). Each row has the date (the listing's time part is a placeholder, always 12:00Z),
// title, short description, library name and a "franja" tag. The exact start time ("Hora"),
// audience ("Dirigido a") and long description are on the detail page (/programate/<slug>).
//
// To skip children-only events we query the view once per adult/family audience
// (field_publico_target_id) and merge: 73 = 60+ Personas mayores, 276 = Adultez,
// 158 = Todo público, 159 = Familia, 71 = Juventud. Events tagged only for 0–17 años are not fetched.
import * as cheerio from 'cheerio';
import { cleanTitle, htmlToText, mapLimit, overlapsHorizon, parseDateEs, parseTimeEs } from './_dates-es.mjs';

const BASE = 'https://www.biblored.gov.co';
const AUDIENCES = [
  { id: 73, tag: 'Personas mayores' },
  { id: 276, tag: 'Adultez' },
  { id: 158, tag: 'Todo público' },
  { id: 159, tag: 'Familia' },
  { id: 71, tag: 'Juventud' },
];
const MAX_PAGES_PER_AUDIENCE = 15;
const MAX_DETAILS = 60;
// Libraries the public can't attend (prisons) or that are not a physical venue.
const SKIP_VENUE = /c[áa]rcel|en mi casa|evento virtual/i;

function parseListing(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('.views-row a.event-row').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    const title = cleanTitle(a.find('h6').first().text());
    const dt = a.find('time[datetime^="2"]').first().attr('datetime') || '';
    const date = dt.slice(0, 10);
    const tags = a.find('span.tag-alternative').map((_, s) => cleanTitle($(s).text())).get();
    const img = a.find('img').first().attr('src');
    if (!href || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    rows.push({
      url: new URL(href, BASE).href,
      title,
      date,
      franja: tags[0] || undefined,
      venueName: tags[tags.length - 1] || undefined,
      summary: cleanTitle(a.find('.description').text()) || undefined,
      image: img ? new URL(img, BASE).href : undefined,
    });
  });
  return rows;
}

function parseDetail(html, fallbackDate, now) {
  const $ = cheerio.load(html);
  const labeled = (cls) => {
    const box = $(`.${cls}`).first();
    const vals = box.children('div').slice(1).text();
    return cleanTitle(vals) || undefined;
  };
  const dateText = cleanTitle($('.node-field-field-prfec-datetime').first().text());
  const date = parseDateEs(dateText, now) || fallbackDate;
  const time = parseTimeEs(labeled('node-field-field-hora-ini-list-string'));
  const audience = $('.node-field-field-publico-entity-reference > div').slice(1).find('div')
    .map((_, d) => cleanTitle($(d).text())).get().filter(Boolean);
  const shortDesc = cleanTitle($('.node-field-field-descripcion-corta-string').first().text());
  const longHtml = $('.node-field-field-detalle-text-long').first().html() || '';
  return {
    start: time ? `${date}T${time}` : date,
    venueName: labeled('node-field-field-biblioteca-entity-reference'),
    access: labeled('node-field-field-tipo-de-acceso-entity-reference'),
    audience: [...new Set(audience)],
    description: htmlToText(`${shortDesc ? `<p>${shortDesc}</p>` : ''}${longHtml}`, 1500) || undefined,
  };
}

async function fetchAudience(ctx, aud) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES_PER_AUDIENCE; page++) {
    const url = `${BASE}/eventos?field_publico_target_id=${aud.id}&page=${page}`;
    let html;
    try {
      html = await ctx.fetchText(url);
    } catch (err) {
      ctx.log('listing page failed:', url, err.message);
      break;
    }
    const got = parseListing(html);
    if (!got.length) break;
    for (const r of got) rows.push({ ...r, audienceTag: aud.tag });
    if (!html.includes(`page=${page + 1}`)) break;
  }
  return rows;
}

export async function scrape(ctx) {
  const byUrl = new Map();
  let total = 0;
  for (const aud of AUDIENCES) {
    const rows = await fetchAudience(ctx, aud);
    total += rows.length;
    for (const r of rows) {
      const prev = byUrl.get(r.url);
      if (prev) prev.audienceTags.add(r.audienceTag);
      else byUrl.set(r.url, { ...r, audienceTags: new Set([r.audienceTag]) });
    }
  }
  if (!total) throw new Error('biblored: no events found in /eventos listing (layout changed or site down)');

  const items = [...byUrl.values()].filter((r) => {
    if (r.venueName && SKIP_VENUE.test(r.venueName)) return false;
    return overlapsHorizon(ctx, r.date);
  });
  // Detail pages carry the real start time; fetch them for persona-mayor events first.
  items.sort((a, b) => (b.audienceTags.has('Personas mayores') - a.audienceTags.has('Personas mayores')) || a.date.localeCompare(b.date));
  const toDetail = items.slice(0, MAX_DETAILS);
  const details = await mapLimit(toDetail, 3, async (r) => parseDetail(await ctx.fetchText(r.url), r.date, ctx.now));

  const events = [];
  items.forEach((r, i) => {
    const d = i < details.length && !details[i]?.error ? details[i] : null;
    if (i < details.length && details[i]?.error) ctx.log('detail failed:', r.url, details[i].error.message);
    const venueName = d?.venueName || r.venueName;
    if (venueName && SKIP_VENUE.test(venueName)) return;
    const tags = new Set([...(d?.audience?.length ? d.audience : r.audienceTags)]);
    if (r.franja) tags.add(r.franja);
    if (d?.access) tags.add(d.access);
    events.push({
      source: 'biblored',
      title: r.title,
      url: r.url,
      start: d?.start || r.date,
      venueName,
      address: venueName ? `${venueName}, Bogotá` : undefined,
      priceText: d?.access && /cupo|inscrip/i.test(d.access) ? `Gratis (${d.access.toLowerCase()})` : 'Gratis',
      description: (d?.description || r.summary || '').slice(0, 1500) || undefined,
      tags: [...tags],
      image: r.image,
    });
  });
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}
