// Deterministic fallback classifier (no network). Produces the same fields as the AI classifier.
import { fold, cleanText, truncate, daysBetween } from './util.mjs';
import { findKnownVenue, findOutsideBogota, zoneFromText, nearHomeFromText } from './venues.mjs';

const has = (hay, words) => words.find((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(hay)) || null;

// Folded keyword lists (no accents). Regex fragments allowed.
const CATEGORY_WORDS = [
  ['danza', ['danza\\w*', 'baile\\w*', 'bailar', 'tango', 'salsa', 'bolero\\w*', 'ballet', 'flamenco', 'cumbia', 'folclor\\w*', 'folklor\\w*', 'vals', 'coreograf\\w*', 'danzon']],
  ['pintura', ['pintura\\w*', 'pintor\\w*', 'pintar', 'acuarela\\w*', 'oleo', 'oleos', 'dibujo\\w*', 'dibujar', 'grabado\\w*', 'ilustracion\\w*', 'retrato\\w*', 'pastel', 'lienzo']],
  ['arte', ['exposicion\\w*', 'muestra', 'museo', 'galeria\\w*', 'arte', 'artes plasticas', 'escultura\\w*', 'fotografia\\w*', 'ceramica', 'curaduria', 'coleccion', 'artesania\\w*', 'bordado\\w*', 'tejido\\w*', 'manualidad\\w*', 'mediacion']],
  ['musica', ['concierto\\w*', 'musica\\w*', 'orquesta\\w*', 'sinfoni\\w*', 'filarmonic\\w*', 'coro\\w*', 'recital\\w*', 'opera', 'zarzuela', 'jazz', 'piano', 'guitarra', 'cantante', 'canto', 'boleros', 'serenata']],
  ['teatro', ['teatro', 'obra de teatro', 'dramaturgi\\w*', 'monologo\\w*', 'titeres', 'clown', 'circo', 'puesta en escena', 'comedia', 'cuenteria', 'narracion oral']],
  ['cine', ['cine', 'pelicula\\w*', 'cinemateca', 'cineforo\\w*', 'proyeccion', 'documental\\w*', 'cortometraje\\w*', 'largometraje\\w*', 'filme', 'film']],
  ['naturaleza', ['jardin\\w*', 'botanic\\w*', 'huerta\\w*', 'orquidea\\w*', 'planta\\w*', 'aves', 'avistamiento', 'parque', 'humedal\\w*', 'flores', 'naturaleza', 'tropicario']],
];

const PARTICIPATE = ['taller\\w*', 'clase\\w*', 'curso\\w*', 'laboratorio\\w*', 'workshop', 'inscripcion\\w*', 'inscribete', 'aprende\\w*', 'practica', 'club de \\w+', 'semillero\\w*', 'escuela de \\w+', 'ensayo abierto', 'actividad fisica'];
const SENIORS = ['persona mayor', 'personas mayores', 'adulto mayor', 'adultos mayores', 'adulta mayor', 'tercera edad', '60\\+', 'mayores de 60', 'mayores de 55', 'vejez', 'envejecimiento', 'abuel\\w*', 'nuevo comienzo', 'canas al aire'];
const FREE = ['gratis', 'gratuit\\w*', 'entrada libre', 'acceso libre', 'libre acceso', 'ingreso libre', 'sin costo', 'entrada liberada', 'free'];
// Things she can't/won't do. Checked in the title (and tags).
const DROP_TITLE = [
  ['caminata\\w*', 'caminata'], ['senderismo', 'senderismo'], ['trekking', 'caminata'], ['running', 'deporte'],
  ['maraton\\w*', 'deporte'], ['media maraton', 'deporte'], ['carrera atletica', 'deporte'], ['carrera \\d+ ?k', 'deporte'],
  ['ciclopaseo\\w*', 'deporte'], ['bicicletada', 'deporte'], ['ciclismo', 'deporte'],
  ['rodada', 'deporte'], ['torneo\\w*', 'deporte'], ['futbol\\w*', 'deporte'], ['campeonato\\w*', 'deporte'],
  ['escalada', 'deporte'], ['triatlon', 'deporte'], ['natacion', 'deporte'],
  ['infantil\\w*', 'infantil'], ['para ninos', 'infantil'], ['para ninas y ninos', 'infantil'], ['ninas y ninos', 'infantil'],
  ['ninos y ninas', 'infantil'], ['primera infancia', 'infantil'], ['bebes', 'infantil'], ['vacaciones recreativas', 'infantil'],
  ['virtual', 'virtual'], ['en linea', 'virtual'], ['online', 'virtual'], ['webinar\\w*', 'virtual'], ['facebook live', 'virtual'],
  ['transmision en vivo', 'virtual'], ['por zoom', 'virtual'], ['podcast', 'virtual'],
  ['congreso\\w*', 'academico'], ['simposio\\w*', 'academico'], ['coloquio\\w*', 'academico'], ['seminario\\w*', 'academico'],
  ['convocatoria\\w*', 'convocatoria'], ['beca\\w*', 'convocatoria'],
];
// Ecological walks are often only clear from the description.
const DROP_DESC = [['caminata ecologica', 'caminata'], ['recorrido de senderismo', 'senderismo'], ['modalidad virtual', 'virtual'], ['solo virtual', 'virtual']];
const ARTS_HINT = ['arte\\w*', 'pintura', 'danza', 'musica', 'teatro', 'cine', 'museo', 'patrimonio', 'cultura\\w*', 'literatura'];

const ATTEND = ['exposicion\\w*', 'concierto\\w*', 'funcion\\w*', 'visita guiada', 'visitas guiadas', 'recorrido guiado', 'conversacion', 'conversatorio\\w*', 'conferencia\\w*', 'charla\\w*', 'proyeccion\\w*', 'presentacion\\w*', 'recital\\w*', 'espectaculo\\w*', 'muestra'];
const KID_TAGS = ['infantil\\w*', 'ninos', 'ninas', 'primera infancia', 'bebes', '\\d{1,2} a \\d{1,2} anos'];
const ADULT_TAGS = ['adulto\\w*', 'persona\\w* mayor\\w*', 'todo publico', 'todos los publicos', 'publico general', 'todas las edades', 'mayores de \\d+'];

/** Source audience tags say only children/teens (no adults at all). */
function kidsOnly(tags) {
  if (!tags || has(tags, ADULT_TAGS)) return false;
  return Boolean(has(tags, KID_TAGS) || has(tags, ['jovenes', 'adolescentes']));
}

const DROP_REASON = {
  caminata: 'Caminata / recorrido largo a pie',
  senderismo: 'Senderismo',
  deporte: 'Actividad deportiva',
  infantil: 'Dirigido a niños',
  virtual: 'Solo virtual',
  academico: 'Evento académico no relacionado con artes',
  convocatoria: 'Convocatoria, no un evento',
};

/**
 * @param {object} ev normalised event (title, description, start, end, venueName, address, priceText, tags, source)
 * @returns classification fields
 */
export function classifyKeywords(ev) {
  const title = fold(ev.title);
  const tags = fold((ev.tags || []).join(' | '));
  const desc = fold(ev.description);
  const all = `${title} | ${tags} | ${desc}`;
  const venueText = [ev.venueName, ev.address].filter(Boolean).join(' | ');

  // --- keep / drop
  let keep = true;
  let reason = 'Coincide con intereses culturales';
  const outside = findOutsideBogota(venueText) || findOutsideBogota(ev.title);
  if (outside) {
    keep = false;
    reason = `Fuera de Bogotá (${outside})`;
  } else {
    // Title: all rules. Tags: everything except audience/virtual words, which sources use loosely
    // (e.g. "Infantil / Jóvenes / Adultos", "Red de Bibliotecas, Biblioteca virtual").
    let hit = DROP_TITLE.find(([w]) => has(title, [w]))
      || DROP_TITLE.find(([w, why]) => why !== 'infantil' && why !== 'virtual' && has(tags, [w]));
    if (!hit && (ev.tags || []).some((t) => /^(virtual|en linea|online|modalidad virtual)$/.test(fold(t)))) hit = ['', 'virtual'];
    if (!hit && kidsOnly(tags)) hit = ['', 'infantil'];
    if (hit && hit[1] === 'virtual' && has(all, ['presencial', 'hibrid\\w*'])) hit = null;
    if (hit && hit[1] === 'academico' && has(title, ARTS_HINT)) hit = null;
    if (hit && hit[1] === 'infantil' && has(title, ['familia\\w*', 'todo publico', 'todas las edades'])) hit = null;
    if (!hit) hit = DROP_DESC.find(([w]) => has(desc, [w]));
    if (hit) {
      keep = false;
      reason = DROP_REASON[hit[1]];
    }
  }

  // --- category (title first, then tags, then description)
  let category = 'otro';
  for (const hay of [title, tags, desc]) {
    const found = pickCategory(hay);
    if (found) {
      category = found;
      break;
    }
  }

  // --- kind
  let kind = 'asistir';
  if (has(title, PARTICIPATE)) kind = 'participar';
  else if (has(title, ATTEND)) kind = 'asistir';
  else if (has(tags, ATTEND)) kind = 'asistir';
  else if (has(tags, PARTICIPATE)) kind = 'participar';

  // --- span
  const span = ev.end && daysBetween(ev.start, ev.end) > 3 ? 'range' : 'single';

  // --- venue / zone
  const known = findKnownVenue(ev.venueName, ev.address) || (!ev.venueName && !ev.address ? findKnownVenue(ev.title) : null);
  const zone = known ? known.zone : zoneFromText(ev.venueName, ev.address);
  const nearHome = nearHomeFromText(zone, ev.venueName, ev.address);

  // --- price
  const priceRaw = cleanText(ev.priceText, 120);
  const priceFold = fold(priceRaw);
  let free = Boolean(has(priceFold, FREE));
  if (!priceRaw && has(`${title} | ${desc}`, FREE)) free = true;
  if (/\$\s?\d/.test(priceRaw) && !/\$\s?0\b/.test(priceRaw) && !has(priceFold, ['gratis', 'gratuit\\w*'])) free = false;
  const priceText = priceRaw || (free ? 'Gratis' : 'Consultar precio');

  // --- seniors
  // A source tag "Adultos mayores" next to "Infantil / Jóvenes" just means "everyone": not aimed at her.
  const forSeniors = Boolean(has(`${title} | ${desc}`, SENIORS) || (has(tags, SENIORS) && !has(tags, KID_TAGS) && !has(tags, ['jovenes'])));

  // --- accessibility
  const accessibility = accessibilityFor({ known, kind, category, span, venueText });

  // --- summary
  const summary = makeSummary(ev, category);

  return { keep, reason, kind, category, span, summary, zone, nearHome, price: { free, text: priceText }, accessibility, forSeniors };
}

function firstIndex(hay, words) {
  let best = -1;
  for (const w of words) {
    const m = new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).exec(hay);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

// Pintura and danza (her favourites, and the most specific) win; otherwise the earliest keyword wins,
// so "Concierto en el Museo Nacional" is música and "Exposición de fotografía" is arte.
function pickCategory(hay) {
  if (!hay) return null;
  const hits = CATEGORY_WORDS.map(([cat, words]) => [cat, firstIndex(hay, words)]).filter(([, i]) => i >= 0);
  if (!hits.length) return null;
  for (const fav of ['pintura', 'danza']) if (hits.some(([c]) => c === fav)) return fav;
  hits.sort((a, b) => a[1] - b[1]);
  return hits[0][0];
}

function accessibilityFor({ known, kind, category, span, venueText }) {
  if (known?.a11y) return { ...known.a11y };
  const v = fold(venueText);
  const seated = /\b(teatro|auditorio|sala|cine|cinemateca|teatrino)\b/.test(v);
  if (seated && kind === 'asistir') {
    return { walking: 'poca', seating: true, wheelchair: 'desconocido', note: 'Función con sillas; accesibilidad del lugar sin confirmar: conviene llamar antes.' };
  }
  if (kind === 'participar') {
    return { walking: 'desconocida', seating: null, wheelchair: 'desconocido', note: 'Taller o clase: preguntar al inscribirse por sillas y acceso sin escaleras.' };
  }
  if (span === 'range' || category === 'arte' || category === 'pintura') {
    return { walking: 'desconocida', seating: null, wheelchair: 'desconocido', note: 'Exposición: se recorre de pie; preguntar por bancas y ascensor.' };
  }
  return { walking: 'desconocida', seating: null, wheelchair: 'desconocido', note: 'Accesibilidad sin confirmar: conviene llamar antes.' };
}

const CAT_LABEL = {
  arte: 'Arte', pintura: 'Pintura', danza: 'Danza', musica: 'Música', teatro: 'Teatro', cine: 'Cine', naturaleza: 'Naturaleza', otro: 'Plan',
};

function makeSummary(ev, category) {
  const desc = cleanText(ev.description).replace(/\n+/g, ' ');
  if (desc.length >= 40) {
    // First one or two sentences.
    const sentences = desc.match(/[^.!?]+[.!?]+/g) || [desc];
    let s = sentences[0].trim();
    if (s.length < 90 && sentences[1]) s = `${s} ${sentences[1].trim()}`;
    return truncate(s, 220);
  }
  const where = ev.venueName ? ` en ${ev.venueName}` : '';
  return truncate(`${CAT_LABEL[category]}: ${ev.title}${where}.`, 220);
}
