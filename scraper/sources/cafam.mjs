// Cafam — cultural agenda of Teatro Cafam (Bogotá).
//
// www.cafam.com.co answers HTTP 403 (Radware bot manager / geo-filter) to scripts and even to a real
// browser outside Colombia, so it cannot be scraped from GitHub Actions. Cafam's course shop
// (tiendacafam.com, "Hércules" platform, API PUT /v1/catalogo/explorar with body
// [{"tipo":"clasificacion","valor":"459"}]) is reachable, but its products carry only month-level
// text ("Octubre") — no dates or schedules without a logged-in enrolment wizard — so courses are
// proposed as permanent places instead (see report / config/places.yml).
//
// Dated events come from Teatro Cafam's ticketing page on Tuboleta (same parser as colsubsidio.mjs):
//   https://www.tuboleta.com/es/venue/teatro-cafam
import { scrapeTuboletaVenue } from './colsubsidio.mjs';

export async function scrape(ctx) {
  return scrapeTuboletaVenue(ctx, {
    source: 'cafam',
    venueSlug: 'teatro-cafam',
    venueName: 'Teatro Cafam',
    venueMatch: /cafam/,
  });
}
