/* Agenda de Totoya — vanilla JS, no build step.
 * Reads data/events.json (falls back to data/events.sample.json), renders a
 * month grid (>= 700px) or an agenda list (phones), and an event dialog that
 * is reachable through the deep link #/evento/<id>.
 * All event times are Bogotá local time without offset ("YYYY-MM-DDTHH:mm"). */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const TZ = 'America/Bogota';
  const STORAGE_KEY = 'totoya.filtros.v1';
  const WIDE_QUERY = '(min-width: 700px)';
  const MAX_CHIPS = 3;
  const DEFAULT_DURATION_MIN = 120;
  const NB = ' ';

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const GRID_HEAD = [['Lunes', 'Lun'], ['Martes', 'Mar'], ['Miércoles', 'Mié'], ['Jueves', 'Jue'],
    ['Viernes', 'Vie'], ['Sábado', 'Sáb'], ['Domingo', 'Dom']];

  const CATEGORIES = {
    arte: { emoji: '🎨', label: 'Arte' },
    pintura: { emoji: '🖌️', label: 'Pintura' },
    danza: { emoji: '💃', label: 'Danza' },
    musica: { emoji: '🎵', label: 'Música' },
    teatro: { emoji: '🎭', label: 'Teatro' },
    cine: { emoji: '🎬', label: 'Cine' },
    naturaleza: { emoji: '🌿', label: 'Naturaleza' },
    otro: { emoji: '✨', label: 'Otro' },
  };
  const KINDS = {
    asistir: { label: 'Ir a ver', icon: '👀' },
    participar: { label: 'Participar', icon: '✋' },
  };

  // Accessibility wording: [text, level] where level drives the colour of the row.
  const WALKING = {
    poca: ['Poco caminar (menos de 300 m)', 'good'],
    moderada: ['Caminar moderado (unos 300 m)', 'mid'],
    mucha: ['Mucho caminar (más de 300 m): mejor en silla de ruedas', 'bad'],
    desconocida: ['Caminata: no sabemos cuánto', 'unknown'],
  };
  const WHEELCHAIR = {
    si: ['Se puede ir en silla de ruedas', 'good'],
    parcial: ['Silla de ruedas: solo en parte', 'mid'],
    no: ['No es apto para silla de ruedas', 'bad'],
    desconocido: ['Silla de ruedas: no sabemos', 'unknown'],
  };
  function seatingInfo(v) {
    if (v === true) return ['Hay sillas para sentarse', 'good'];
    if (v === false) return ['Casi todo es de pie', 'bad'];
    return ['Sillas: no sabemos', 'unknown'];
  }

  const DEFAULT_FILTERS = { kind: 'todo', gratis: false, cerca: false, sinNoche: false, mayores: false };

  // -------------------------------------------------------------------- state
  const state = {
    data: null,
    isSample: false,
    singles: [],
    ranges: [],
    places: [],
    byId: new Map(),
    today: null,       // parsed date of "today" in Bogotá
    todayKey: '',
    view: null,        // { y, mo }
    filters: Object.assign({}, DEFAULT_FILTERS),
    showPast: false,
    wide: true,
    lastFocus: null,
  };

  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------- utilities
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) {
    return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ------------------------------------------------------------ date helpers
  // A "local date" is { y, mo, d, h, mi, hasTime } in Bogotá wall-clock time.
  function parseLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return null;
    const hasTime = m[4] != null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: hasTime ? +m[4] : 0, mi: hasTime ? +m[5] : 0, hasTime };
  }
  function keyOf(p) { return p.y + '-' + pad(p.mo) + '-' + pad(p.d); }
  function fromKey(k) { return parseLocal(k); }
  function ms(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); }
  function fromMs(t, hasTime) {
    const d = new Date(t);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
      h: hasTime ? d.getUTCHours() : 0, mi: hasTime ? d.getUTCMinutes() : 0, hasTime };
  }
  function addDays(p, n) { return fromMs(ms(p) + n * 864e5, p.hasTime); }
  function addMinutes(p, n) { return fromMs(ms(p) + n * 6e4, true); }
  function weekday(p) { return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(); }
  function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
  function monthKey(y, mo) { return y + '-' + pad(mo); }

  function nowPartsInBogota(date) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(date);
      const g = (t) => +parts.find((x) => x.type === t).value;
      return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute'), hasTime: true };
    } catch (e) {
      return { y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(),
        h: date.getHours(), mi: date.getMinutes(), hasTime: true };
    }
  }

  // ---------------------------------------------------------- formatting (es-CO)
  function fmtTime(h, mi, sp) {
    sp = sp || NB;
    const h12 = h % 12 || 12;
    return h12 + ':' + pad(mi) + sp + (h < 12 ? 'a.' + sp + 'm.' : 'p.' + sp + 'm.');
  }
  function fmtTimeCompact(h, mi) {
    const h12 = h % 12 || 12;
    return h12 + (mi ? ':' + pad(mi) : '') + NB + (h < 12 ? 'a.' + NB + 'm.' : 'p.' + NB + 'm.');
  }
  function yearSuffix(p) { return state.today && p.y !== state.today.y ? ' de ' + p.y : ''; }
  function fmtDayLong(p) { return WEEKDAYS[weekday(p)] + ' ' + p.d + ' de ' + MONTHS[p.mo - 1] + yearSuffix(p); }
  function fmtDayShort(p) { return WEEKDAYS_SHORT[weekday(p)] + ' ' + p.d + ' ' + MONTHS_SHORT[p.mo - 1]; }

  /** Long, human description of when an event happens (UI). */
  function whenLong(ev) {
    const s = ev._s, e = ev._e;
    if (ev.span === 'range') {
      if (!e) return 'Desde el ' + fmtDayLong(s);
      if (keyOf(s) <= state.todayKey) return 'Abierta hasta el ' + fmtDayLong(e);
      return 'Del ' + fmtDayLong(s) + ' al ' + fmtDayLong(e);
    }
    let out = cap(fmtDayLong(s));
    if (s.hasTime) {
      if (e && e.hasTime && keyOf(e) === keyOf(s)) {
        out += ', de ' + fmtTime(s.h, s.mi) + ' a ' + fmtTime(e.h, e.mi);
      } else {
        out += ', ' + fmtTime(s.h, s.mi);
      }
    } else {
      out += ' (todo el día)';
    }
    if (e && keyOf(e) !== keyOf(s)) out += ' — hasta el ' + fmtDayLong(e);
    return out;
  }

  /** Short form for WhatsApp: "sáb 18 oct, 10:00 a. m." */
  function whenShort(ev) {
    const s = ev._s, e = ev._e;
    if (ev.span === 'range') {
      if (!e) return 'desde el ' + fmtDayShort(s);
      if (keyOf(s) <= state.todayKey) return 'abierta hasta el ' + fmtDayShort(e);
      return 'del ' + fmtDayShort(s) + ' al ' + fmtDayShort(e);
    }
    return fmtDayShort(s) + (s.hasTime ? ', ' + fmtTime(s.h, s.mi, ' ') : '');
  }

  function fmtGenerated(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = nowPartsInBogota(d);
    return WEEKDAYS[weekday(p)] + ' ' + p.d + ' de ' + MONTHS[p.mo - 1] + ' de ' + p.y +
      ' a las ' + fmtTime(p.h, p.mi);
  }

  // ------------------------------------------------------------- link builders
  function deepLink(id) {
    return location.origin + location.pathname + '#/evento/' + encodeURIComponent(id);
  }
  function priceShort(price) { return price && price.free ? 'Gratis' : (price && price.text) || ''; }

  function accessShort(a) {
    if (!a) return '';
    const parts = [];
    if (a.seating === true) parts.push('con sillas');
    if (a.wheelchair === 'si') parts.push('acceso en silla de ruedas');
    else if (a.wheelchair === 'parcial') parts.push('acceso parcial en silla de ruedas');
    if (a.walking === 'poca') parts.push('poco caminar');
    else if (a.walking === 'mucha') parts.push('mucho caminar');
    if (!parts.length) return '';
    const last = parts.pop();
    return '♿ ' + (parts.length ? parts.join(', ') + ' y ' + last : last);
  }

  function whatsappUrl(ev) {
    const cat = CATEGORIES[ev.category] || CATEGORIES.otro;
    const head = cat.emoji + ' *' + ev.title + '* — ' + whenShort(ev) + (ev.evening ? ' 🌙' : '');
    const parts = [head, ev.venue && ev.venue.name, priceShort(ev.price), accessShort(ev.accessibility)]
      .filter(Boolean);
    const msg = parts.join(' · ') + '. ¿Quién la lleva? 👉 ' + deepLink(ev.id);
    return 'https://wa.me/?text=' + encodeURIComponent(msg);
  }

  function gcalStamp(p, withTime) {
    const date = '' + p.y + pad(p.mo) + pad(p.d);
    return withTime ? date + 'T' + pad(p.h) + pad(p.mi) + '00' : date;
  }
  function gcalDates(ev) {
    const s = ev._s, e = ev._e;
    const allDay = ev.span === 'range' || !s.hasTime || (e && !e.hasTime);
    if (allDay) {
      const last = e && ms(e) >= ms(s) ? e : s;
      return gcalStamp(s, false) + '/' + gcalStamp(addDays(last, 1), false);
    }
    const end = e && ms(e) > ms(s) ? e : addMinutes(s, DEFAULT_DURATION_MIN);
    return gcalStamp(s, true) + '/' + gcalStamp(end, true);
  }
  function locationText(venue) {
    return [venue && venue.name, venue && venue.address, 'Bogotá'].filter(Boolean).join(', ');
  }
  function gcalUrl(ev) {
    const details = [
      ev.summary,
      '',
      'Precio: ' + ((ev.price && ev.price.text) || priceShort(ev.price)),
      'Accesibilidad: ' + accessLines(ev.accessibility).map((x) => x[0]).join('. ') + '.',
      '',
      'Más información: ' + (safeUrl(ev.url) || ''),
      'En la agenda de Totoya: ' + deepLink(ev.id),
    ].join('\n');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent(ev.title) +
      '&dates=' + gcalDates(ev) + // digits, "T" and "/" only
      '&ctz=' + encodeURIComponent(TZ) +
      '&details=' + encodeURIComponent(details) +
      '&location=' + encodeURIComponent(locationText(ev.venue));
  }
  function mapsUrl(venue) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(locationText(venue));
  }

  // ------------------------------------------------------------- data loading
  async function loadData() {
    const urls = ['data/events.json', 'data/events.sample.json'];
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const json = await res.json();
        return { json, isSample: url.indexOf('sample') !== -1 };
      } catch (e) {
        /* try the next one */
      }
    }
    throw new Error('No se pudo cargar la agenda');
  }

  function prepare(json) {
    const events = Array.isArray(json && json.events) ? json.events : [];
    state.singles = [];
    state.ranges = [];
    state.byId = new Map();
    for (const raw of events) {
      if (!raw || !raw.id || !raw.title) continue;
      const s = parseLocal(raw.start);
      if (!s) continue;
      const ev = Object.assign({}, raw);
      ev._s = s;
      ev._e = parseLocal(raw.end);
      ev.venue = ev.venue || { name: '', zone: 'desconocida' };
      ev.price = ev.price || { free: false, text: '' };
      ev.accessibility = ev.accessibility || { walking: 'desconocida', seating: null, wheelchair: 'desconocido', note: '' };
      if (!CATEGORIES[ev.category]) ev.category = 'otro';
      if (!KINDS[ev.kind]) ev.kind = 'asistir';
      ev._startMs = ms(s);
      ev._endKey = ev._e ? keyOf(ev._e) : keyOf(s);
      state.byId.set(String(ev.id), ev);
      (ev.span === 'range' ? state.ranges : state.singles).push(ev);
    }
    state.singles.sort((a, b) => a._startMs - b._startMs);
    state.ranges.sort((a, b) => (a._endKey < b._endKey ? -1 : a._endKey > b._endKey ? 1 : 0));
    state.places = Array.isArray(json && json.places) ? json.places.filter((p) => p && p.name) : [];
  }

  // ----------------------------------------------------------------- filters
  function loadFilters() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const f = Object.assign({}, DEFAULT_FILTERS);
        if (['todo', 'asistir', 'participar'].indexOf(saved.kind) !== -1) f.kind = saved.kind;
        ['gratis', 'cerca', 'sinNoche', 'mayores'].forEach((k) => { f[k] = saved[k] === true; });
        state.filters = f;
      }
    } catch (e) { /* storage unavailable: keep defaults */ }
  }
  function saveFilters() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.filters)); } catch (e) { /* ignore */ }
  }
  function anyFilter() {
    const f = state.filters;
    return f.kind !== 'todo' || f.gratis || f.cerca || f.sinNoche || f.mayores;
  }
  function passes(ev) {
    const f = state.filters;
    if (f.kind !== 'todo' && ev.kind !== f.kind) return false;
    if (f.gratis && !(ev.price && ev.price.free)) return false;
    if (f.cerca && !ev.nearHome) return false;
    if (f.sinNoche && ev.evening) return false;
    if (f.mayores && !ev.forSeniors) return false;
    return true;
  }
  function placePasses(p) {
    const f = state.filters;
    if (f.gratis && !(p.price && p.price.free)) return false;
    if (f.cerca && !p.nearHome) return false;
    return true;
  }

  // ----------------------------------------------------------- month helpers
  function monthBounds(y, mo) {
    return { first: monthKey(y, mo) + '-01', last: monthKey(y, mo) + '-' + pad(daysInMonth(y, mo)) };
  }
  function singlesInMonth(y, mo) {
    const mk = monthKey(y, mo);
    return state.singles.filter((ev) => keyOf(ev._s).slice(0, 7) === mk);
  }
  function rangesInMonth(y, mo) {
    const b = monthBounds(y, mo);
    return state.ranges.filter((ev) => keyOf(ev._s) <= b.last && ev._endKey >= b.first);
  }
  function rangesOnDay(key) {
    return state.ranges.filter((ev) => keyOf(ev._s) <= key && ev._endKey >= key);
  }
  function groupByDay(list) {
    const map = new Map();
    for (const ev of list) {
      const k = keyOf(ev._s);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(ev);
    }
    return map;
  }

  // ------------------------------------------------------------ html pieces
  function badges(ev) {
    const out = [];
    if (ev.price) {
      out.push(ev.price.free
        ? '<span class="badge badge-free"><span aria-hidden="true">🎁</span> ' + esc(!ev.price.text ? 'Gratis' : /gratis|gratuit/i.test(ev.price.text) ? ev.price.text : 'Gratis · ' + ev.price.text) + '</span>'
        : '<span class="badge badge-price"><span aria-hidden="true">💵</span> ' + esc(ev.price.text || 'Con costo') + '</span>');
    }
    if (ev.nearHome) out.push('<span class="badge badge-near"><span aria-hidden="true">🏡</span> Cerca de casa</span>');
    if (ev.evening) out.push('<span class="badge badge-night"><span aria-hidden="true">🌙</span> De noche</span>');
    if (ev.forSeniors) out.push('<span class="badge badge-seniors"><span aria-hidden="true">🧓</span> Para persona mayor</span>');
    return '<p class="badges">' + out.join(' ') + '</p>';
  }

  function accessLines(a) {
    a = a || {};
    return [
      ['🚶'].concat(WALKING[a.walking] || WALKING.desconocida),
      ['🪑'].concat(seatingInfo(a.seating)),
      ['♿'].concat(WHEELCHAIR[a.wheelchair] || WHEELCHAIR.desconocido),
    ].map((x) => [x[1], x[2], x[0]]);
  }
  function accessBlock(a, headingTag) {
    const items = accessLines(a).map((x) =>
      '<li class="acc acc-' + x[1] + '"><span class="acc-icon" aria-hidden="true">' + x[2] + '</span> ' + esc(x[0]) + '</li>');
    const note = a && a.note ? '<p class="acc-note">' + esc(a.note) + '</p>' : '';
    const head = headingTag ? '<' + headingTag + ' class="acc-title">Accesibilidad</' + headingTag + '>' : '';
    return '<div class="access">' + head + '<ul class="acc-list" aria-label="Accesibilidad">' + items.join('') + '</ul>' + note + '</div>';
  }

  function kindTag(ev) {
    const k = KINDS[ev.kind];
    const c = CATEGORIES[ev.category];
    return '<p class="card-top"><span class="kind-tag kind-tag-' + ev.kind + '"><span aria-hidden="true">' + k.icon + '</span> ' + k.label + '</span>' +
      '<span class="cat-tag"><span aria-hidden="true">' + c.emoji + '</span> ' + c.label + '</span></p>';
  }

  function eventCard(ev, h) {
    h = h || 'h3';
    const c = CATEGORIES[ev.category];
    return '<article class="card kind-' + ev.kind + '" data-open="' + esc(ev.id) + '">' +
      kindTag(ev) +
      '<' + h + ' class="card-title"><span aria-hidden="true">' + c.emoji + '</span> ' + esc(ev.title) + (ev.evening ? ' <span aria-hidden="true">🌙</span>' : '') + '</' + h + '>' +
      '<p class="card-when"><span aria-hidden="true">🕒</span> ' + esc(whenLong(ev)) + '</p>' +
      '<p class="card-where"><span aria-hidden="true">📍</span> ' + esc(ev.venue.name) + (ev.venue.address ? ' — ' + esc(ev.venue.address) : '') + '</p>' +
      badges(ev) +
      (ev.summary ? '<p class="card-summary">' + esc(ev.summary) + '</p>' : '') +
      accessBlock(ev.accessibility) +
      '<button type="button" class="btn btn-primary btn-block" data-ev="' + esc(ev.id) + '">Ver detalles y compartir</button>' +
      '</article>';
  }

  function placeCard(p) {
    const c = CATEGORIES[p.category] || CATEGORIES.otro;
    const venue = { name: p.name, address: p.address };
    const url = safeUrl(p.url);
    return '<article class="card card-place">' +
      '<h3 class="card-title"><span aria-hidden="true">' + c.emoji + '</span> ' + esc(p.name) + '</h3>' +
      (p.summary ? '<p class="card-summary">' + esc(p.summary) + '</p>' : '') +
      '<p class="card-when"><span aria-hidden="true">🕒</span> ' + esc(p.hours) + '</p>' +
      '<p class="card-where"><span aria-hidden="true">📍</span> ' + esc(p.address) + '</p>' +
      badges({ price: p.price, nearHome: p.nearHome }) +
      accessBlock(p.accessibility) +
      '<div class="actions">' +
      '<a class="btn btn-secondary" href="' + esc(mapsUrl(venue)) + '" target="_blank" rel="noopener"><span aria-hidden="true">🗺️</span> Cómo llegar</a>' +
      (url ? '<a class="btn btn-secondary" href="' + esc(url) + '" target="_blank" rel="noopener"><span aria-hidden="true">🔗</span> Ver página</a>' : '') +
      '</div></article>';
  }

  // ------------------------------------------------------------ main render
  function renderAll() {
    renderHeader();
    renderFilterButtons();
    renderCalendar();
    renderRanges();
    renderPlaces();
  }

  function renderHeader() {
    const { y, mo } = state.view;
    $('#month-title').textContent = cap(MONTHS[mo - 1]) + ' de ' + y;
    const prev = mo === 1 ? { y: y - 1, mo: 12 } : { y, mo: mo - 1 };
    const next = mo === 12 ? { y: y + 1, mo: 1 } : { y, mo: mo + 1 };
    $('#prev-label').textContent = cap(MONTHS[prev.mo - 1]);
    $('#next-label').textContent = cap(MONTHS[next.mo - 1]);
    $('#prev-month').setAttribute('aria-label', 'Ver el mes anterior, ' + MONTHS[prev.mo - 1] + ' de ' + prev.y);
    $('#next-month').setAttribute('aria-label', 'Ver el mes siguiente, ' + MONTHS[next.mo - 1] + ' de ' + next.y);
    const isCurrent = y === state.today.y && mo === state.today.mo;
    $('#today-btn').setAttribute('aria-label', isCurrent ? 'Ir al día de hoy' : 'Volver al mes de hoy');

    const singles = singlesInMonth(y, mo).filter(passes).length;
    const ranges = rangesInMonth(y, mo).filter(passes).length;
    const parts = [];
    if (singles) parts.push(plural(singles, 'actividad', 'actividades'));
    if (ranges) parts.push(plural(ranges, 'exposición', 'exposiciones'));
    $('#month-count').textContent = parts.length ? parts.join(' y ') : '';
  }

  function renderFilterButtons() {
    const f = state.filters;
    document.querySelectorAll('[data-kind]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.kind === f.kind));
    });
    document.querySelectorAll('[data-filter]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!!f[b.dataset.filter]));
    });
    $('#clear-filters').hidden = !anyFilter();
  }

  function emptyMessage(totalInMonth) {
    if (totalInMonth === 0) {
      return '<div class="empty"><p><strong>Todavía no hay actividades para este mes</strong> — mira «Siempre disponible».</p>' +
        '<button type="button" class="btn btn-secondary" data-goto="siempre">Ver lugares siempre disponibles</button></div>';
    }
    return '<div class="empty"><p><strong>Con estos filtros no hay actividades este mes.</strong></p>' +
      '<button type="button" class="btn btn-secondary" data-clear-filters>✕ Quitar filtros</button></div>';
  }

  function renderCalendar() {
    const { y, mo } = state.view;
    const all = singlesInMonth(y, mo);
    const allRanges = rangesInMonth(y, mo);
    const visible = all.filter(passes);
    const byDay = groupByDay(visible);
    const el = $('#calendar');
    let html = '';
    if (!visible.length) html += emptyMessage(all.length + allRanges.length);
    if (state.wide) html += gridHtml(y, mo, byDay);
    else if (visible.length) html += agendaHtml(y, mo, byDay);
    el.innerHTML = html;
  }

  function gridHtml(y, mo, byDay) {
    const lead = (weekday({ y, mo, d: 1 }) + 6) % 7;
    const n = daysInMonth(y, mo);
    let html = '<div class="grid-head" aria-hidden="true">' +
      GRID_HEAD.map((d) => '<div><span class="wd-long">' + d[0] + '</span><span class="wd-short">' + d[1] + '</span></div>').join('') +
      '</div><ol class="grid" aria-label="Días de ' + MONTHS[mo - 1] + '">';
    for (let i = 0; i < lead; i++) html += '<li class="cell cell-empty" aria-hidden="true"></li>';
    for (let d = 1; d <= n; d++) {
      const p = { y, mo, d, h: 0, mi: 0, hasTime: false };
      const key = keyOf(p);
      const evs = byDay.get(key) || [];
      const isToday = key === state.todayKey;
      const isPast = key < state.todayKey;
      const label = cap(fmtDayLong(p)) + (isToday ? ' (hoy)' : '') + ': ' +
        (evs.length ? plural(evs.length, 'actividad', 'actividades') : 'sin actividades');
      const cls = 'cell' + (isToday ? ' is-today' : '') + (isPast ? ' is-past' : '') + (evs.length ? ' has-events' : '');
      html += '<li class="' + cls + '"' + (isToday ? ' aria-current="date"' : '') + '>';
      const todayTag = isToday ? '<span class="today-tag">Hoy</span>' : '';
      if (evs.length) {
        html += '<button type="button" class="day-num" data-day="' + key + '" aria-label="' + esc(label) + '. Ver el día">' +
          '<span aria-hidden="true">' + d + '</span>' + todayTag + '</button>';
        html += '<ul class="chips">';
        evs.slice(0, MAX_CHIPS).forEach((ev) => {
          const c = CATEGORIES[ev.category];
          const time = ev._s.hasTime ? fmtTimeCompact(ev._s.h, ev._s.mi) : 'Todo el día';
          html += '<li><button type="button" class="chip kind-' + ev.kind + '" data-ev="' + esc(ev.id) + '">' +
            '<span class="visually-hidden">' + KINDS[ev.kind].label + ': </span>' +
            '<span class="chip-time"><span aria-hidden="true">' + c.emoji + '</span> ' + time + (ev.evening ? ' <span aria-hidden="true">🌙</span>' : '') + '</span>' +
            '<span class="chip-title">' + esc(ev.title) + '</span></button></li>';
        });
        html += '</ul>';
        if (evs.length > MAX_CHIPS) {
          html += '<button type="button" class="more" data-day="' + key + '" aria-label="Ver las ' + evs.length +
            ' actividades del ' + esc(fmtDayLong(p)) + '">y ' + (evs.length - MAX_CHIPS) + ' más</button>';
        }
      } else {
        html += '<span class="day-num day-num-plain"><span aria-hidden="true">' + d + '</span>' + todayTag +
          '<span class="visually-hidden">' + esc(label) + '</span></span>';
      }
      html += '</li>';
    }
    const trailing = (7 - ((lead + n) % 7)) % 7;
    for (let i = 0; i < trailing; i++) html += '<li class="cell cell-empty" aria-hidden="true"></li>';
    return html + '</ol>';
  }

  function agendaHtml(y, mo, byDay) {
    const keys = Array.from(byDay.keys()).sort();
    const isCurrent = y === state.today.y && mo === state.today.mo;
    const past = isCurrent ? keys.filter((k) => k < state.todayKey) : [];
    const shown = isCurrent && !state.showPast ? keys.filter((k) => k >= state.todayKey) : keys;
    let html = '';
    if (past.length && !state.showPast) {
      html += '<button type="button" class="btn btn-secondary btn-block" data-show-past>Mostrar días que ya pasaron (' + past.length + ')</button>';
    }
    if (!shown.length) {
      html += '<div class="empty"><p>Ya no quedan actividades este mes. Mira el mes siguiente.</p></div>';
    }
    html += '<div class="agenda">';
    for (const k of shown) {
      const p = fromKey(k);
      const isToday = k === state.todayKey;
      html += '<section class="agenda-day' + (isToday ? ' is-today' : '') + (k < state.todayKey ? ' is-past' : '') + '"' +
        ' aria-labelledby="ag-' + k + '"' + (isToday ? ' id="agenda-today"' : '') + '>' +
        '<h3 class="agenda-date" id="ag-' + k + '">' + esc(cap(fmtDayLong(p))) + (isToday ? ' <span class="today-tag">Hoy</span>' : '') + '</h3>' +
        '<div class="card-list">' + byDay.get(k).map((ev) => eventCard(ev, 'h4')).join('') + '</div></section>';
    }
    return html + '</div>';
  }

  function renderRanges() {
    const { y, mo } = state.view;
    const all = rangesInMonth(y, mo);
    const list = all.filter(passes);
    const el = $('#ranges');
    if (!list.length) {
      el.innerHTML = '<p class="empty-inline">' + (all.length
        ? 'Con estos filtros no hay exposiciones este mes.'
        : 'No tenemos exposiciones registradas para este mes.') + '</p>';
      return;
    }
    el.innerHTML = list.map((ev) => eventCard(ev, 'h3')).join('');
  }

  function renderPlaces() {
    const list = state.places.filter(placePasses);
    const el = $('#places');
    if (!state.places.length) { el.innerHTML = '<p class="empty-inline">Aún no hay lugares en la lista.</p>'; return; }
    el.innerHTML = list.length ? list.map(placeCard).join('')
      : '<p class="empty-inline">Con estos filtros no hay lugares. Prueba quitando «Gratis» o «Cerca de casa».</p>';
  }

  function renderFooter() {
    const when = state.data && state.data.generatedAt ? fmtGenerated(state.data.generatedAt) : '';
    $('#updated').textContent = when ? 'Actualizado el ' + when + (/\.$/.test(when) ? '' : '.') : '';
    const status = $('#status');
    if (state.isSample) {
      status.textContent = 'Estás viendo datos de EJEMPLO: la agenda real todavía no se ha generado.';
      status.classList.add('status-warn');
    } else {
      status.textContent = '';
      status.classList.remove('status-warn');
    }
  }

  // ----------------------------------------------------------------- dialog
  const dlg = () => $('#dialog');

  function openDialogUi(html, backToDay) {
    const d = dlg();
    $('#dlg-body').innerHTML = html;
    $('#dlg-back').hidden = !backToDay;
    if (!d.open) {
      state.lastFocus = document.activeElement;
      try { d.showModal(); } catch (e) { d.setAttribute('open', ''); }
    }
    d.scrollTop = 0;
    const inner = d.querySelector('.dialog-inner');
    if (inner) inner.scrollTop = 0;
    const title = $('#dlg-title');
    if (title) title.focus({ preventScroll: true });
  }

  function closeDialogUi() {
    const d = dlg();
    if (!d.open) return;
    d.close();
    $('#dlg-body').innerHTML = '';
    const lf = state.lastFocus;
    state.lastFocus = null;
    if (lf && lf.isConnected && typeof lf.focus === 'function') lf.focus();
  }

  function eventDialogHtml(ev) {
    const c = CATEGORIES[ev.category];
    const url = safeUrl(ev.url);
    const img = safeUrl(ev.image);
    return '<article class="detail kind-' + ev.kind + '">' +
      kindTag(ev) +
      '<h2 id="dlg-title" tabindex="-1"><span aria-hidden="true">' + c.emoji + '</span> ' + esc(ev.title) + '</h2>' +
      (img ? '<img class="detail-img" src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
      '<p class="detail-when"><span aria-hidden="true">🕒</span> ' + esc(whenLong(ev)) + (ev.evening ? ' <span aria-hidden="true">🌙</span><span class="visually-hidden"> (de noche)</span>' : '') + '</p>' +
      '<p class="detail-where"><span aria-hidden="true">📍</span> <strong>' + esc(ev.venue.name) + '</strong>' + (ev.venue.address ? '<br>' + esc(ev.venue.address) : '') + '</p>' +
      badges(ev) +
      (ev.summary ? '<p class="detail-summary">' + esc(ev.summary) + '</p>' : '') +
      accessBlock(ev.accessibility, 'h3') +
      '<div class="actions actions-detail">' +
      '<a class="btn btn-whatsapp" href="' + esc(whatsappUrl(ev)) + '" target="_blank" rel="noopener"><span aria-hidden="true">💬</span> Compartir por WhatsApp</a>' +
      '<a class="btn btn-gcal" href="' + esc(gcalUrl(ev)) + '" target="_blank" rel="noopener"><span aria-hidden="true">📅</span> Agregar a Google Calendar</a>' +
      '<a class="btn btn-secondary" href="' + esc(mapsUrl(ev.venue)) + '" target="_blank" rel="noopener"><span aria-hidden="true">🗺️</span> Cómo llegar</a>' +
      (url ? '<a class="btn btn-secondary" href="' + esc(url) + '" target="_blank" rel="noopener"><span aria-hidden="true">🔗</span> Ver más</a>' : '') +
      '</div>' +
      '<p class="detail-source">Información de: ' + esc(ev.sourceName || ev.source || '') + '. Confirmen antes de salir.</p>' +
      '</article>';
  }

  function renderEventDialog(id) {
    const ev = state.byId.get(id);
    if (!ev) {
      openDialogUi('<h2 id="dlg-title" tabindex="-1">No encontramos esta actividad</h2>' +
        '<p>Puede que ya haya pasado o que la hayan quitado de la agenda. Miren el calendario para ver otras.</p>', false);
      return;
    }
    const st = history.state;
    openDialogUi(eventDialogHtml(ev), !!(st && st.fromDay));
  }

  function renderDayDialog(key) {
    const p = fromKey(key);
    if (!p) { closeDialogUi(); return; }
    const all = state.singles.filter((ev) => keyOf(ev._s) === key);
    const list = all.filter(passes);
    const hidden = all.length - list.length;
    const ranges = rangesOnDay(key).filter(passes);
    let html = '<h2 id="dlg-title" tabindex="-1">' + esc(cap(fmtDayLong(p))) + (key === state.todayKey ? ' <span class="today-tag">Hoy</span>' : '') + '</h2>';
    html += '<p class="day-count">' + (list.length ? plural(list.length, 'actividad', 'actividades') : 'No hay actividades este día con los filtros elegidos.') + '</p>';
    if (hidden > 0) html += '<p class="hint">' + plural(hidden, 'actividad más está escondida', 'actividades más están escondidas') + ' por los filtros.</p>';
    html += '<div class="card-list card-list-single">' + list.map((ev) => eventCard(ev, 'h3')).join('') + '</div>';
    if (ranges.length) {
      html += '<h3 class="day-subtitle"><span aria-hidden="true">🖼️</span> También en exposición ese día</h3>' +
        '<div class="card-list card-list-single">' + ranges.map((ev) => eventCard(ev, 'h4')).join('') + '</div>';
    }
    openDialogUi(html, false);
  }

  // ----------------------------------------------------------------- routing
  function currentDepth() { return (history.state && history.state.totoyaDepth) || 0; }

  function go(hash, extra) {
    const st = Object.assign({ totoyaDepth: currentDepth() + 1 }, extra || {});
    history.pushState(st, '', hash);
    route();
  }

  function closeAll() {
    const depth = currentDepth();
    if (depth > 0) {
      history.go(-depth); // popstate → route() closes the dialog
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      route();
    }
  }

  function parseRoute() {
    let h = location.hash || '';
    try { h = decodeURIComponent(h); } catch (e) { /* keep raw */ }
    let m = /^#\/evento\/([^/?#]+)/.exec(h);
    if (m) return { type: 'evento', id: m[1] };
    m = /^#\/dia\/(\d{4}-\d{2}-\d{2})$/.exec(h);
    if (m) return { type: 'dia', key: m[1] };
    return { type: 'none' };
  }

  function route() {
    if (!state.data) return;
    const r = parseRoute();
    if (r.type === 'evento') renderEventDialog(r.id);
    else if (r.type === 'dia') renderDayDialog(r.key);
    else closeDialogUi();
  }

  // ------------------------------------------------------------------ events
  function setView(y, mo) {
    state.view = { y, mo };
    state.showPast = false;
    renderAll();
  }
  function shiftMonth(delta) {
    let { y, mo } = state.view;
    mo += delta;
    if (mo < 1) { mo = 12; y--; }
    if (mo > 12) { mo = 1; y++; }
    setView(y, mo);
  }
  function goToday() {
    setView(state.today.y, state.today.mo);
    const target = state.wide ? document.querySelector('.cell.is-today') : document.getElementById('agenda-today');
    const focusable = target && (target.querySelector('button') || target.querySelector('h3, .day-num'));
    if (target) target.scrollIntoView({ block: 'center' });
    if (focusable) {
      if (focusable.tagName !== 'BUTTON') focusable.setAttribute('tabindex', '-1');
      focusable.focus({ preventScroll: true });
    }
  }

  function bindEvents() {
    $('#prev-month').addEventListener('click', () => shiftMonth(-1));
    $('#next-month').addEventListener('click', () => shiftMonth(1));
    $('#today-btn').addEventListener('click', goToday);

    document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      state.filters.kind = b.dataset.kind;
      saveFilters(); renderAll();
    }));
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.filter;
      state.filters[k] = !state.filters[k];
      saveFilters(); renderAll();
    }));
    $('#clear-filters').addEventListener('click', clearFilters);

    // Delegated clicks for dynamically rendered content (page + dialog).
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const inDialog = !!t.closest('#dialog');
      const evBtn = t.closest('[data-ev]');
      if (evBtn) {
        e.preventDefault();
        openEvent(evBtn.dataset.ev, inDialog);
        return;
      }
      const dayBtn = t.closest('[data-day]');
      if (dayBtn) { go('#/dia/' + dayBtn.dataset.day); return; }
      if (t.closest('[data-clear-filters]')) { clearFilters(); return; }
      if (t.closest('[data-show-past]')) { state.showPast = true; renderCalendar(); return; }
      const gotoBtn = t.closest('[data-goto]');
      if (gotoBtn) {
        const sec = document.getElementById(gotoBtn.dataset.goto);
        if (sec) {
          sec.scrollIntoView({ block: 'start' });
          const h = sec.querySelector('h2');
          if (h) h.focus({ preventScroll: true });
        }
        return;
      }
      // Tapping anywhere on an event card opens it (links/buttons keep their own action).
      if (t.closest('a, button')) return;
      const card = t.closest('article[data-open]');
      if (card && !t.closest('.detail')) openEvent(card.dataset.open, inDialog);
    });

    const d = dlg();
    $('#dlg-close').addEventListener('click', closeAll);
    $('#dlg-back').addEventListener('click', () => history.back());
    d.addEventListener('cancel', (e) => { e.preventDefault(); closeAll(); });
    d.addEventListener('click', (e) => { if (e.target === d) closeAll(); }); // backdrop

    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);

    const mq = window.matchMedia(WIDE_QUERY);
    const onMq = () => {
      const wide = mq.matches;
      if (wide !== state.wide) { state.wide = wide; if (state.data) renderCalendar(); }
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq);
    window.addEventListener('resize', onMq);
    state.wide = mq.matches;
  }

  function openEvent(id, fromDialog) {
    const r = parseRoute();
    const extra = fromDialog && r.type === 'dia' ? { fromDay: r.key } : {};
    go('#/evento/' + encodeURIComponent(id), extra);
  }

  function clearFilters() {
    state.filters = Object.assign({}, DEFAULT_FILTERS);
    saveFilters(); renderAll();
  }

  // -------------------------------------------------------------------- init
  async function init() {
    loadFilters();
    bindEvents();
    state.today = nowPartsInBogota(new Date());
    state.today.hasTime = false;
    state.todayKey = keyOf(state.today);
    state.view = { y: state.today.y, mo: state.today.mo };
    renderFilterButtons();
    // On phones the legend starts collapsed to save space.
    const legend = document.querySelector('.legend');
    if (legend && !state.wide) legend.open = false;

    try {
      const { json, isSample } = await loadData();
      state.data = json;
      state.isSample = isSample;
      prepare(json);
    } catch (err) {
      $('#month-title').textContent = 'No pudimos cargar la agenda';
      $('#calendar').innerHTML = '<div class="empty"><p>No pudimos cargar las actividades. Revisa el internet e intenta otra vez.</p>' +
        '<button type="button" class="btn btn-primary" onclick="location.reload()">Intentar otra vez</button></div>';
      return;
    }

    // A deep link to an event opens its month underneath the dialog.
    const r = parseRoute();
    if (r.type === 'evento' && state.byId.has(r.id)) {
      const ev = state.byId.get(r.id);
      if (ev.span !== 'range') state.view = { y: ev._s.y, mo: ev._s.mo };
    } else if (r.type === 'dia') {
      const p = fromKey(r.key);
      if (p) state.view = { y: p.y, mo: p.mo };
    }
    renderAll();
    renderFooter();
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
