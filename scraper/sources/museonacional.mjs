// Museo Nacional de Colombia. The site is SharePoint 2013; its "Calendario de actividades"
// (/Paginas/eventos-museo.aspx) is a calendar list readable anonymously over the SharePoint REST API:
//   https://www.museonacional.gov.co/_api/web/lists(guid'651EE9E0-E630-4032-8104-8944595E7FDB')/items
// Times are UTC; recurring series (fRecurrence) carry RecurrenceData XML that we expand (weekly/daily).
// Temporary exhibitions live in another list (exposiciones/ "ListaExposiciones"), which is not kept
// very current — we include its entries when they overlap the horizon.
import {
  cleanTitle, htmlToText, horizonWindow, overlapsHorizon, toBogota, addDaysYmd,
} from './_dates-es.mjs';

const SOURCE = 'museonacional';
const BASE = 'https://www.museonacional.gov.co';
const EVENTS_LIST = `${BASE}/_api/web/lists(guid'651EE9E0-E630-4032-8104-8944595E7FDB')/items`;
const EXPO_LIST = `${BASE}/exposiciones/_api/web/lists(guid'db5c5d93-69c7-4eea-88c5-8227433ee67c')/items`;
const VENUE = 'Museo Nacional de Colombia';
const ADDRESS = 'Carrera 7 # 28-66, Bogotá';
const MAX_OCCURRENCES = 15;
const HEADERS = { Accept: 'application/json;odata=nometadata' };

const DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

// Operational notices that are in the same calendar ("Museo abierto/cerrado al público").
const NOT_EVENT = /^(el\s+)?museo\s+(est[aá]\s+)?(abierto|cerrado)|cerrado al p[uú]blico/i;

function utcIso(ymdStr, hhmm = '05:00') {
  return `${ymdStr}T${hhmm}:00Z`;
}

function priceFromText(text) {
  if (!text) return undefined;
  const line = text.match(/(entrada libre|entrada gratuita|gratis|sin costo)[^\n]*/i);
  if (line) {
    const t = line[0].replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    return (t.length > 80 ? t.slice(0, 80).replace(/\s+\S*$/, '') : t).replace(/^\w/, (c) => c.toUpperCase());
  }
  const m = text.match(/\$\s?\d{1,3}(?:\.\d{3})+/);
  return m ? m[0].replace(/\s/g, '') : undefined;
}

/** Expand a SharePoint recurrence into occurrence start Dates (UTC) within [fromDay, toDay]. */
function expandRecurrence(item, fromDay, toDay) {
  const first = new Date(item.EventDate);
  const xml = item.RecurrenceData || '';
  // End of series: the earliest of windowEnd / EndDate / Fecha_Finalizacion (the editors' real end).
  const ends = [];
  const we = xml.match(/<windowEnd>([^<]+)<\/windowEnd>/);
  if (we) ends.push(new Date(we[1]));
  if (item.EndDate) ends.push(new Date(item.EndDate));
  if (item.Fecha_x0020_Finalizacion && new Date(item.Fecha_x0020_Finalizacion) > first) {
    ends.push(new Date(item.Fecha_x0020_Finalizacion));
  }
  let last = ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null;
  const inst = xml.match(/<repeatInstances>(\d+)<\/repeatInstances>/);
  const maxCount = inst ? Number(inst[1]) : Infinity;
  const hardEnd = new Date(`${toDay}T23:59:00-05:00`);
  if (!last || last > hardEnd) last = hardEnd;
  // Include the whole last day.
  const lastDay = toBogota(last).slice(0, 10);

  const out = [];
  const startLocal = toBogota(first); // "YYYY-MM-DDTHH:mm"
  const time = startLocal.slice(11);
  const firstDay = startLocal.slice(0, 10);
  const pushDay = (day) => {
    if (day >= fromDay && day <= lastDay && day <= toDay) out.push(`${day}T${time}`);
  };

  const weekly = xml.match(/<weekly\s+([^/>]*)\/?>/);
  const daily = xml.match(/<daily\s+([^/>]*)\/?>/);
  let count = 0;
  if (weekly) {
    const attrs = weekly[1];
    const days = DAY_KEYS.map((k) => new RegExp(`\\b${k}="TRUE"`, 'i').test(attrs));
    const freq = Number((attrs.match(/weekFrequency="(\d+)"/) || [])[1] || 1);
    if (!days.some(Boolean)) days[new Date(`${firstDay}T12:00:00Z`).getUTCDay()] = true;
    // Walk day by day from the week of the first occurrence.
    const firstDow = new Date(`${firstDay}T12:00:00Z`).getUTCDay();
    const weekStart = addDaysYmd(firstDay, -firstDow);
    for (let day = firstDay; day <= lastDay && count < maxCount; day = addDaysYmd(day, 1)) {
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      const weekIdx = Math.floor((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / (7 * 864e5));
      if (days[dow] && weekIdx % freq === 0) {
        count++;
        pushDay(day);
      }
      if (out.length >= MAX_OCCURRENCES) break;
    }
  } else if (daily) {
    const freq = Number((daily[1].match(/dayFrequency="(\d+)"/) || [])[1] || 1);
    const weekdayOnly = /weekday="TRUE"/i.test(daily[1]);
    for (let day = firstDay; day <= lastDay && count < maxCount; day = addDaysYmd(day, weekdayOnly ? 1 : freq)) {
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (weekdayOnly && (dow === 0 || dow === 6)) continue;
      count++;
      pushDay(day);
      if (out.length >= MAX_OCCURRENCES) break;
    }
  } else {
    pushDay(firstDay); // monthly/yearly etc.: keep the first occurrence only
  }
  return out;
}

function durationMinutes(item) {
  const a = item.Fecha_x0020_Inicio ? new Date(item.Fecha_x0020_Inicio) : null;
  const b = item.Fecha_x0020_Finalizacion ? new Date(item.Fecha_x0020_Finalizacion) : null;
  if (!a || !b) return null;
  // Use only the time-of-day difference (series store first-start / last-end).
  const ta = a.getUTCHours() * 60 + a.getUTCMinutes();
  const tb = b.getUTCHours() * 60 + b.getUTCMinutes();
  const d = tb - ta;
  return d > 0 && d <= 12 * 60 ? d : null;
}

function addMinutes(localIso, mins) {
  const d = new Date(`${localIso}:00-05:00`);
  return toBogota(new Date(d.getTime() + mins * 60000));
}

async function scrapeCalendar(ctx, from, to) {
  const fromUtc = utcIso(from);
  const toUtc = utcIso(addDaysYmd(to, 1));
  const filter =
    `(EventDate ge datetime'${fromUtc}' and EventDate le datetime'${toUtc}') or ` +
    `(fRecurrence eq 1 and EndDate ge datetime'${fromUtc}' and EventDate le datetime'${toUtc}')`;
  const select = [
    'Id', 'Title', 'EventDate', 'EndDate', 'fAllDayEvent', 'fRecurrence', 'RecurrenceData', 'Description',
    'Category', 'Sala', 'Location', 'Fecha_x0020_Inicio', 'Fecha_x0020_Finalizacion', 'Tipo_x0020_Evento',
  ].join(',');
  const q = new URLSearchParams({ $filter: filter, $select: select, $top: '500', $orderby: 'EventDate' });
  const data = await ctx.fetchJson(`${EVENTS_LIST}?${q}`, { headers: HEADERS });
  const items = data?.value || [];
  const events = [];
  for (const item of items) {
    try {
      const title = cleanTitle(item.Title);
      if (!title || NOT_EVENT.test(title)) continue;
      const url = `${BASE}/Lists/Eventos%20Museo/DispForm.aspx?ID=${item.Id}`;
      const description = htmlToText(item.Description, 1500);
      // The list's "Sala" column is mostly left at its default; the real room is in the text ("Lugar: …").
      const lugar =
        description.match(/Lugar\s*:\s*([^\n]{3,80})/i) ||
        description.match(/^((?:Sala|Salas|Auditorio|Plazoleta|Jard[ií]n|Patio|Terraza|Talleres del Pan[oó]ptico)\b[^\n]{0,70})$/im);
      const sala = lugar ? cleanTitle(lugar[1]).replace(/\s+([:,])/g, '$1') : '';
      const base = {
        source: SOURCE,
        title,
        url,
        venueName: sala ? `${VENUE} — ${sala}` : VENUE,
        address: ADDRESS,
      };
      const price = priceFromText(description);
      if (price) base.priceText = price;
      if (description) base.description = description;
      const tags = [item.Category].map((t) => cleanTitle(t || '')).filter(Boolean);
      if (tags.length) base.tags = tags;

      const dur = durationMinutes(item);
      let starts;
      if (item.fRecurrence) {
        starts = expandRecurrence(item, from, to);
      } else if (item.fAllDayEvent) {
        // All-day events are stored as UTC midnight of the local day.
        starts = [item.EventDate.slice(0, 10)];
      } else {
        starts = [toBogota(item.EventDate)];
      }
      for (const start of starts) {
        const ev = { ...base, start };
        if (!item.fRecurrence && !item.fAllDayEvent && item.EndDate) {
          const end = toBogota(item.EndDate);
          if (end > start) ev.end = end;
        } else if (start.includes('T') && dur) {
          ev.end = addMinutes(start, dur);
        }
        if (overlapsHorizon(ctx, ev.start, ev.end)) events.push(ev);
      }
    } catch (err) {
      ctx.log(`skip calendar item ${item?.Id}: ${err.message}`);
    }
  }
  ctx.log(`calendar: ${items.length} list items → ${events.length} events`);
  return events;
}

async function scrapeExhibitions(ctx, from, to) {
  const q = new URLSearchParams({
    $filter: `ExpFechaFinalExposicion ge datetime'${utcIso(from)}' and ExpFechaInicioExposicion le datetime'${utcIso(addDaysYmd(to, 1))}'`,
    $select: 'Id,ExpTituloExposicion,ExpEntradillaResumen,ExpDescripcionContenido,ExpInstitucion,ExpSalaExhibicion,ExpTarifa,ExpFechaInicioExposicion,ExpFechaFinalExposicion,ExpPublicado',
    $top: '100',
  });
  const data = await ctx.fetchJson(`${EXPO_LIST}?${q}`, { headers: HEADERS });
  const events = [];
  for (const x of data?.value || []) {
    const title = cleanTitle(x.ExpTituloExposicion);
    if (!title || x.ExpPublicado === false) continue;
    if (!/museo nacional/i.test(x.ExpInstitucion || '')) continue; // travelling shows in other cities
    if (/virtual/i.test(`${x.ExpTarifa || ''} ${title}`)) continue;
    const start = toBogota(x.ExpFechaInicioExposicion).slice(0, 10);
    const end = toBogota(x.ExpFechaFinalExposicion).slice(0, 10);
    if (end > addDaysYmd(start, 3 * 365)) continue; // de facto permanent
    const ev = {
      source: SOURCE,
      title,
      url: `${BASE}/exposiciones/temporales/Paginas/default.aspx`,
      start,
      end,
      venueName: x.ExpSalaExhibicion ? `${VENUE} — ${cleanTitle(x.ExpSalaExhibicion)}` : VENUE,
      address: ADDRESS,
      tags: ['Exposición'],
    };
    const desc = htmlToText(`${x.ExpEntradillaResumen || ''}\n${x.ExpDescripcionContenido || ''}`, 1500);
    if (desc) ev.description = desc;
    if (x.ExpTarifa) ev.priceText = cleanTitle(x.ExpTarifa);
    if (overlapsHorizon(ctx, ev.start, ev.end)) events.push(ev);
  }
  ctx.log(`exhibitions list: ${events.length} current`);
  return events;
}

export async function scrape(ctx) {
  const { from, to } = horizonWindow(ctx);
  const events = await scrapeCalendar(ctx, from, to); // throws if the source is down
  try {
    events.push(...(await scrapeExhibitions(ctx, from, to)));
  } catch (err) {
    ctx.log(`exhibitions list failed: ${err.message}`);
  }
  return events;
}
