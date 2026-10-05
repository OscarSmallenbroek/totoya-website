// config/places.yml → Contract 2 `places` + generated recurring Events.
import { cleanText, truncate, addDays, weekday, absUrl, isEvening, fold } from './util.mjs';
import { assignIds } from './normalize.mjs';

const CATEGORIES = ['arte', 'pintura', 'danza', 'musica', 'teatro', 'cine', 'naturaleza', 'otro'];
const ZONES = ['norte', 'centro', 'occidente', 'sur', 'desconocida'];
const WALKING = ['poca', 'moderada', 'mucha', 'desconocida'];
const WHEELCHAIR = ['si', 'parcial', 'no', 'desconocido'];
const DAY_NAMES = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const PLACES_SOURCE = { id: 'lugares', name: 'Lugares de siempre (selección de la familia)' };

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

function normAccessibility(a = {}) {
  const seating = a.seating === true || a.seating === 'si' ? true : a.seating === false || a.seating === 'no' ? false : null;
  return {
    walking: pick(a.walking, WALKING, 'desconocida'),
    seating,
    wheelchair: pick(a.wheelchair, WHEELCHAIR, 'desconocido'),
    note: truncate(cleanText(a.note), 160),
  };
}

function normPrice(p) {
  if (typeof p === 'string') return { free: /gratis|gratuit|libre/i.test(p), text: p };
  return { free: Boolean(p?.free), text: cleanText(p?.text) || (p?.free ? 'Gratis' : 'Consultar precio') };
}

function slug(s) {
  return fold(s).replace(/ /g, '-').slice(0, 60);
}

export function toPlace(p) {
  const zone = pick(p.zone, ZONES, 'desconocida');
  return {
    id: String(p.id || slug(p.name)),
    name: cleanText(p.name),
    summary: truncate(cleanText(p.summary), 220),
    category: pick(p.category, CATEGORIES, 'otro'),
    address: cleanText(p.address),
    zone,
    nearHome: typeof p.nearHome === 'boolean' ? p.nearHome : zone === 'norte',
    hours: cleanText(p.hours),
    price: normPrice(p.price),
    accessibility: normAccessibility(p.accessibility),
    url: absUrl(p.url) || '',
  };
}

function parseWeekdays(v) {
  const list = Array.isArray(v) ? v : [v];
  return list
    .map((d) => (typeof d === 'number' ? d : DAY_NAMES[fold(d)]))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/** Does `ymd` match the `weeks` rule? weeks: [1..5 | 'last'] (nth weekday of the month). */
function matchesWeeks(ymd, weeks) {
  if (!weeks || !weeks.length) return true;
  const dayOfMonth = Number(ymd.slice(8, 10));
  const nth = Math.ceil(dayOfMonth / 7);
  const isLast = addDays(ymd, 7).slice(0, 7) !== ymd.slice(0, 7);
  return weeks.some((w) => (String(w).toLowerCase() === 'last' || w === 'ultimo' || w === 'último' ? isLast : Number(w) === nth));
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const fmtTime = (t) => {
  const m = HHMM.exec(String(t ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/**
 * Expand one recurring rule into Events between today and today + horizonDays.
 * `place` (optional) provides defaults: venue, zone, price, accessibility, url, category.
 */
export function expandRecurring(rule, place, today, horizonDays) {
  const days = parseWeekdays(rule.weekday ?? rule.weekdays);
  if (!days.length || !rule.title) return [];
  const time = fmtTime(rule.time);
  const endTime = fmtTime(rule.endTime);
  const except = new Set((rule.except || []).map(String));
  const venueName = cleanText(rule.venue?.name) || place?.name || '';
  const zone = pick(rule.venue?.zone ?? place?.zone, ZONES, 'desconocida');
  const url = absUrl(rule.url) || place?.url || '';
  if (!url) return [];
  const accessibility = rule.accessibility ? normAccessibility(rule.accessibility) : place?.accessibility || normAccessibility();
  const price = rule.price ? normPrice(rule.price) : place?.price || { free: false, text: 'Consultar precio' };
  const out = [];
  for (let d = 0; d <= horizonDays; d++) {
    const ymd = addDays(today, d);
    if (rule.from && ymd < String(rule.from)) continue;
    if (rule.until && ymd > String(rule.until)) continue;
    if (except.has(ymd) || !days.includes(weekday(ymd)) || !matchesWeeks(ymd, rule.weeks)) continue;
    const start = time ? `${ymd}T${time}` : ymd;
    const ev = {
      title: cleanText(rule.title),
      summary: truncate(cleanText(rule.summary || place?.summary), 220),
      kind: rule.kind === 'participar' ? 'participar' : 'asistir',
      category: pick(rule.category ?? place?.category, CATEGORIES, 'otro'),
      span: 'single',
      start,
      evening: isEvening(start),
      venue: { name: venueName, ...(cleanText(rule.venue?.address) || place?.address ? { address: cleanText(rule.venue?.address) || place.address } : {}), zone },
      nearHome: typeof rule.nearHome === 'boolean' ? rule.nearHome : place ? place.nearHome : zone === 'norte',
      price,
      accessibility,
      forSeniors: Boolean(rule.forSeniors),
      url,
      source: PLACES_SOURCE.id,
      sourceName: PLACES_SOURCE.name,
    };
    if (time && endTime && endTime > time) ev.end = `${ymd}T${endTime}`;
    out.push(ev);
  }
  return out;
}

/**
 * @param {object} doc parsed places.yml ({ places: [...], recurring: [...] })
 * @returns {{ places: object[], events: object[], errors: string[] }}
 */
export function buildPlaces(doc, today, horizonDays) {
  const places = [];
  const events = [];
  const errors = [];
  for (const p of doc?.places || []) {
    try {
      if (!p?.name) throw new Error('place without name');
      const place = toPlace(p);
      places.push(place);
      for (const rule of p.recurring || []) events.push(...expandRecurring(rule, place, today, horizonDays));
    } catch (err) {
      errors.push(`${p?.id || p?.name || '?'}: ${err.message}`);
    }
  }
  for (const rule of doc?.recurring || []) {
    try {
      events.push(...expandRecurring(rule, null, today, horizonDays));
    } catch (err) {
      errors.push(`recurring ${rule?.title || '?'}: ${err.message}`);
    }
  }
  // Stable ids: sha1(source|url|start), salted with the title on collision.
  assignIds(events);
  // assignIds sets ev.id last; move it first for readability.
  return { places, events: events.map(({ id, ...rest }) => ({ id, ...rest })), errors };
}
