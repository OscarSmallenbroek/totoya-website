// Known Bogotá venues and zone heuristics, shared by the keyword classifier and the AI prompt.
// Accessibility notes are deliberately cautious: only what we are fairly sure about.
import { fold } from './util.mjs';

/**
 * match: folded substrings tested against venue name + address (+ title as a last resort).
 * a11y: Contract 2 accessibility for a typical visit/performance there.
 */
export const KNOWN_VENUES = [
  {
    match: ['museo del oro'],
    zone: 'centro',
    a11y: { walking: 'moderada', seating: null, wheelchair: 'si', note: 'Museo con rampa y ascensor a las salas (3 pisos); se recorre de pie, hay pocas bancas.' },
  },
  {
    match: ['museo botero', 'miguel urrutia', 'mamu', 'casa de moneda', 'luis angel arango', 'complejo cultural banrep', 'banco de la republica'],
    zone: 'centro',
    a11y: { walking: 'moderada', seating: null, wheelchair: 'parcial', note: 'Museos del Banco de la República en La Candelaria: salas a pie; calles empinadas alrededor. Conviene llegar en taxi.' },
  },
  {
    match: ['museo nacional'],
    zone: 'centro',
    a11y: { walking: 'moderada', seating: null, wheelchair: 'parcial', note: 'Edificio histórico de 3 pisos; preguntar por ascensor en la entrada. Recorrido a pie por las salas.' },
  },
  {
    match: ['mambo', 'museo de arte moderno de bogota'],
    zone: 'centro',
    a11y: { walking: 'moderada', seating: null, wheelchair: 'parcial', note: 'Museo de varios niveles con rampas; preguntar por ascensor. Recorrido a pie.' },
  },
  {
    match: ['santa clara', 'museo colonial'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: null, wheelchair: 'parcial', note: 'Edificio colonial: recorrido corto en un piso; puede haber escalones en la entrada.' },
  },
  {
    match: ['teatro colon'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: true, wheelchair: 'parcial', note: 'Teatro histórico con escaleras; ofrece servicio de accesibilidad: avisar al comprar la boleta.' },
  },
  {
    match: ['teatro mayor', 'julio mario santo domingo'],
    zone: 'norte',
    a11y: { walking: 'poca', seating: true, wheelchair: 'si', note: 'Teatro moderno con ascensores y espacios para silla de ruedas; parqueadero en el mismo complejo.' },
  },
  {
    match: ['jorge eliecer gaitan'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: true, wheelchair: 'parcial', note: 'Teatro con butacas; consultar ubicación accesible al comprar la boleta.' },
  },
  {
    match: ['planetario'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: true, wheelchair: 'parcial', note: 'Funciones en el domo con silla reclinable; consultar acceso para silla de ruedas.' },
  },
  {
    match: ['cinemateca'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: true, wheelchair: 'si', note: 'Edificio nuevo con ascensores; salas de cine con butacas.' },
  },
  {
    match: ['jardin botanico', 'tropicario'],
    zone: 'occidente',
    a11y: { walking: 'mucha', seating: true, wheelchair: 'si', note: 'Senderos planos y pavimentados con bancas; es grande: mejor en silla de ruedas y con acompañante.' },
  },
  {
    match: ['virgilio barco'],
    zone: 'occidente',
    a11y: { walking: 'moderada', seating: true, wheelchair: 'si', note: 'Biblioteca con rampas y espacios amplios; el parqueadero queda algo retirado de la entrada.' },
  },
  {
    match: ['biblioteca el tintal', 'biblioteca tintal', 'manuel zapata olivella'],
    zone: 'occidente',
    a11y: { walking: 'poca', seating: true, wheelchair: 'si', note: 'Biblioteca con rampas y ascensor.' },
  },
  {
    match: ['biblioteca el tunal', 'gabriel garcia marquez'],
    zone: 'sur',
    a11y: { walking: 'poca', seating: true, wheelchair: 'si', note: 'Biblioteca con rampas y ascensor.' },
  },
  {
    match: ['biblioteca julio mario santo domingo'],
    zone: 'norte',
    a11y: { walking: 'poca', seating: true, wheelchair: 'si', note: 'Biblioteca moderna con ascensores, junto al Teatro Mayor.' },
  },
  {
    match: ['teatro colsubsidio', 'roberto arias perez'],
    zone: 'centro',
    a11y: { walking: 'poca', seating: true, wheelchair: 'parcial', note: 'Teatro con butacas; consultar ubicación accesible.' },
  },
  {
    match: ['teatro cafam'],
    zone: 'occidente',
    a11y: { walking: 'poca', seating: true, wheelchair: 'parcial', note: 'Teatro con butacas; consultar ubicación accesible.' },
  },
  {
    match: ['usaquen'],
    zone: 'norte',
    a11y: null,
  },
];

const ZONE_WORDS = {
  norte: [
    'usaquen', 'bella suiza', 'santa barbara', 'cedritos', 'toberin', 'country', 'chico', 'rosales', 'chapinero',
    'unicentro', 'andino', 'parque de la 93', 'parque 93', 'zona t', 'zona rosa', 'santa ana', 'la carolina',
    'san patricio', 'suba', 'colina campestre', 'niza', 'mazuren', 'calle 100', 'calle 116', 'calle 127',
    'pepe sierra', 'la calleja', 'contador', 'el retiro', 'nogal', 'quinta camacho', 'pasadena', 'cedro golf',
  ],
  centro: [
    'candelaria', 'centro historico', 'centro internacional', 'teusaquillo', 'santa fe', 'santafe', 'macarena',
    'las nieves', 'la soledad', 'palermo', 'parkway', 'chapinero centro', 'plaza de bolivar',
    'eje ambiental', 'las aguas', 'la merced', 'samper mendoza', 'veracruz',
  ],
  occidente: [
    'engativa', 'fontibon', 'salitre', 'modelia', 'tintal', 'simon bolivar', 'ciudad salitre', 'normandia',
    'barrios unidos', 'el campin', 'la floresta', 'titan plaza', 'gran estacion', 'hayuelos', 'av 68', 'avenida 68',
    'alamos', 'minuto de dios', 'quirigua',
  ],
  sur: [
    'kennedy', 'bosa', 'tunal', 'tunjuelito', 'usme', 'ciudad bolivar', 'rafael uribe', 'antonio narino',
    'san cristobal', 'restrepo', 'puente aranda', 'venecia', 'americas', 'timiza', '20 de julio', 'veinte de julio',
  ],
};

// Places outside Bogotá D.C. (folded). Matched as whole words.
export const OUTSIDE_BOGOTA = [
  'chia', 'cajica', 'la calera', 'sopo', 'zipaquira', 'tocancipa', 'gachancipa', 'cota', 'funza', 'mosquera',
  'facatativa', 'soacha', 'tenjo', 'tabio', 'guatavita', 'suesca', 'nemocon', 'sesquile', 'choconta', 'guasca',
  'villa de leyva', 'fusagasuga', 'girardot', 'anapoima', 'la mesa', 'silvania', 'subachoque', 'el rosal',
  'madrid cundinamarca', 'medellin', 'cali', 'cartagena', 'barranquilla', 'bucaramanga', 'tunja', 'villavicencio',
  'manizales', 'pereira', 'armenia', 'santa marta', 'ibague', 'neiva', 'pasto', 'popayan',
];

export function findKnownVenue(...texts) {
  const hay = fold(texts.filter(Boolean).join(' | '));
  if (!hay) return null;
  return KNOWN_VENUES.find((v) => v.match.some((m) => hay.includes(m))) || null;
}

function hasWord(hay, word) {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/ /g, '\\s+')}([^a-z0-9]|$)`).test(hay);
}

/** Returns the outside-Bogotá place name found as a whole word in `text`, or null. */
export function findOutsideBogota(text) {
  const hay = fold(text);
  if (!hay) return null;
  return OUTSIDE_BOGOTA.find((w) => hasWord(hay, w)) || null;
}

/**
 * Guess the zone from address-like text, e.g. "Calle 127 # 7-30", "Cra 7 # 28-66", "Kennedy".
 * Rules of thumb: "sur" in the address → sur; calle ≥ 72 → norte; calle < 26 with carrera < 30 → centro;
 * carrera ≥ 50 with calle 26–72 → occidente.
 */
export function zoneFromText(...texts) {
  const raw = texts.filter(Boolean).join(' | ');
  const hay = fold(raw);
  if (!hay) return 'desconocida';
  const known = findKnownVenue(raw);
  if (known) return known.zone;
  for (const [zone, words] of Object.entries(ZONE_WORDS)) {
    if (words.some((w) => hasWord(hay, w))) return zone;
  }
  // Address parsing.
  const addr = hay.replace(/\bno\b|\bn\b|\bnum\b/g, ' ');
  const calleM = /\b(?:av(?:enida)?\s+)?(?:calle|cll|cl|clle|ac)\s*(\d{1,3})\s*([a-z]{0,3})?\s*(sur)?\b/.exec(addr);
  const carreraM = /\b(?:av(?:enida)?\s+)?(?:carrera|cra|cr|kra|kr|ak)\s*(\d{1,3})\s*[a-z]{0,3}\s*(sur)?\b/.exec(addr);
  // "# 12-34" after the main road gives the cross street.
  const crossM = /(?:#|\bn[o°º]\.?)\s*(\d{1,3})/i.exec(raw);
  if (/\bsur\b/.test(addr) && (calleM || carreraM)) return 'sur';
  let calle = calleM ? Number(calleM[1]) : null;
  let carrera = carreraM ? Number(carreraM[1]) : null;
  if (calleM && carrera == null && crossM) carrera = Number(crossM[1]);
  if (carreraM && calle == null && crossM) calle = Number(crossM[1]);
  if (calle != null) {
    if (calle >= 72) return 'norte';
    if (calle < 26 && (carrera == null || carrera < 30)) return 'centro';
    if (carrera != null && carrera >= 50) return 'occidente';
    if (calle < 45) return 'centro';
    if (carrera != null && carrera < 20) return 'norte'; // Chapinero
    return 'desconocida';
  }
  return 'desconocida';
}

/** Rough "near Bella Suiza" check: north zone and not far west (Suba occidental). */
export function nearHomeFromText(zone, ...texts) {
  if (zone !== 'norte') return false;
  const hay = fold(texts.filter(Boolean).join(' '));
  if (/\b(suba centro|tibabuyes|rincon de suba|bilbao|lisboa|berlin)\b/.test(hay)) return false;
  return true;
}

/** Compact hint list for the AI prompt. */
export function venueHintsForPrompt() {
  return KNOWN_VENUES.filter((v) => v.a11y)
    .map((v) => `- ${v.match[0]} (zona ${v.zone}): ${v.a11y.note}`)
    .join('\n');
}
