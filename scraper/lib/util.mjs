// Small shared helpers: Bogotá dates, text cleanup, hashing, YAML loading.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const BOGOTA_OFFSET_MS = -5 * 3600 * 1000; // Colombia has no DST

/** "YYYY-MM-DD" of `date` in Bogotá local time. */
export function bogotaDate(date = new Date()) {
  return new Date(date.getTime() + BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Add `days` to a "YYYY-MM-DD" string. */
export function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two "YYYY-MM-DD..." strings (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

/** Weekday 0=Sunday … 6=Saturday of a "YYYY-MM-DD". */
export function weekday(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/;

/**
 * Normalise a RawEvent date to "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm".
 * Accepts the contract formats plus a few lenient variants (seconds, offsets, Date objects).
 * Returns null when it can't be parsed or is not a real calendar date.
 */
export function normDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const local = new Date(value.getTime() + BOGOTA_OFFSET_MS).toISOString();
    return `${local.slice(0, 10)}T${local.slice(11, 16)}`;
  }
  const s = String(value).trim();
  // An explicit offset/Z means an absolute instant -> convert to Bogotá local.
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return normDate(new Date(t));
  }
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const check = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  if (hh == null) return `${y}-${mo}-${d}`;
  const h = Number(hh);
  const mi = Number(mm);
  if (h > 23 || mi > 59) return `${y}-${mo}-${d}`;
  // Midnight with no meaningful time is usually "no time given".
  if (h === 0 && mi === 0) return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${mm}`;
}

export function hasTime(d) {
  return typeof d === 'string' && d.length > 10;
}

/** Start ≥ 18:00 local. */
export function isEvening(start) {
  return hasTime(start) && Number(start.slice(11, 13)) >= 18;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', ordm: 'º', ordf: 'ª', middot: '·',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return all; }
    }
    return ENTITIES[code] ?? all;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
export function cleanText(value, maxLen = Infinity) {
  if (value == null) return '';
  let s = String(value)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t ​]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length > maxLen) s = truncate(s, maxLen);
  return s;
}

/** Cut at a word boundary and add an ellipsis. */
export function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || '';
  const cut = s.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** Lowercase, no accents, alnum + single spaces — for matching and dedupe. */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
}

export function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

export function eventId(source, url, start) {
  return sha1(`${source}|${url}|${start}`).slice(0, 12);
}

export function absUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function loadYaml(path, fallback = null) {
  try {
    return YAML.parse(await readFile(path, 'utf8')) ?? fallback;
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== null) return fallback;
    throw err;
  }
}

export async function loadJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Reject after `ms` with a timeout error (does not cancel the underlying work). */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${Math.round(ms / 1000)} s`);
      e.code = 'ETIMEOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
