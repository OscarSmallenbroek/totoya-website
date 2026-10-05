// Validate + normalise RawEvents (Contract 1), horizon filter, dedupe, stable ids.
import { cleanText, normDate, absUrl, fold, eventId, sha1, addDays } from './util.mjs';

/**
 * @returns {{ event: object|null, reason?: string }}
 */
export function normaliseRaw(raw, sourceId) {
  if (!raw || typeof raw !== 'object') return { event: null, reason: 'not an object' };
  const title = cleanText(raw.title, 200).replace(/\n+/g, ' ');
  if (!title) return { event: null, reason: 'missing title' };
  const url = absUrl(raw.url);
  if (!url) return { event: null, reason: `missing/invalid url (${title})` };
  const start = normDate(raw.start);
  if (!start) return { event: null, reason: `missing/invalid start "${raw.start}" (${title})` };
  let end = normDate(raw.end);
  if (end && end.slice(0, 10) < start.slice(0, 10)) end = null; // nonsense end
  if (end && end === start) end = null;

  const ev = { source: sourceId, title, url, start };
  if (end) ev.end = end;
  const venueName = cleanText(raw.venueName, 150).replace(/\n+/g, ' ');
  if (venueName) ev.venueName = venueName;
  const address = cleanText(raw.address, 200).replace(/\n+/g, ' ');
  if (address) ev.address = address;
  const priceText = cleanText(raw.priceText, 120).replace(/\n+/g, ' ');
  if (priceText) ev.priceText = priceText;
  const description = cleanText(raw.description, 1500);
  if (description) ev.description = description;
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map((t) => cleanText(t, 60)).filter(Boolean))].slice(0, 12);
    if (tags.length) ev.tags = tags;
  }
  const image = absUrl(raw.image);
  if (image) ev.image = image;
  return { event: ev };
}

/** Keep events overlapping [today, today + horizonDays] (dates compared as Bogotá-local days). */
export function inHorizon(ev, today, horizonDays) {
  const last = addDays(today, horizonDays);
  const s = ev.start.slice(0, 10);
  const e = (ev.end || ev.start).slice(0, 10);
  return s <= last && e >= today;
}

export function dedupeKey(ev) {
  return `${fold(ev.title)}|${ev.start.slice(0, 10)}|${fold(ev.venueName || ev.address || '')}`;
}

const richness = (ev) =>
  (ev.description?.length || 0) + (ev.venueName ? 50 : 0) + (ev.address ? 30 : 0) + (ev.priceText ? 20 : 0) +
  (ev.image ? 10 : 0) + (ev.start.length > 10 ? 40 : 0) + (ev.end ? 10 : 0);

/** Dedupe by normalised title + start date + venue, keeping the richest copy. */
export function dedupe(events) {
  const byKey = new Map();
  let dropped = 0;
  for (const ev of events) {
    const k = dedupeKey(ev);
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, ev);
    else {
      dropped++;
      if (richness(ev) > richness(prev)) byKey.set(k, ev);
    }
  }
  return { events: [...byKey.values()], dropped };
}

/** Assign stable ids; on the rare collision (same source|url|start), salt with the title. */
export function assignIds(events) {
  const seen = new Set();
  for (const ev of events) {
    let id = eventId(ev.source, ev.url, ev.start);
    if (seen.has(id)) id = sha1(`${ev.source}|${ev.url}|${ev.start}|${ev.title}`).slice(0, 12);
    seen.add(id);
    ev.id = id;
  }
  return events;
}

export function sortEvents(events) {
  return events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'es'));
}
