// Compensar — events and courses are sold through Tienda Compensar (Oracle Commerce Cloud).
// The storefront is JS-rendered, but its public REST API returns full product data:
//   GET https://www.tiendacompensar.com/ccstoreui/v1/products?categoryId=<cat>&limit=250
// Each product has childSKUs; every SKU carries `x_mixed_scenario` (JSON string) with one entry per
// session: { x_headquarter (sede), x_stage2 (sala), x_timeZone (weekday), x_startTime3 "03:00 PM",
// x_endTime3, x_startDate3 "2026-10-17" }, plus `x_level` (segment, e.g. "… adultos 17 años en
// adelante"), per-SKU prices by affiliation category and `active`.
//
// Mapping:
//  - Cultural events (x_typePyS "Cultura" / not a course): one RawEvent per performance date.
//  - Courses (x_typePyS "Curso"): one RawEvent per product + sede, for SKUs (groups) whose first
//    session is still ahead (enrolment open); start = earliest first session, end = last session,
//    schedule (day + time per group) in the description.
// Only Bogotá sedes are kept (Cajicá, Chía/San Roque, Fusagasugá, Soacha, Girardot… are dropped).
import { cleanTitle, horizonWindow, htmlToText, mapLimit, parseTimeEs, toBogota, bogotaToday } from './_dates-es.mjs';

const STORE = 'https://www.tiendacompensar.com';
const API = `${STORE}/ccstoreui/v1`;

// Categories (Oracle CC collection ids). Cultural agenda + persona mayor programmes + art/dance courses.
const CATEGORIES = [
  'agenda-cultural',
  'franja-de-conciertos-clasicos',
  'franja-teatral',
  'en-escena-compensar',
  'programa-adulto-mayor',
  'ad-cursos-adulto-mayor',
  'actividades-adulto-mayor',
  'cursos-de-bienestar-para-adultos-mayores',
  'cursos-para-adulto-mayor-ciclo-VIII',
  'ad-recreacion-adulto-mayor',
  'persona-mayor',
  'planes-y-actividades-generacion-silver',
  'artes',
  'baile',
];
const SENIOR_CATEGORIES = new Set(CATEGORIES.slice(4, 12));

const OUTSIDE_BOGOTA = /cajic|ch[ií]a|san roque|fusa|soacha|girardot|lagosol|melgar|tocancip|zipaquir|facatativ|mosquera|funza|madrid|calera|sop[oó]|tabio|tenjo|\bcota\b|villeta|anapoima|ricaurte|tolima|virtual|online|lagomar|guatavita|universidad de la sabana|puente del com[uú]n|piscilago|pe[ñn]alisa/i;
const CHILD_SEGMENT = /ni[ñn]os|infantil|kids|beb[eé]s|j[oó]venes|adolescent|embarazad|primera infancia|\b\d{1,2}\s*a\s*1[0-7]\s*a[ñn]os/i;
const CHILD_TITLE = /infantil|kids|ni[ñn]os|beb[eé]s|embarazad|vacaciones recreativas|manga|plastilina|rumba kids|ballet para beb/i;

const fmtCOP = (n) => `$${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;

function priceText(sku, product) {
  const p = sku?.listPrices || product.listPrices || {};
  const parts = [];
  if (p.tarifaCategoriaA != null) parts.push(`cat. A ${fmtCOP(p.tarifaCategoriaA)}`);
  if (p.tarifaCategoriaB != null) parts.push(`B ${fmtCOP(p.tarifaCategoriaB)}`);
  if (p.tarifaCategoriaC != null) parts.push(`C ${fmtCOP(p.tarifaCategoriaC)}`);
  const nf = p.tarifaCatNF != null ? `No afiliados ${fmtCOP(p.tarifaCatNF)}` : '';
  if (!parts.length && !nf) return undefined;
  if (Object.values(p).every((v) => v === 0)) return 'Gratis';
  return [parts.length ? `Afiliados ${parts.join(' · ')}` : '', nf].filter(Boolean).join(' · ');
}

function sessionsOf(sku) {
  try {
    const j = JSON.parse(sku.x_mixed_scenario || '{}');
    return (j.mixed_scenario || []).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.x_startDate3 || ''));
  } catch {
    return [];
  }
}

// Venue from the "¿Dónde?" paragraph of the description, e.g.
// "Teatro Mayor Julio Mario Santo Domingo - Avenida Calle 170 No. 67-51 - San José de Bavaria, Bogotá. - 8:00 p.m."
function whereFromDescription(text) {
  const m = String(text || '').match(/¿D[óo]nde\?\s*\n?\s*([^\n]+)/i);
  if (!m) return {};
  let line = m[1].replace(/\s*[-–]\s*\d{1,2}:\d{2}\s*[ap]\.?\s?m\.?.*$/i, '').trim();
  const addr = line.match(/(?:^|[\s/–-])((?:Av(?:enida|\.)?|Calle|Carrera|Cra\.?|Cl\.?|Kr\.?|Transversal|Diagonal|Autopista)\s.+)$/i);
  if (!addr) return { venueName: line.replace(/[\s.]+$/, '') };
  const venueName = line.slice(0, addr.index).replace(/[\s/–-]+$/, '').trim();
  return { venueName: venueName || undefined, address: addr[1].replace(/[\s.]+$/, '') };
}

function hhmm(s) {
  return parseTimeEs(s);
}

function isCourse(p) {
  return /curso/i.test(p.x_typePyS || '') || p.type === 'PySCursos';
}

function sedeName(h) {
  return cleanTitle(String(h || '').replace(/^CBI\s*-\s*/i, ''));
}

async function fetchCategory(ctx, cat) {
  const url = `${API}/products?categoryId=${encodeURIComponent(cat)}&limit=250`;
  const j = await ctx.fetchJson(url, { timeoutMs: 40000 });
  return j.items || [];
}

export async function scrape(ctx) {
  const { from, to } = horizonWindow(ctx);
  const nowLocal = toBogota(ctx.now);
  const today = bogotaToday(ctx.now);

  const products = new Map(); // id → { product, cats:Set }
  const results = await mapLimit(CATEGORIES, 3, async (cat) => ({ cat, items: await fetchCategory(ctx, cat) }));
  let okCats = 0;
  for (const r of results) {
    if (r?.error) { ctx.log('category failed:', r.error.message); continue; }
    okCats++;
    for (const p of r.items) {
      if (!p?.id || p.active === false) continue;
      const e = products.get(p.id) || { product: p, cats: new Set() };
      e.cats.add(r.cat);
      products.set(p.id, e);
    }
  }
  if (!okCats) throw new Error('compensar: all category requests failed');

  const events = [];
  for (const { product: p, cats } of products.values()) {
    const title = cleanTitle(p.displayName);
    if (!title || CHILD_TITLE.test(title) || OUTSIDE_BOGOTA.test(title)) continue;
    const forSeniors = [...cats].some((c) => SENIOR_CATEGORIES.has(c)) || /adulto mayor|persona mayor|generaci[oó]n silver/i.test(title);
    const url = p.route ? STORE + p.route : `${STORE}/producto/${p.id}`;
    const image = p.primaryFullImageURL ? STORE + p.primaryFullImageURL : undefined;
    const baseDesc = htmlToText(p.longDescription || p.description || '', 1200);
    const tags = [p.x_businessLine, p.x_area, p.x_typePyS, forSeniors ? 'Persona mayor' : null].filter(Boolean);
    const skus = (p.childSKUs || []).filter((s) => s && s.active !== false && s.x_available !== false);

    if (!isCourse(p)) {
      // One event per performance.
      const seen = new Set();
      const where = whereFromDescription(htmlToText(p.longDescription || '', 50000));
      for (const sku of skus) {
        if (CHILD_SEGMENT.test(sku.x_level || '') && !/adult|mayor|todo|familia/i.test(sku.x_level || '')) continue;
        for (const s of sessionsOf(sku)) {
          const day = s.x_startDate3;
          if (day < from || day > to) continue;
          const t = hhmm(s.x_startTime3);
          const start = t ? `${day}T${t}` : day;
          if (start.length > 10 && start < nowLocal.slice(0, 16) && day === today) continue;
          if (OUTSIDE_BOGOTA.test(`${s.x_headquarter} ${s.x_stage2} ${where.venueName || ''} ${where.address || ''}`)) continue;
          const key = `${start}|${s.x_headquarter}`;
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({
            source: 'compensar',
            title,
            url,
            start,
            venueName: where.venueName && /externo/i.test(s.x_headquarter || '')
              ? where.venueName
              : `Compensar ${sedeName(s.x_headquarter)}${s.x_stage2 ? ` — ${cleanTitle(s.x_stage2)}` : ''}`,
            address: where.address,
            priceText: priceText(sku, p),
            description: baseDesc || undefined,
            tags,
            image,
          });
        }
      }
      continue;
    }

    // Courses: group upcoming SKUs (groups) by sede.
    const bySede = new Map();
    for (const sku of skus) {
      const level = sku.x_level || sku.displayName || '';
      if (CHILD_SEGMENT.test(level) && !/adult|mayor|todo|familia/i.test(level)) continue;
      const ss = sessionsOf(sku).sort((a, b) => a.x_startDate3.localeCompare(b.x_startDate3));
      if (!ss.length) continue;
      const first = ss[0].x_startDate3;
      const last = ss[ss.length - 1].x_startDate3;
      if (first < today || first > to) continue; // only groups that have not started yet
      const sede = sedeName(ss[0].x_headquarter || sku.x_headquarter);
      if (!sede || OUTSIDE_BOGOTA.test(`${sede} ${ss[0].x_stage2 || ''}`)) continue;
      const g = bySede.get(sede) || { sede, groups: [], sku };
      g.groups.push({
        first, last, n: ss.length,
        day: cleanTitle(ss[0].x_timeZone || sku.x_timeZone || ''),
        t1: hhmm(ss[0].x_startTime3), t2: hhmm(ss[0].x_endTime3),
        level: cleanTitle(level.split(' - ')[0]),
        stage: cleanTitle(ss[0].x_stage2 || ''),
      });
      bySede.set(sede, g);
    }
    for (const g of bySede.values()) {
      g.groups.sort((a, b) => a.first.localeCompare(b.first) || (a.t1 || '').localeCompare(b.t1 || ''));
      const start = g.groups[0].first;
      const end = g.groups.reduce((m, x) => (x.last > m ? x.last : m), start);
      const sched = g.groups.slice(0, 12).map((x) =>
        `${x.day} ${x.t1 || ''}${x.t2 ? `–${x.t2}` : ''} (${x.n} sesiones, desde ${x.first})${x.level ? ` — ${x.level}` : ''}`.replace(/\s+/g, ' ').trim(),
      );
      const desc = `Horarios en ${g.sede}:\n- ${sched.join('\n- ')}${g.groups.length > 12 ? `\n(+${g.groups.length - 12} grupos más)` : ''}\n\n${baseDesc}`;
      const ev = {
        source: 'compensar',
        title: `${title} (Compensar ${g.sede})`,
        url,
        start,
        venueName: `Compensar ${g.sede}`,
        priceText: priceText(g.sku, p),
        description: desc.slice(0, 1500),
        tags: [...new Set([...tags, 'Curso'])],
        image,
      };
      if (end !== start) ev.end = end;
      events.push(ev);
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}
