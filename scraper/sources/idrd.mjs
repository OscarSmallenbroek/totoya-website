// IDRD — Instituto Distrital de Recreación y Deporte (https://www.idrd.gov.co), Drupal 10.
// Two server-rendered sources:
//  1. /eventos — the official events list (few items, e.g. "Vacaciones Recreativas"); each card has
//     a date or range ("05 al 10 de Octubre") and "Hora: 8:30 a. m.".
//  2. /recreacion/actividad-fisica-y-deporte/persona-mayor — free weekly "Actividad física persona
//     mayor" sessions in parks, listed per localidad (Escenario, Dirección, Horario, Días). These have
//     no dates, so each session is emitted once with start = its next occurrence and the weekly
//     schedule in the description (single date, no end — the weekly scrape moves it forward).
import * as cheerio from 'cheerio';
import {
  addDaysYmd, bogotaToday, cleanTitle, foldEs, htmlToText,
  overlapsHorizon, parseDateRangeEs, parseTimeEs, toBogota,
} from './_dates-es.mjs';

const BASE = 'https://www.idrd.gov.co';
const EVENTS_URL = `${BASE}/eventos`;
const SENIOR_URL = `${BASE}/recreacion/actividad-fisica-y-deporte/persona-mayor`;
const CHILDREN_ONLY = /vacaciones recreativas|infantil|ni[ñn]os|escolar|primera infancia/i;

const WEEKDAYS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

function parseEvents(html, ctx) {
  const $ = cheerio.load(html);
  const out = [];
  $('.cajas_listas_eve').each((_, el) => {
    const c = $(el);
    const a = c.find('.titulos a[href^="/eventos/"]').first();
    const title = cleanTitle(a.text());
    const href = a.attr('href');
    if (!title || !href) return;
    if (CHILDREN_ONLY.test(title)) return;
    const when = cleanTitle(c.find('.views-field-created').text());
    const range = parseDateRangeEs(when, ctx.now);
    if (!range) { ctx.log('skip (no date):', title, when); return; }
    const time = parseTimeEs((when.match(/hora:?\s*(.+)$/i) || [])[1]);
    const img = c.find('img').first().attr('src');
    const ev = {
      source: 'idrd',
      title,
      url: new URL(href, BASE).href,
      start: time ? `${range.start}T${time}` : range.start,
      description: htmlToText(c.find('.px-3.pb-5').html() || '', 1500) || undefined,
      image: img ? new URL(img, BASE).href : undefined,
      tags: ['Evento IDRD'],
    };
    if (range.end !== range.start) ev.end = range.end;
    if (overlapsHorizon(ctx, ev.start, ev.end)) out.push(ev);
  });
  return out;
}

// Next date (>= today) falling on weekday; if it is today but the time already passed, next week.
function nextOccurrence(fromYmd, weekday, time, nowLocal) {
  const [y, m, d] = fromYmd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let delta = (weekday - dow + 7) % 7;
  if (delta === 0 && time && nowLocal.slice(11, 16) > time) delta = 7;
  return addDaysYmd(fromYmd, delta);
}

// "PARQUE LA LUISITA" -> "Parque la Luisita" (keeps short codes like CEFE upper-case).
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s(\-/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Cefe|Jal|Ii|Iii)\b/g, (w) => w.toUpperCase())
    .replace(/ (De|Del|La|Las|Los|Y|En)\b/g, (w) => w.toLowerCase());
}

function parseSeniorSessions(html, ctx) {
  const $ = cheerio.load(html);
  const today = bogotaToday(ctx.now);
  const nowLocal = toBogota(ctx.now);
  const seen = new Set();
  const out = [];
  $('h3.js-views-accordion-group-header').each((_, h) => {
    const localidad = cleanTitle($(h).text());
    $(h).parent().find('.bordecards').each((_, card) => {
      const text = htmlToText($(card).html(), 2000);
      const get = (label) => cleanTitle((text.match(new RegExp(`${label}:\\s*([^\\n]+)`, 'i')) || [])[1] || '');
      const escenario = titleCase(get('Escenario').replace(/^P\d{3,5}-/, ''));
      const direccion = get('Direcci[óo]n').replace(/[\s.]+S$/, '');
      const horario = get('Horario');
      const dias = get('D[íi]as');
      const actividad = get('Actividad');
      if (!escenario || !dias) return;
      const key = `${escenario}|${horario}|${dias}`;
      if (seen.has(key)) return;
      seen.add(key);
      const time = parseTimeEs(horario.replace(/(\d{1,2}:\d{2}):\d{2}/, '$1'));
      const dayNames = foldEs(dias).split(/[,\sy]+/).filter((x) => x in WEEKDAYS);
      if (!dayNames.length) return;
      const next = dayNames.map((n) => nextOccurrence(today, WEEKDAYS[n], time, nowLocal)).sort()[0];
      const diasTxt = dayNames.map((n) => ({ miercoles: 'miércoles', sabado: 'sábado' }[n] || n)).join(' y ');
      const timeTxt = time ? ` a las ${time}` : '';
      out.push({
        source: 'idrd',
        title: `Actividad física para persona mayor — ${escenario} (${localidad})`,
        url: SENIOR_URL,
        start: time ? `${next}T${time}` : next,
        venueName: escenario,
        address: direccion ? `${direccion}, ${localidad}, Bogotá` : undefined,
        priceText: 'Gratis',
        description:
          `Sesión semanal gratuita de actividad física para personas mayores de 60 años (programa Bogotá en Forma del IDRD), ` +
          `todos los ${diasTxt}${timeTxt}, en ${escenario}, localidad ${localidad}. ` +
          `Actividad: ${actividad || 'Persona Mayor'}. Más información con la gestora de persona mayor del IDRD.`,
        tags: ['Persona mayor', 'Actividad física', 'Recurrente semanal'],
      });
    });
  });
  return out;
}

export async function scrape(ctx) {
  const events = [];
  let ok = 0;
  try {
    events.push(...parseEvents(await ctx.fetchText(EVENTS_URL), ctx));
    ok++;
  } catch (err) {
    ctx.log('eventos page failed:', err.message);
  }
  try {
    const sessions = parseSeniorSessions(await ctx.fetchText(SENIOR_URL), ctx);
    if (!sessions.length) ctx.log('persona-mayor page: no sessions parsed (layout changed?)');
    events.push(...sessions);
    ok++;
  } catch (err) {
    ctx.log('persona-mayor page failed:', err.message);
  }
  if (!ok) throw new Error('idrd: both pages failed');
  return events;
}
