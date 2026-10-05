// Ollama Cloud client + AI event classifier.
// API: POST {baseUrl}/api/chat, Authorization: Bearer $OLLAMA_API_KEY, non-streaming,
// `format` = JSON schema (structured outputs), answer JSON in response.message.content.
// Docs: https://docs.ollama.com/cloud , https://docs.ollama.com/capabilities/structured-outputs
import { cleanText, truncate, sleep } from './util.mjs';
import { venueHintsForPrompt } from './venues.mjs';

export const KINDS = ['asistir', 'participar'];
export const CATEGORIES = ['arte', 'pintura', 'danza', 'musica', 'teatro', 'cine', 'naturaleza', 'otro'];
export const SPANS = ['single', 'range'];
export const ZONES = ['norte', 'centro', 'occidente', 'sur', 'desconocida'];
export const WALKING = ['poca', 'moderada', 'mucha', 'desconocida'];
export const WHEELCHAIR = ['si', 'parcial', 'no', 'desconocido'];
const SEATING = ['si', 'no', 'desconocido'];

/** JSON schema sent as `format`. Flat items keep small models on track. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          category: { type: 'string', enum: CATEGORIES },
          span: { type: 'string', enum: SPANS },
          summary: { type: 'string' },
          zone: { type: 'string', enum: ZONES },
          nearHome: { type: 'boolean' },
          free: { type: 'boolean' },
          priceText: { type: 'string' },
          walking: { type: 'string', enum: WALKING },
          seating: { type: 'string', enum: SEATING },
          wheelchair: { type: 'string', enum: WHEELCHAIR },
          accessNote: { type: 'string' },
          forSeniors: { type: 'boolean' },
        },
        required: [
          'i', 'keep', 'reason', 'kind', 'category', 'span', 'summary', 'zone', 'nearHome', 'free', 'priceText',
          'walking', 'seating', 'wheelchair', 'accessNote', 'forSeniors',
        ],
      },
    },
  },
  required: ['results'],
};

export const SYSTEM_PROMPT = `Eres un asistente que filtra y describe actividades culturales en Bogotá para "Totoya".
You curate a family calendar. Answer ONLY with JSON matching the schema. All text fields in Spanish (Colombia), warm and concrete.

PERFIL DE TOTOYA
- Mujer de 75 años. Le encanta el ARTE, la PINTURA y la DANZA. También disfruta música, teatro, cine, jardines y naturaleza tranquila.
- Movilidad: usa bastón; para distancias largas, silla de ruedas. Camina cómoda unos 300 m. Necesita lugares para sentarse.
- Vive en Bella Suiza, Usaquén (norte de Bogotá). Va en taxi o carro con la familia; el centro está bien.
- La familia decide con ella: es mejor MOSTRAR casi todo con una nota honesta de accesibilidad que esconder cosas.

REGLAS PARA keep (conservar)
Conserva (keep=true) SOLO actividades que encajen con sus gustos:
- Artes plásticas: exposiciones, museos, galerías, visitas guiadas de arte, fotografía artística, charlas sobre arte.
- Pintura y dibujo: talleres, clases, cursos (óleo, acuarela, dibujo, grabado, cerámica artística).
- Danza y baile: funciones, clases, cursos, bailes para persona mayor.
- Música en vivo (conciertos), teatro, ópera, cine (funciones, ciclos), títeres para adultos.
- Jardines y naturaleza tranquila (jardín botánico, orquídeas), ferias de arte o artesanía.
Descarta (keep=false) todo lo demás, en particular:
- Fuera de Bogotá D.C. (Chía, Cajicá, La Calera, Sopó, Zipaquirá, Cota, Soacha, Tocancipá, Guatavita, Villa de Leyva u otra ciudad/municipio).
- Caminatas, senderismo, recorridos largos a pie, carreras, ciclopaseos, deporte, gimnasia, actividad física, torneos.
- Para niños, bebés, adolescentes o jóvenes (vacaciones recreativas, "BibloVacaciones" infantiles, cuentos para niños).
- Solo virtual / en línea.
- Idiomas, clubes de conversación, tecnología, computadores, inteligencia artificial, alfabetización digital, finanzas, emprendimiento, trámites, salud, terapias, espiritualidad, esoterismo (ángeles, sanación, energía), cocina, repostería, belleza.
- Clubes de lectura, poesía, escritura y charlas literarias o de historia, SALVO que traten de arte, pintura o danza.
- Manualidades textiles (crochet, tejido, costura, lencería) y cursos de oficios.
- Congresos, seminarios académicos, convocatorias, becas, ventas.
Si dudas, piensa: ¿es arte, pintura, danza, música en vivo, teatro, cine o un jardín? Si no, keep=false.
reason: frase corta en español explicando la decisión.

CAMPOS
- kind: "participar" si ella hace la actividad (taller, clase, curso, laboratorio, práctica); "asistir" si es espectadora (exposición, función, concierto, cine, charla).
- category: arte (exposiciones, museos, artes plásticas, fotografía, artesanía), pintura (pintura, dibujo, acuarela, grabado), danza (danza, baile, tango, salsa, bolero, ballet, folclor), musica, teatro, cine, naturaleza (jardines, plantas, aves), otro. Si hay pintura o danza, prefiere esas.
- span: "range" si es una exposición o algo disponible durante muchos días (más de 3 días entre inicio y fin); si no, "single".
- summary: máximo 220 caracteres, en español, amable y concreto: qué es, por qué podría gustarle. Sin emojis, sin inventar datos.
- zone: zona de Bogotá del lugar. norte = Usaquén, Chapinero, Chicó, Cedritos, Suba, calles ≥ 72; centro = La Candelaria, Centro, Santa Fe, Teusaquillo, Macarena; occidente = Engativá, Fontibón, Salitre, Barrios Unidos, Av. 68; sur = Kennedy, Bosa, Tunal, Usme, Ciudad Bolívar, direcciones "Sur". Si no se sabe: "desconocida".
- nearHome: true solo si es en el norte, razonablemente cerca de Usaquén (Usaquén, Santa Bárbara, Cedritos, Chicó, Chapinero norte, Suba oriental).
- free: true si es gratis / entrada libre. priceText: el precio tal como se publica (p. ej. "$20.000", "Entrada libre") o "Consultar precio" si no se sabe.
- forSeniors: true si está dirigido a persona mayor / adulto mayor / 60+.
- Accesibilidad, siempre honesta (si no sabes, usa "desconocida"/"desconocido"; nunca inventes):
  - walking: cuánto hay que caminar comparado con ~300 m: "poca" (función sentada, taller en salón), "moderada" (recorrer un museo), "mucha" (feria grande al aire libre, recorrido por calles, parque grande), "desconocida".
  - seating: "si" si hay sillas durante la actividad (teatro, auditorio, cine, taller sentado), "no" si es de pie, "desconocido".
  - wheelchair: "si", "parcial" (p. ej. edificio histórico con escaleras pero con algún apoyo), "no", "desconocido".
  - accessNote: máximo 160 caracteres, concreta (p. ej. "Auditorio con sillas; ascensor en la entrada" o "Recorrido de pie por salas; preguntar por bancas").
Lugares conocidos (úsalo como referencia):
- Museos del Banco de la República y museos grandes: normalmente con ascensor y algunas bancas; el recorrido es a pie.
- Teatro Colón: edificio histórico con escaleras, pero tiene servicios de accesibilidad (avisar al comprar boleta).
${venueHintsForPrompt()}

Devuelve exactamente un objeto en "results" por cada evento recibido, con el mismo "i".`;

/** Compact representation of an event for the prompt. */
export function eventForPrompt(ev, i) {
  const o = { i, title: ev.title, start: ev.start };
  if (ev.end) o.end = ev.end;
  if (ev.venueName) o.venue = ev.venueName;
  if (ev.address) o.address = ev.address;
  if (ev.priceText) o.price = ev.priceText;
  if (ev.tags?.length) o.tags = ev.tags.slice(0, 8);
  if (ev.sourceName) o.source = ev.sourceName;
  if (ev.description) o.description = truncate(ev.description.replace(/\s+/g, ' '), 700);
  return o;
}

export function buildMessages(events) {
  const payload = events.map((ev, i) => eventForPrompt(ev, i));
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Clasifica estos ${events.length} eventos. Responde con JSON que cumpla este esquema:\n` +
        `${JSON.stringify(RESPONSE_SCHEMA)}\n\nEventos:\n${JSON.stringify(payload, null, 1)}`,
    },
  ];
}

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const bool = (v) => v === true || v === 'true' || v === 'si' || v === 'sí';

/** Map one raw model item to Contract-2 classification fields (or null if unusable). */
export function normaliseItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.keep !== 'boolean' && typeof item.keep !== 'string') return null;
  const category = pick(String(item.category || '').toLowerCase().replace('música', 'musica'), CATEGORIES, null);
  const kind = pick(String(item.kind || '').toLowerCase(), KINDS, null);
  if (!category || !kind) return null;
  const seatingRaw = String(item.seating ?? '').toLowerCase();
  const seating = seatingRaw === 'si' || seatingRaw === 'sí' || item.seating === true ? true : seatingRaw === 'no' || item.seating === false ? false : null;
  return {
    keep: bool(item.keep),
    reason: cleanText(item.reason, 200),
    kind,
    category,
    span: pick(item.span, SPANS, 'single'),
    summary: cleanText(item.summary, 220),
    zone: pick(item.zone, ZONES, 'desconocida'),
    nearHome: bool(item.nearHome),
    price: { free: bool(item.free), text: cleanText(item.priceText, 120) },
    accessibility: {
      walking: pick(item.walking, WALKING, 'desconocida'),
      seating,
      wheelchair: pick(item.wheelchair, WHEELCHAIR, 'desconocido'),
      note: cleanText(item.accessNote, 160),
    },
    forSeniors: bool(item.forSeniors),
  };
}

/** Pull the JSON object out of message.content (tolerates code fences / chatter). */
export function extractJson(content) {
  if (content == null) throw new Error('empty model response');
  if (typeof content === 'object') return content;
  const s = String(content).trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error(`model response is not JSON: ${s.slice(0, 120)}`);
  }
}

/**
 * Parse an /api/chat response body into an array (length n) of normalised results or null per slot.
 */
export function parseChatResponse(body, n) {
  if (body?.error) throw new Error(`ollama error: ${body.error}`);
  const content = body?.message?.content;
  const data = extractJson(content && String(content).trim() ? content : body?.message?.thinking);
  const items = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(items)) throw new Error('model response has no results array');
  const out = new Array(n).fill(null);
  items.forEach((item, pos) => {
    const idx = Number.isInteger(item?.i) ? item.i : Number.isInteger(Number(item?.i)) ? Number(item.i) : items.length === n ? pos : -1;
    if (idx >= 0 && idx < n && !out[idx]) out[idx] = normaliseItem(item);
  });
  return out;
}

export class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function defaultThink(model) {
  // gpt-oss can't fully disable thinking; "low" keeps it cheap. Others: leave the server default.
  return /^gpt-oss/.test(model) ? 'low' : undefined;
}

/** One POST /api/chat. Returns the parsed JSON body. */
export async function chat({ baseUrl, apiKey, model, messages, format, timeoutMs = 120000, think, fetchImpl = fetch }) {
  const body = { model, messages, stream: false, options: { temperature: 0 } };
  if (format) body.format = format;
  const th = think === undefined ? defaultThink(model) : think;
  if (th !== undefined && th !== null) body.think = th;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/chat`;
  const doFetch = (b) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await doFetch(body);
  if (res.status === 400 && body.think !== undefined) {
    // Some models reject the think parameter; retry once without it.
    const text = await res.text().catch(() => '');
    if (/think/i.test(text)) {
      delete body.think;
      res = await doFetch(body);
    } else {
      throw new OllamaError(`HTTP 400: ${text.slice(0, 200)}`, 400);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* keep text */ }
    const err = new OllamaError(`HTTP ${res.status}: ${String(msg).slice(0, 200)}`, res.status);
    err.retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
    throw err;
  }
  return res.json();
}

/**
 * Batch classifier. Sequential requests with a small delay (rate limits).
 * Per batch: model → (retry once after 429) → fallbackModel → null (caller uses keywords).
 * After `maxConsecutiveFailures` failed batches (or an auth error) it stops calling the API.
 */
export function createOllamaClassifier(settings = {}, { apiKey = process.env.OLLAMA_API_KEY, fetchImpl = fetch, log = console.log, delayMs = 1500 } = {}) {
  const cfg = {
    baseUrl: settings.baseUrl || 'https://ollama.com',
    model: settings.model || 'gemma4:31b',
    fallbackModel: settings.fallbackModel || null,
    batchSize: Math.max(1, settings.batchSize || 8),
    timeoutMs: (settings.timeoutSeconds || 120) * 1000,
    think: settings.think,
  };
  const stats = { requests: 0, batches: 0, okBatches: 0, failedBatches: 0, classified: 0, errors: [], disabled: false };
  let consecutiveFailures = 0;

  async function tryModel(model, batch) {
    const messages = buildMessages(batch);
    for (let attempt = 0; attempt < 2; attempt++) {
      stats.requests++;
      try {
        const body = await chat({ ...cfg, apiKey, model, messages, format: RESPONSE_SCHEMA, fetchImpl });
        return parseChatResponse(body, batch.length);
      } catch (err) {
        if (err.status === 429 && attempt === 0) {
          const wait = Math.min(60, err.retryAfter || 10) * 1000;
          log(`  ollama 429 on ${model}; waiting ${wait / 1000} s`);
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  /** @returns {Promise<(object|null)[]>} classification per event (null → use fallback) */
  async function classify(events) {
    const out = new Array(events.length).fill(null);
    if (!apiKey) {
      stats.disabled = true;
      return out;
    }
    for (let start = 0; start < events.length; start += cfg.batchSize) {
      if (stats.disabled) break;
      const batch = events.slice(start, start + cfg.batchSize);
      stats.batches++;
      if (start > 0) await sleep(delayMs);
      let results = null;
      let usedModel = null;
      for (const model of [cfg.model, cfg.fallbackModel].filter(Boolean)) {
        try {
          results = await tryModel(model, batch);
          if (results.every((r) => r === null)) throw new Error('no usable items in response');
          usedModel = model;
          break;
        } catch (err) {
          results = null;
          const msg = `${model}: ${err.message}`;
          stats.errors.push(msg);
          log(`  ollama batch ${stats.batches} failed — ${msg}`);
          if (err.status === 401 || err.status === 403) {
            stats.disabled = true;
            break;
          }
        }
      }
      if (results) {
        stats.okBatches++;
        consecutiveFailures = 0;
        results.forEach((r, k) => {
          if (r) {
            out[start + k] = { ...r, model: usedModel };
            stats.classified++;
          }
        });
      } else {
        stats.failedBatches++;
        if (++consecutiveFailures >= 3) {
          log('  ollama: 3 consecutive failed batches — using keywords for the rest');
          stats.disabled = true;
        }
      }
    }
    return out;
  }

  return { classify, stats, config: cfg };
}
