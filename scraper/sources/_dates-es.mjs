// Shared helpers for source scrapers: Spanish date parsing, Bogotá time handling,
// HTML-to-text, horizon checks and a small concurrency limiter.
// All dates are Bogotá local (UTC-5, no DST) as "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm".

export const MONTHS_ES = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

const pad = (n) => String(n).padStart(2, '0');

/** Remove accents and lowercase. */
export function foldEs(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Month number (1-12) from a Spanish month name/abbreviation, or null. */
export function monthFromEs(name) {
  const k = foldEs(name).replace(/\./g, '').trim();
  return MONTHS_ES[k] ?? null;
}

export function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's date in Bogotá as "YYYY-MM-DD". */
export function bogotaToday(now = new Date()) {
  return toBogota(now).slice(0, 10);
}

/** Convert a Date / ISO string with offset (or UTC "Z") to Bogotá local "YYYY-MM-DDTHH:mm". */
export function toBogota(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const b = new Date(d.getTime() - 5 * 3600 * 1000);
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}T${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}

/** Add days to "YYYY-MM-DD". */
export function addDaysYmd(day, n) {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Window [from, to] as "YYYY-MM-DD" strings for ctx. */
export function horizonWindow(ctx) {
  const from = bogotaToday(ctx.now);
  const to = addDaysYmd(from, ctx.horizonDays ?? 75);
  return { from, to };
}

/** True if [start, end] (dates or datetimes) overlaps the ctx horizon window. */
export function overlapsHorizon(ctx, start, end) {
  if (!start) return false;
  const { from, to } = horizonWindow(ctx);
  const s = start.slice(0, 10);
  const e = (end || start).slice(0, 10);
  return s <= to && e >= from;
}

/**
 * Parse a time like "3:00pm", "7:30 p. m.", "19:30", "8 PM", "5:00 p.m." → "HH:mm" or null.
 */
export function parseTimeEs(text) {
  if (!text) return null;
  const t = foldEs(text).replace(/\s+/g, ' ');
  const m = t.match(/\b(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?(?![\d])/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] ? m[3].replace(/[\s.]/g, '') : '';
  if (!m[2] && !ap) return null; // a bare number is not a time
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Pick the year for a day/month without explicit year: the nearest one not far in the past. */
export function inferYear(month, day, now = new Date()) {
  const today = bogotaToday(now);
  const y = Number(today.slice(0, 4));
  const cand = ymd(y, month, day);
  // If more than ~2 months in the past, assume next year.
  return cand < addDaysYmd(today, -60) ? y + 1 : y;
}

/**
 * Parse a single Spanish date from free text. Supports:
 *  "18 de octubre de 2026", "sábado 18 de octubre", "18 oct 2026", "oct 18", "octubre 18, 2026",
 *  "18/10/2026", "2026-10-18", "18.10.2026".
 * Returns "YYYY-MM-DD" or null. If no year is given, `inferYear` is used.
 */
export function parseDateEs(text, now = new Date()) {
  if (!text) return null;
  const t = foldEs(text);
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  if ((m = t.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/))) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  const monthRe = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept|sep|set|oct|nov|dic)\\.?';
  // "18 de octubre de 2026" / "18 oct 2026" / "18 de octubre"
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:o|º)?\\s*(?:de\\s+)?${monthRe}(?:\\s*(?:de|del|,)?\\s*(\\d{4}))?`)))) {
    const d = Number(m[1]);
    const mo = monthFromEs(m[2]);
    const y = m[3] ? Number(m[3]) : inferYear(mo, d, now);
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  // "octubre 18, 2026" / "oct 18"
  if ((m = t.match(new RegExp(`\\b${monthRe}\\s+(\\d{1,2})\\b(?:,?\\s*(\\d{4}))?`)))) {
    const mo = monthFromEs(m[1]);
    const d = Number(m[2]);
    const y = m[3] ? Number(m[3]) : inferYear(mo, d, now);
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  return null;
}

/**
 * Parse a Spanish date range. Supports:
 *  "Del 3 de septiembre al 30 de noviembre de 2026", "3 al 30 de noviembre", "9 y 10 de octubre de 2026",
 *  "13.08.2026 — 11.01.2027", "18 de octubre de 2026 - 5 de enero de 2027".
 * Returns { start, end } ("YYYY-MM-DD"; end may equal start) or null.
 */
export function parseDateRangeEs(text, now = new Date()) {
  if (!text) return null;
  const t = foldEs(text).replace(/\s+/g, ' ');
  const monthRe = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sept|sep|set|oct|nov|dic)\\.?';
  let m;
  // Numeric: dd.mm.yyyy – dd.mm.yyyy (or with /)
  if ((m = t.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s*(?:-|–|—|al|a|hasta)\s*(\d{1,2})[/.](\d{1,2})[/.](\d{4})/))) {
    const a = [Number(m[3]), Number(m[2]), Number(m[1])];
    const b = [Number(m[6]), Number(m[5]), Number(m[4])];
    if (validYmd(...a) && validYmd(...b)) return { start: ymd(...a), end: ymd(...b) };
  }
  // "3 de septiembre (de 2026)? al 30 de noviembre (de 2026)?"
  const full = new RegExp(
    `(\\d{1,2})\\s*(?:de\\s+)?${monthRe}(?:\\s*(?:de|del)?\\s*(\\d{4}))?\\s*(?:-|–|—|al|a|hasta(?: el)?)\\s*(?:el\\s+)?(\\d{1,2})\\s*(?:de\\s+)?${monthRe}(?:\\s*(?:de|del)?\\s*(\\d{4}))?`,
  );
  if ((m = t.match(full))) {
    const d1 = Number(m[1]); const mo1 = monthFromEs(m[2]);
    const d2 = Number(m[4]); const mo2 = monthFromEs(m[5]);
    let y2 = m[6] ? Number(m[6]) : null;
    let y1 = m[3] ? Number(m[3]) : null;
    if (!y2) y2 = y1 ?? inferYear(mo2, d2, now);
    if (!y1) y1 = mo1 > mo2 ? y2 - 1 : y2;
    if (validYmd(y1, mo1, d1) && validYmd(y2, mo2, d2)) return { start: ymd(y1, mo1, d1), end: ymd(y2, mo2, d2) };
  }
  // "3 al 30 de noviembre (de 2026)?" / "9 y 10 de octubre" / "9, 10 y 11 de octubre"
  const sameMonth = new RegExp(`(\\d{1,2})\\s*(?:(?:,\\s*\\d{1,2}\\s*)*(?:-|–|—|al|a|y)\\s*)(\\d{1,2})\\s*(?:de\\s+)?${monthRe}(?:\\s*(?:de|del)?\\s*(\\d{4}))?`);
  if ((m = t.match(sameMonth))) {
    const d1 = Number(m[1]); const d2 = Number(m[2]); const mo = monthFromEs(m[3]);
    const y = m[4] ? Number(m[4]) : inferYear(mo, d1, now);
    if (validYmd(y, mo, d1) && validYmd(y, mo, d2) && d2 >= d1) return { start: ymd(y, mo, d1), end: ymd(y, mo, d2) };
  }
  const single = parseDateEs(t, now);
  return single ? { start: single, end: single } : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', deg: '°' };

/** Decode HTML entities (named common ones + numeric). */
export function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const k = n.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      // accented letters: &aacute; &ntilde; etc.
      const acc = k.match(/^([a-z])(acute|grave|tilde|uml|circ)$/);
      if (acc) {
        const mark = { acute: '́', grave: '̀', tilde: '̃', uml: '̈', circ: '̂' }[acc[2]];
        const base = n[0];
        return (base + mark).normalize('NFC');
      }
      return m;
    });
}

/** HTML → plain text (keeps paragraph breaks as newlines), trimmed to maxLen. */
export function htmlToText(html, maxLen = 1500) {
  let s = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\/?[a-z_]+[^\]]*\]/gi, ' '); // WP shortcodes
  s = decodeHtml(s)
    .replace(/[​­]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** Clean a title: decode entities, strip zero-width chars, collapse whitespace. */
export function cleanTitle(s) {
  return decodeHtml(String(s ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/[​­]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Run fn over items with at most `limit` in flight. Rejections are returned as { error }. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (error) {
        out[idx] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
