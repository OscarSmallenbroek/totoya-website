// Banco de la República — Red Cultural (Biblioteca Luis Ángel Arango, Museo del Oro, Museo Botero,
// MAMU, Casa de Moneda…). The public site (Angular) reads an Elasticsearch-backed JSON API on
// admin.banrepcultural.org; we query it filtered by city = Bogotá.
//   https://admin.banrepcultural.org/api/search?term=Bogotá&type=node_category_activity&fields=city&page=<offset>
// Results are sorted by start date; `page` is an offset in steps of 12. Each occurrence of a
// recurring activity is its own row (sometimes duplicated) — we dedupe on path+date+hour.
import { cleanTitle, htmlToText, horizonWindow, overlapsHorizon, parseTimeEs, addDaysYmd } from './_dates-es.mjs';

const SOURCE = 'banrep';
const API = 'https://admin.banrepcultural.org/api/search';
const SITE = 'https://www.banrepcultural.org';
const PAGE_STEP = 12;
const MAX_PAGES = 60;

// Addresses of the Bogotá venues (Candelaria cultural block).
const ADDRESSES = [
  [/luis [aá]ngel arango|blaa/i, 'Calle 11 # 4-14, La Candelaria, Bogotá'],
  [/museo del oro/i, 'Carrera 6 # 15-88, Bogotá'],
  [/museo botero/i, 'Calle 11 # 4-41, La Candelaria, Bogotá'],
  [/casa de moneda/i, 'Calle 11 # 4-93, La Candelaria, Bogotá'],
  [/miguel urrutia|mamu/i, 'Calle 11 # 4-21, La Candelaria, Bogotá'],
];

function buildUrl(offset) {
  const q = new URLSearchParams({ term: 'Bogotá', type: 'node_category_activity', fields: 'city' });
  if (offset) q.set('page', String(offset));
  return `${API}?${q}`;
}

function splitHours(hour) {
  if (!hour) return [null, null];
  const parts = String(hour).split(/\s*[-–]\s*/);
  return [parseTimeEs(parts[0]), parts[1] ? parseTimeEs(parts[1]) : null];
}

function toEvent(a, ctx) {
  const title = cleanTitle(a.title);
  if (!title) return { skip: 'no title' };
  if (a.city && !/bogot/i.test(a.city)) return { skip: `city ${a.city}` };
  if (a.modality && /virtual|en l[ií]nea/i.test(a.modality)) return { skip: `virtual (${title})` };
  const date = (a.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { skip: `bad date "${a.date}" (${title})` };
  let dateEnd = (a.date_end || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) dateEnd = date;

  const isExhibition = /exposici/i.test(a.category || '');
  // Permanent collections belong in config/places.yml, not in the calendar.
  if (isExhibition && (/permanente/i.test(a.subcategory || '') || /exposici[oó]n permanente/i.test(title) || dateEnd > addDaysYmd(date, 3 * 365))) {
    return { skip: `permanent exhibition (${title})` };
  }

  const [h1, h2] = splitHours(a.hour);
  let start = date;
  let end;
  if (isExhibition || dateEnd !== date) {
    end = dateEnd !== date ? dateEnd : undefined;
    if (h1 && !end) start = `${date}T${h1}`;
  } else {
    if (h1) start = `${date}T${h1}`;
    if (h1 && h2 && h2 > h1) end = `${date}T${h2}`;
  }
  if (!overlapsHorizon(ctx, start, end)) return { skip: null };

  const path = a.path_external || a.path || '';
  const url = /^https?:\/\//.test(path) ? path : path ? SITE + (path.startsWith('/') ? '' : '/') + path : `${SITE}/bogota/actividades`;
  const place = String(a.city_place || '').replace(/^Bogot[aá],\s*/i, '').trim();
  const venueName = place || 'Banco de la República, Bogotá';
  const address = ADDRESSES.find(([re]) => re.test(place))?.[1];
  const tags = [
    a.category,
    ...String(a.subcategory || '').split(','),
    a.area,
    ...String(a.public || '').split(','),
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  const descParts = [a.subtitle, a.abstract || a.summary || a.body].map((s) => htmlToText(s, 1400)).filter(Boolean);

  const ev = { source: SOURCE, title, url, start };
  if (end) ev.end = end;
  ev.venueName = venueName;
  if (address) ev.address = address;
  const price = cleanTitle(a.price_label || a.price || '');
  if (price) ev.priceText = price;
  if (descParts.length) ev.description = htmlToText(descParts.join('\n'), 1500);
  if (tags.length) ev.tags = [...new Set(tags)];
  if (a.image?.src) ev.image = a.image.src.startsWith('http') ? a.image.src : `${SITE}${a.image.src}`;
  return { ev };
}

export async function scrape(ctx) {
  const { to } = horizonWindow(ctx);
  const seen = new Set();
  const events = [];
  let total = Infinity;
  let pages = 0;
  let skipped = 0;

  for (let offset = 0; offset < total && pages < MAX_PAGES; offset += PAGE_STEP, pages++) {
    let data;
    try {
      data = await ctx.fetchJson(buildUrl(offset));
    } catch (err) {
      if (pages === 0) throw err; // whole source down
      ctx.log(`page offset ${offset} failed: ${err.message}; stopping`);
      break;
    }
    const rows = data?.nodes?.activity || [];
    total = Number(data?.pagination?.activity?.total) || total;
    if (!rows.length) break;

    let allBeyond = true;
    for (const a of rows) {
      if ((a.date || '') <= to) allBeyond = false;
      const key = `${a.path}|${a.date}|${a.hour}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const r = toEvent(a, ctx);
        if (r.ev) events.push(r.ev);
        else if (r.skip) {
          skipped++;
          if (!/^permanent/.test(r.skip)) ctx.log(`skip: ${r.skip}`);
        }
      } catch (err) {
        ctx.log(`skip item "${a?.title}": ${err.message}`);
      }
    }
    // Rows are sorted by start date: once a whole page starts after the horizon, stop.
    if (allBeyond) break;
  }
  ctx.log(`${events.length} events from ${pages} API pages (${skipped} skipped)`);
  return events;
}
