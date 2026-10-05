// Teatro Mayor Julio Mario Santo Domingo (Drupal 7). The season listing
//   https://www.teatromayor.org/es/temporada/<year>?page=<n>   (9 functions per page, sorted by date)
// is server-rendered; each card carries an RDFa datetime (content="2026-10-08T20:00:00-05:00"),
// title/link (one link per function: ?function=<id>), section (Música/Danza/Teatro…) and image.
// The page's JSON-LD has the same events but with a broken 12-hour time, so we read the cards.
// Descriptions come from the event detail pages (one fetch per event node, capped).
import { load } from 'cheerio';
import { cleanTitle, htmlToText, horizonWindow, overlapsHorizon, mapLimit, toBogota } from './_dates-es.mjs';

const SOURCE = 'teatromayor';
const SITE = 'https://www.teatromayor.org';
const VENUE = 'Teatro Mayor Julio Mario Santo Domingo';
const ADDRESS = 'Av. Calle 170 # 67-51, Bogotá';
const MAX_PAGES = 15;
const MAX_DETAILS = 60;

function parseListing(html) {
  const $ = load(html);
  const rows = [];
  $('.view-content .views-row').each((_, row) => {
    const r = $(row);
    const a = r.find('.views-field-field-event-title a').first();
    const href = a.attr('href');
    const dt = r.find('.views-field-field-date [content]').first().attr('content') ||
      r.find('[property="dc:date"]').first().attr('content');
    if (!href || !dt) return;
    const srcset = r.find('img').first().attr('srcset') || r.find('source').first().attr('srcset') || '';
    const img = srcset.split(/\s+/)[0] || r.find('img').first().attr('src');
    // The link text/title are cut at ~100 chars ("…de..."); the <picture title> has the full name.
    const titles = [r.find('picture').first().attr('title'), a.attr('title'), a.text()]
      .map((t) => cleanTitle(t || '').replace(/\.{3}$/, '').trim())
      .filter(Boolean)
      .sort((x, y) => y.length - x.length);
    rows.push({
      url: new URL(href, SITE).href,
      title: titles[0] || '',
      status: cleanTitle(r.find('.views-field-field-url-purchase').text()),
      datetime: dt,
      section: cleanTitle(r.find('.views-field-field-event-field-section-name').text()),
      purchase: r.find('.views-field-field-url-purchase a').attr('href') || '',
      image: img ? new URL(img.replace(/&amp;/g, '&'), SITE).href : undefined,
    });
  });
  return rows;
}

async function fetchDetail(ctx, url) {
  const $ = load(await ctx.fetchText(url));
  const body = $('.field-name-eventbody').first().html() || $('.field-name-body').first().html() || '';
  const desc = htmlToText(body, 1500);
  const fields = {};
  $('.field').each((_, f) => {
    const label = cleanTitle($(f).find('.field-label').first().text()).replace(/:$/, '');
    const value = cleanTitle($(f).find('.field-items').first().text());
    if (label && value) fields[label] = value;
  });
  return { desc, fields };
}

export async function scrape(ctx) {
  const { from, to } = horizonWindow(ctx);
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])];
  const rows = [];
  for (const year of years) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${SITE}/es/temporada/${year}${page ? `?page=${page}` : ''}`;
      let html;
      try {
        html = await ctx.fetchText(url);
      } catch (err) {
        if (year === years[0] && page === 0) throw err; // source down
        ctx.log(`${url} failed: ${err.message}`);
        break;
      }
      const pageRows = parseListing(html);
      if (!pageRows.length) break;
      rows.push(...pageRows);
      // Listing is chronological: stop once the whole page is past the horizon.
      if (pageRows.every((r) => toBogota(r.datetime).slice(0, 10) > to)) break;
    }
  }

  // Dedupe functions and keep those in the window.
  const seen = new Set();
  const fns = [];
  for (const r of rows) {
    const start = toBogota(r.datetime);
    if (!start || !r.title || seen.has(r.url) || !overlapsHorizon(ctx, start)) continue;
    if (/cancelad|aplazad/i.test(r.status)) {
      ctx.log(`skip (${r.status}): ${r.title} ${start}`);
      continue;
    }
    seen.add(r.url);
    fns.push({ ...r, start });
  }

  // One detail fetch per event node (functions share it).
  const nodeOf = (u) => u.replace(/[?#].*$/, '');
  const nodes = [...new Set(fns.map((f) => nodeOf(f.url)))].slice(0, MAX_DETAILS);
  const details = new Map();
  const res = await mapLimit(nodes, 3, (u) => fetchDetail(ctx, u));
  res.forEach((r, i) => {
    if (r?.error) ctx.log(`detail ${nodes[i]} failed: ${r.error.message}`);
    else details.set(nodes[i], r);
  });

  const events = fns.map((f) => {
    const d = details.get(nodeOf(f.url));
    const ev = {
      source: SOURCE,
      title: f.title,
      url: f.url,
      start: f.start,
      venueName: VENUE,
      address: ADDRESS,
    };
    // The card's button says "Comprar entradas", "Entrada libre", "Agotado", "Cancelado"…
    if (/entrada libre|gratuit/i.test(f.status)) ev.priceText = 'Entrada libre';
    else if (/agotad/i.test(f.status)) ev.priceText = 'Agotado';
    else if (/tuboleta/i.test(f.purchase) || /comprar/i.test(f.status)) ev.priceText = 'Con boletería (Tuboleta)';
    if (d?.desc) ev.description = d.desc;
    const tags = [f.section, d?.fields?.['Tipo de evento']].filter(Boolean);
    if (tags.length) ev.tags = [...new Set(tags)];
    if (f.image) ev.image = f.image;
    return ev;
  });
  ctx.log(`${events.length} functions from ${rows.length} listing rows, ${details.size} detail pages`);
  return events;
}
