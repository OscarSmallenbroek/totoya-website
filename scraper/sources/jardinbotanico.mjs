// Jardín Botánico de Bogotá José Celestino Mutis (jbb.gov.co, WordPress).
// As of 2026-10 the site has NO structured agenda: "Agenda Local" (/eventos-2/eventos/) is empty,
// "Agenda Cultural y Académica" is a static description, there is no events plugin/CPT, no iCal/RSS
// agenda. Upcoming activities are only announced inside news posts ("…se llevará a cabo el sábado
// 26 de septiembre, de 9:00 a. m. …"). So we read recent posts from the WP REST API
//   https://jbb.gov.co/wp-json/wp/v2/posts?after=<30 days ago>
// and keep the ones that announce a future date inside the horizon. Most weeks this yields 0–2
// events; the AI classifier filters further.
import {
  htmlToText, cleanTitle, horizonWindow, addDaysYmd, monthFromEs, inferYear, ymd, foldEs, parseTimeEs,
} from './_dates-es.mjs';

const SOURCE = 'jardinbotanico';
const SITE = 'https://jbb.gov.co';
const VENUE = 'Jardín Botánico de Bogotá';
const ADDRESS = 'Av. Calle 63 # 68-95, Bogotá';
const LOOKBACK_DAYS = 30;

const INVITE = /(se realizar[aá]|se llevar[aá] a cabo|te invitamos|los invitamos|invita a|invitaci[oó]n es|inscr[ií]bete|inscripciones|no te pierdas|ven al jard[ií]n|programaci[oó]n|agenda|tendremos|habr[aá]|participa)/i;
const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

/** Find date mentions (not preceded by "pasado") → [{ start, end, index }]. */
function dateMentions(text, now) {
  const t = foldEs(text);
  const out = [];
  const re = new RegExp(`(?:del?\\s+)?(\\d{1,2})(?:\\s*(?:,|y|al|-)\\s*(\\d{1,2}))?\\s+de\\s+(${MONTHS})(?:\\s+(?:de|del)\\s+(\\d{4}))?`, 'g');
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    if (/pasad[oa]|anterior|desde el/.test(before)) continue;
    const month = monthFromEs(m[3]);
    const d1 = Number(m[1]);
    const d2 = m[2] ? Number(m[2]) : d1;
    const year = m[4] ? Number(m[4]) : inferYear(month, d1, now);
    if (d1 < 1 || d1 > 31 || d2 < d1 || d2 > 31) continue;
    out.push({ start: ymd(year, month, d1), end: ymd(year, month, d2), index: m.index, len: m[0].length });
  }
  return out;
}

export async function scrape(ctx) {
  const { from, to } = horizonWindow(ctx);
  const after = `${addDaysYmd(from, -LOOKBACK_DAYS)}T00:00:00`;
  const before = new Date(ctx.now).toISOString().slice(0, 19);
  const q = new URLSearchParams({ per_page: '40', after, before, _fields: 'date,link,title,content,excerpt,jetpack_featured_media_url' });
  const posts = await ctx.fetchJson(`${SITE}/wp-json/wp/v2/posts?${q}`);
  const events = [];
  for (const p of Array.isArray(posts) ? posts : []) {
    try {
      const title = cleanTitle(p.title?.rendered);
      const text = htmlToText(p.content?.rendered, 20000);
      if (!title || !text || !INVITE.test(text)) continue;
      // Only dates after the post was published are announcements (chronicles talk about the past).
      const published = String(p.date || '').slice(0, 10);
      const mentions = dateMentions(text, ctx.now).filter((d) => d.end >= from && d.start <= to && d.start >= published);
      if (!mentions.length) continue;
      const first = mentions.sort((a, b) => a.start.localeCompare(b.start))[0];
      const lastEnd = mentions.reduce((acc, d) => (d.end > acc ? d.end : acc), first.end);
      // Time near the first mention ("de 9:00 a. m. a 4:00 p. m.", "a las 10:00 a. m.").
      const near = foldEs(text).slice(first.index, first.index + first.len + 60);
      const tm = near.match(/(\d{1,2}(?::\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?))/);
      const time = tm ? parseTimeEs(tm[1]) : null;
      const atGarden = /(en el|al) jard[ií]n bot[aá]nico|sede del jard[ií]n/i.test(text);
      const ev = {
        source: SOURCE,
        title,
        url: p.link,
        start: time ? `${first.start}T${time}` : first.start,
        venueName: atGarden ? VENUE : `${VENUE} (lugar en la noticia)`,
      };
      if (atGarden) ev.address = ADDRESS;
      if (lastEnd > first.start && lastEnd <= addDaysYmd(first.start, 60)) ev.end = lastEnd;
      if (/entrada libre|gratuit|gratis|sin costo/i.test(text)) ev.priceText = 'Entrada libre';
      ev.description = htmlToText(p.content?.rendered, 1500);
      ev.tags = ['Noticia JBB'];
      if (p.jetpack_featured_media_url) ev.image = p.jetpack_featured_media_url;
      events.push(ev);
    } catch (err) {
      ctx.log(`skip post ${p?.link}: ${err.message}`);
    }
  }
  ctx.log(`${events.length} events announced in ${Array.isArray(posts) ? posts.length : 0} recent news posts (jbb.gov.co has no agenda feed)`);
  return events;
}
