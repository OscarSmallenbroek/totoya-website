// Teatro Colón — since 2025 its programming is published by the "Centro Nacional de las Artes
// Delia Zapata Olivella" (teatrocolon.gov.co 301-redirects to www.eneldelia.gov.co), which covers the
// Teatro Colón and the CNA halls next to it (Sala Delia Zapata, Sala Fanny Mikey, Lab Piso 8…).
// WordPress + The Events Calendar REST API:
//   https://www.eneldelia.gov.co/wp-json/tribe/events/v1/events?start_date=…&end_date=…&per_page=50
// Times are already Bogotá local. The venue isn't set in the API; it's in the description
// ("Lugar: Sala Fanny Mikey"). Multi-day runs list their functions in the description
// ("16 y 17 de octubre de 2026 / Hora: 7:30 p.m. / 18 de octubre de 2026 / Hora: 3:00 p.m.");
// we split those into one event per function when they can be parsed.
import {
  cleanTitle, htmlToText, horizonWindow, overlapsHorizon, parseTimeEs, monthFromEs, inferYear, ymd, foldEs,
} from './_dates-es.mjs';

const SOURCE = 'teatrocolon';
const API = 'https://www.eneldelia.gov.co/wp-json/tribe/events/v1/events';
const SITE = 'https://www.eneldelia.gov.co';
const DEFAULT_VENUE = 'Centro Nacional de las Artes Delia Zapata Olivella (Teatro Colón)';
const COLON_ADDRESS = 'Calle 10 # 5-32, La Candelaria, Bogotá';
const CNA_ADDRESS = 'La Candelaria, Bogotá (junto al Teatro Colón)';
const MAX_PAGES = 10;

// Calls for artists, residencies etc. are not events for the public.
const NOT_EVENT = /^(invitaci[oó]n p[uú]blica|convocatoria|resultados)/i;

function priceFrom(e) {
  if (e.cost) return cleanTitle(e.cost);
  const cats = (e.categories || []).map((c) => foldEs(c.name));
  if (cats.some((c) => c.includes('boleteria'))) return 'Con boletería (Tuboleta)';
  if (cats.some((c) => c.includes('inscripcion previa'))) return 'Entrada libre con inscripción previa';
  if (cats.some((c) => c.includes('entrada libre'))) return 'Entrada libre';
  return undefined;
}

/** Days listed in a line like "9 y 10 de octubre de 2026", "9, 16 y 23 de octubre", "18 de octubre". */
function daysInLine(line, now) {
  const t = foldEs(line);
  const m = t.match(/((?:\d{1,2}\s*(?:,|y|-|al)?\s*)+)de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?/);
  if (!m) return [];
  const month = monthFromEs(m[2]);
  const nums = m[1].match(/\d{1,2}/g).map(Number);
  let days = nums;
  if (/\bal\b|-/.test(m[1]) && nums.length === 2 && nums[1] > nums[0] && nums[1] - nums[0] <= 14) {
    days = Array.from({ length: nums[1] - nums[0] + 1 }, (_, i) => nums[0] + i);
  }
  return days.map((d) => ymd(m[3] ? Number(m[3]) : inferYear(month, d, now), month, d));
}

/** Parse functions (date + time) from the "INFORMACIÓN" block of a description. */
function parseFunctions(text, now) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  let pending = [];
  for (const line of lines) {
    const days = /hora/i.test(line) && !/de\s+\w+/.test(line) ? [] : daysInLine(line, now);
    const timeM = line.match(/hora[s]?\s*:?\s*(.+)$/i);
    if (days.length) {
      // A date line may also carry the time ("17 de octubre - 3:00 p.m.").
      pending = days;
      const tInline = timeM ? parseTimeEs(timeM[1]) : null;
      if (tInline) {
        pending.forEach((d) => out.push(`${d}T${tInline}`));
        pending = [];
      }
    } else if (timeM && pending.length) {
      const t = parseTimeEs(timeM[1]);
      pending.forEach((d) => out.push(t ? `${d}T${t}` : d));
      pending = [];
    }
  }
  pending.forEach((d) => out.push(d));
  return [...new Set(out)].sort();
}

function toEvents(e, ctx) {
  const title = cleanTitle(e.title);
  if (!title) return [];
  if (NOT_EVENT.test(title)) {
    ctx.log(`skip (not a public event): ${title}`);
    return [];
  }
  const description = htmlToText(e.description || e.excerpt, 4000);
  const lugar = description.match(/Lugar\s*:\s*([^\n]{3,80})/i);
  const room = lugar ? cleanTitle(lugar[1]) : '';
  const venueName = !room ? DEFAULT_VENUE : /col[oó]n/i.test(room) ? room : `${room} — ${DEFAULT_VENUE}`;
  const address = /col[oó]n/i.test(venueName) ? COLON_ADDRESS : CNA_ADDRESS;
  const tags = [...(e.categories || []), ...(e.tags || [])]
    .map((c) => cleanTitle(c.name))
    .filter((n) => n && !/^\d{4}$/.test(n));

  const base = { source: SOURCE, title, url: e.url || `${SITE}/eventos-con-boleteria/` };
  base.venueName = venueName;
  base.address = address;
  const price = priceFrom(e);
  if (price) base.priceText = price;
  // Drop the leading button label ("Tuboleta", "Inscripción", "Ver Resultados").
  const short = htmlToText(e.description || e.excerpt, 1600)
    .replace(/^(tuboleta|inscripci[oó]n|ver resultados|comprar[^\n]*)\s*\n/i, '')
    .slice(0, 1500);
  if (short) base.description = short;
  if (tags.length) base.tags = [...new Set(tags)];
  if (e.image?.url) base.image = new URL(e.image.url, SITE).href;

  const startDay = e.start_date.slice(0, 10);
  const endDay = e.end_date.slice(0, 10);
  const startT = e.all_day ? startDay : e.start_date.slice(0, 16).replace(' ', 'T');
  const endT = e.all_day ? endDay : e.end_date.slice(0, 16).replace(' ', 'T');

  if (endDay > startDay) {
    // Several functions: try to split them using the description.
    const fns = parseFunctions(description, ctx.now).filter((s) => s.slice(0, 10) >= startDay && s.slice(0, 10) <= endDay);
    if (fns.length >= 2) return fns.map((start) => ({ ...base, start }));
    return [{ ...base, start: startT, end: endT }];
  }
  const ev = { ...base, start: startT };
  if (endT > startT) ev.end = endT;
  return [ev];
}

export async function scrape(ctx) {
  const { from, to } = horizonWindow(ctx);
  let url = `${API}?${new URLSearchParams({ start_date: from, end_date: `${to} 23:59:59`, per_page: '50' })}`;
  const events = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let data;
    try {
      data = await ctx.fetchJson(url);
    } catch (err) {
      if (page === 0) throw err;
      ctx.log(`page ${page + 1} failed: ${err.message}`);
      break;
    }
    for (const e of data?.events || []) {
      try {
        for (const ev of toEvents(e, ctx)) if (overlapsHorizon(ctx, ev.start, ev.end)) events.push(ev);
      } catch (err) {
        ctx.log(`skip "${e?.title}": ${err.message}`);
      }
    }
    url = data?.next_rest_url || null;
  }
  ctx.log(`${events.length} events`);
  return events;
}
