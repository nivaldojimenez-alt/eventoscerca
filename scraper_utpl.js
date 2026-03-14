// ============================================================
// eventosCerca — Scraper multi-fuente v3
// Fuentes:
//   1. UTPL                  — eventos.utpl.edu.ec
//   2. Cronometraje Inst.    — cronometrajeinstantaneo.com
//   3. Lo del Momento Loja   — lodelmomentoloja.com (RSS)
//   4. Municipio de Loja     — loja.gob.ec/eventos-culturales
//   5. Agenda Cultural CCE   — agendaculturalnacional.casadelacultura.gob.ec
// ============================================================

import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const UA = 'eventosCerca/1.0 (+https://eventoscerca.vercel.app)';

const COORDS = {
  utpl:      { lat: -3.9850, lon: -79.1950 },
  municipio: { lat: -3.9930, lon: -79.2045 },
  cce:       { lat: -3.9985, lon: -79.2055 },
  loja:      { lat: -3.9931, lon: -79.2042 },
};

const PALABRAS_LOJA = [
  'loja', 'vilcabamba', 'catamayo', 'cariamanga',
  'saraguro', 'celica', 'catacocha', 'alamor', 'gonzanamá', 'macará'
];

const PALABRAS_EVENTO = [
  'concierto', 'festival', 'feria', 'taller', 'conferencia', 'exposición',
  'presentación', 'inauguración', 'folklore', 'conversatorio', 'simposio',
  'carrera', 'torneo', 'campeonato', 'maratón', 'recital', 'espectáculo',
  'muestra', 'función', 'gala', 'seminario', 'obra de teatro', 'danza'
];

// ── Utilidades ────────────────────────────────────────────────

function hashEvento(titulo, fecha) {
  return crypto.createHash('md5').update(`${titulo}-${fecha}`).digest('hex');
}

async function eventoYaExiste(hash) {
  try {
    const { data } = await supabaseAdmin
      .from('eventos').select('id').eq('hash_contenido', hash).single();
    return !!data;
  } catch { return false; }
}

async function obtenerOCrearFuente(nombre, url) {
  try {
    const { data } = await supabaseAdmin
      .from('fuentes_institucionales').select('id').eq('nombre', nombre).single();
    if (data) return data.id;
  } catch {}
  const { data } = await supabaseAdmin
    .from('fuentes_institucionales')
    .insert({ nombre, url_base: url, tipo: 'cultural', activa: true, ciudad: 'Loja' })
    .select('id').single();
  return data?.id;
}

async function insertarEvento(evento, fuenteId) {
  const hash = hashEvento(evento.titulo, evento.fecha_inicio);
  if (await eventoYaExiste(hash)) return false;
  const { error } = await supabaseAdmin.from('eventos').insert({
    ...evento, estado: 'aprobado', activo: true,
    hash_contenido: hash, fuente_id: fuenteId, ciudad: 'Loja',
  });
  if (error) { console.error(`[SCRAPER] ❌`, error.message); return false; }
  console.log(`[SCRAPER] ✅ "${evento.titulo}"`);
  return true;
}

function parsearFechaEspanol(texto, hora = '') {
  if (!texto) return null;
  const meses = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  const m = texto.match(/(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?/i);
  if (!m) return null;
  const anio = m[3] ? parseInt(m[3]) : new Date().getFullYear();
  const mes = meses[m[2].toLowerCase()];
  if (!mes) return null;
  let h = 8, min = 0;
  const mh = hora.match(/(\d{1,2})[hH:](\d{2})?\s*(am|pm)?/i);
  if (mh) {
    h = parseInt(mh[1]); min = parseInt(mh[2] || '0');
    if (mh[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (mh[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  }
  return new Date(anio, mes-1, parseInt(m[1]), h, min).toISOString();
}

function parsearFechaDDMMYYYY(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), 8, 0).toISOString();
}

function parsearFechaICal(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]),
    parseInt(m[4]), parseInt(m[5])).toISOString();
}

function estaEnVentana72h(fechaIso) {
  if (!fechaIso) return false;
  const ahora = new Date();
  const fecha = new Date(fechaIso);
  return fecha >= ahora && fecha <= new Date(ahora.getTime() + 72*60*60*1000);
}

function esTextoDeEvento(texto) {
  return PALABRAS_EVENTO.some(p => texto.toLowerCase().includes(p));
}

function detectarTipo(texto) {
  const t = texto.toLowerCase();
  if (/carrera|ciclismo|maratón|atletismo|torneo|deporte|mtb|trail/.test(t)) return 'deportivo';
  if (/taller|conferencia|simposio|seminario|académico|investigación/.test(t)) return 'academico';
  if (/lectura|libro|biblioteca|cuento|literatura/.test(t)) return 'lectura';
  return 'cultural';
}

function esGratuito(texto) {
  if (/entrada libre|gratuito|gratis|libre|sin costo/i.test(texto)) return true;
  if (/\$|USD|precio|costo|entrada general|boleto/i.test(texto)) return false;
  return true; // por defecto asumir gratis para instituciones públicas
}

async function fetchHTML(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function limpiarHTML(html) {
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

// ── 1. Scraper UTPL ──────────────────────────────────────────

async function ejecutarScraperUTPL() {
  console.log('\n[UTPL] Iniciando...');
  const fuenteId = await obtenerOCrearFuente('UTPL Loja', 'https://eventos.utpl.edu.ec');
  const html = await fetchHTML('https://eventos.utpl.edu.ec/');
  const $ = cheerio.load(html);
  const urls = new Set();

  $('a[href*="eventos.utpl.edu.ec"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('categorias') && !href.includes('turisticos') &&
        !href.endsWith('/') && href.length > 35) urls.add(href);
  });

  let nuevos = 0;
  for (const url of [...urls].slice(0, 15)) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const html2 = await fetchHTML(url);
      const $d = cheerio.load(html2);
      const texto = $d('body').text();
      const titulo = $d('h1').first().text().trim();
      if (!titulo) continue;

      const fechaInicioTxt = texto.match(/Fecha de inicio[:\s]+([^\n]+)/i)?.[1]?.trim();
      const fechaFinTxt    = texto.match(/Fecha de finalización[:\s]+([^\n]+)/i)?.[1]?.trim();
      const horaTxt        = texto.match(/Hora[:\s]+([\d]+[hH:]\d*\s*(?:am|pm)?)/i)?.[1]?.trim();

      const fechaInicio = parsearFechaEspanol(fechaInicioTxt, horaTxt);
      if (!fechaInicio || !estaEnVentana72h(fechaInicio)) continue;

      const fechaFin = parsearFechaEspanol(fechaFinTxt || fechaInicioTxt, horaTxt) || fechaInicio;
      const lugarTxt = texto.match(/Descripción del lugar\s*([^\n]+)/i)?.[1]?.trim();
      const lugar = (lugarTxt && lugarTxt.length > 3) ? lugarTxt : 'Campus UTPL';
      const descripcion = texto.match(/Detalle del evento[:\s]*([^]*?)(?:Tipo de evento|Compartir|$)/i)
        ?.[1]?.trim().substring(0, 300) || `Evento UTPL. Más info: ${url}`;

      if (await insertarEvento({
        titulo, descripcion, tipo: 'academico',
        fecha_inicio: fechaInicio, fecha_fin: fechaFin,
        lugar_nombre: lugar.length < 4 ? 'Campus UTPL' : lugar,
        lugar_direccion: 'San Cayetano Alto, Loja',
        latitud: COORDS.utpl.lat, longitud: COORDS.utpl.lon,
        es_gratuito: true, precio_display: 'Gratis',
        relevancia: 75, origen: 'scraper_utpl',
      }, fuenteId)) nuevos++;
    } catch (e) { console.error(`[UTPL] ${e.message}`); }
  }
  console.log(`[UTPL] ${nuevos} nuevos`);
  return nuevos;
}

// ── 2. Scraper Cronometraje Instantáneo ──────────────────────

async function ejecutarScraperCronometraje() {
  console.log('\n[CRONOMETRAJE] Iniciando...');
  const fuenteId = await obtenerOCrearFuente(
    'Cronometraje Instantáneo', 'https://cronometrajeinstantaneo.com'
  );
  const html = await fetchHTML('https://cronometrajeinstantaneo.com/eventos/ecuador.html');
  const $ = cheerio.load(html);
  const promesas = [];

  $('h5').each((_, el) => {
    const bloque = $(el).closest('div, li, article');
    const titulo = $(el).text().trim();
    if (!titulo) return;
    const textoBloque = bloque.text();
    const fechaTxt = textoBloque.match(/\d{2}\/\d{2}\/\d{4}/)?.[0];
    const fechaInicio = parsearFechaDDMMYYYY(fechaTxt);
    if (!fechaInicio || !estaEnVentana72h(fechaInicio)) return;
    const lineas = textoBloque.split('\n').map(l => l.trim()).filter(Boolean);
    const idxFecha = lineas.findIndex(l => l.includes(fechaTxt || ''));
    const ciudad = lineas[idxFecha + 1] || '';
    if (!PALABRAS_LOJA.some(p => (titulo+' '+ciudad).toLowerCase().includes(p))) return;
    const href = bloque.find('a[href*="inscripciones"]').attr('href') || '';
    promesas.push(insertarEvento({
      titulo, descripcion: `Evento deportivo en ${ciudad}. Detalles: ${href}`,
      tipo: 'deportivo', fecha_inicio: fechaInicio, fecha_fin: fechaInicio,
      lugar_nombre: ciudad || 'Loja', lugar_direccion: `${ciudad}, Ecuador`,
      latitud: COORDS.loja.lat, longitud: COORDS.loja.lon,
      es_gratuito: false, precio_display: 'Ver inscripciones',
      relevancia: 70, origen: 'scraper_cronometraje',
    }, fuenteId));
  });

  const resultados = await Promise.all(promesas);
  const nuevos = resultados.filter(Boolean).length;
  console.log(`[CRONOMETRAJE] ${nuevos} nuevos`);
  return nuevos;
}

// ── 3. Scraper Lo del Momento Loja (RSS) ─────────────────────

async function ejecutarScraperLDM() {
  console.log('\n[LDM] Iniciando...');
  const fuenteId = await obtenerOCrearFuente(
    'Lo del Momento Loja', 'https://www.lodelmomentoloja.com'
  );
  const html = await fetchHTML('https://www.lodelmomentoloja.com/feed');
  const $ = cheerio.load(html, { xmlMode: true });
  let nuevos = 0;

  for (const item of $('item').toArray().slice(0, 20)) {
    const titulo = $(item).find('title').text().trim();
    const contenido = $(item).find('content\\:encoded, encoded').text()
      || $(item).find('description').text();
    if (!esTextoDeEvento(titulo)) continue;
    const texto = limpiarHTML(contenido);
    if (!PALABRAS_LOJA.some(p => (titulo+' '+texto).toLowerCase().includes(p))) continue;

    const fechaMatch = texto.match(/(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?/i);
    if (!fechaMatch) continue;
    const horaMatch = texto.match(/(\d{1,2})[hH:](\d{2})?\s*(am|pm)?/i);
    const fechaInicio = parsearFechaEspanol(fechaMatch[0], horaMatch?.[0] || '');
    if (!fechaInicio || !estaEnVentana72h(fechaInicio)) continue;

    const lugarMatch = texto.match(/(Teatro|Auditorio|Coliseo|Parque|Plaza|Hall|Complejo Ferial|Municipio)[^,.]{0,50}/i);
    const lugar = lugarMatch?.[0]?.trim() || 'Loja';

    if (await insertarEvento({
      titulo, descripcion: texto.substring(0, 300),
      tipo: detectarTipo(titulo + texto),
      fecha_inicio: fechaInicio, fecha_fin: fechaInicio,
      lugar_nombre: lugar.substring(0, 80),
      lugar_direccion: `${lugar}, Loja`,
      latitud: COORDS.loja.lat, longitud: COORDS.loja.lon,
      es_gratuito: esGratuito(texto), precio_display: esGratuito(texto) ? 'Gratis' : 'Ver detalles',
      relevancia: 80, origen: 'scraper_ldm',
    }, fuenteId)) nuevos++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[LDM] ${nuevos} nuevos`);
  return nuevos;
}

// ── 4. Scraper Municipio de Loja ─────────────────────────────

async function ejecutarScraperMunicipio() {
  console.log('\n[MUNICIPIO] Iniciando...');
  const fuenteId = await obtenerOCrearFuente('Municipio de Loja', 'https://www.loja.gob.ec');
  let nuevos = 0;

  // Intentar iCal primero
  try {
    const ical = await fetchHTML('https://www.loja.gob.ec/eventos-culturales?format=ical');
    if (ical.includes('BEGIN:VCALENDAR')) {
      for (const bloque of ical.split('BEGIN:VEVENT').slice(1)) {
        const get = (k) => bloque.match(new RegExp(`${k}[^:]*:([^\\r\\n]+)`))?.[1]?.trim() || '';
        const titulo = get('SUMMARY').replace(/\\,/g,',').replace(/\\n/g,' ');
        const fechaInicio = parsearFechaICal(get('DTSTART'));
        const fechaFin    = parsearFechaICal(get('DTEND')) || fechaInicio;
        const lugar = get('LOCATION').replace(/\\,/g,',') || 'Municipio de Loja';
        const descripcion = get('DESCRIPTION').replace(/\\n/g,' ').substring(0, 300);
        if (!titulo || !fechaInicio || !estaEnVentana72h(fechaInicio)) continue;
        if (await insertarEvento({
          titulo, descripcion, tipo: 'cultural',
          fecha_inicio: fechaInicio, fecha_fin: fechaFin,
          lugar_nombre: lugar.substring(0, 80), lugar_direccion: `${lugar}, Loja`,
          latitud: COORDS.municipio.lat, longitud: COORDS.municipio.lon,
          es_gratuito: true, precio_display: 'Gratis',
          relevancia: 85, origen: 'scraper_municipio',
        }, fuenteId)) nuevos++;
      }
      console.log(`[MUNICIPIO] ${nuevos} nuevos (iCal)`);
      return nuevos;
    }
  } catch {}

  // Fallback: HTML
  try {
    const html = await fetchHTML('https://www.loja.gob.ec/eventos-culturales');
    const $ = cheerio.load(html);
    $('.view-content .views-row, article.node-event, .event-item').each((_, el) => {
      const titulo = $(el).find('h2, h3, .field-title').first().text().trim();
      const fechaTxt = $(el).find('.date-display-single, .field-date, time').first().text().trim();
      const lugar = $(el).find('.field-location, .field-lugar').first().text().trim();
      if (!titulo || !fechaTxt) return;
      const fechaInicio = parsearFechaEspanol(fechaTxt);
      if (!fechaInicio || !estaEnVentana72h(fechaInicio)) return;
      insertarEvento({
        titulo, descripcion: $(el).find('p').first().text().trim().substring(0, 300),
        tipo: 'cultural', fecha_inicio: fechaInicio, fecha_fin: fechaInicio,
        lugar_nombre: lugar || 'Hall del Municipio de Loja',
        lugar_direccion: 'Centro Histórico, Loja',
        latitud: COORDS.municipio.lat, longitud: COORDS.municipio.lon,
        es_gratuito: true, precio_display: 'Gratis',
        relevancia: 85, origen: 'scraper_municipio',
      }, fuenteId).then(ok => { if (ok) nuevos++; });
    });
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) { console.log('[MUNICIPIO] HTML falló:', e.message); }

  console.log(`[MUNICIPIO] ${nuevos} nuevos`);
  return nuevos;
}

// ── 5. Scraper Agenda Cultural Nacional CCE ──────────────────

async function ejecutarScraperCCE() {
  console.log('\n[CCE] Iniciando...');
  const fuenteId = await obtenerOCrearFuente(
    'Casa de la Cultura Núcleo Loja',
    'https://agendaculturalnacional.casadelacultura.gob.ec'
  );

  // WordPress RSS filtrado por "loja"
  const rssUrl = 'https://agendaculturalnacional.casadelacultura.gob.ec/feed/?s=loja';
  const html = await fetchHTML(rssUrl);
  const $ = cheerio.load(html, { xmlMode: true });
  let nuevos = 0;

  for (const item of $('item').toArray().slice(0, 30)) {
    const titulo = $(item).find('title').text().trim();
    const link = $(item).find('link').text().trim();
    const contenido = $(item).find('content\\:encoded, encoded').text()
      || $(item).find('description').text();
    const texto = limpiarHTML(contenido);

    // Verificar que es de Loja
    if (!PALABRAS_LOJA.some(p => (titulo+' '+texto).toLowerCase().includes(p))) continue;

    // Extraer fecha y hora del contenido
    const fechaMatch = texto.match(/[Ff]echa[:\s]+([^.\n]+\d{4})/);
    const horaMatch = texto.match(/[Hh]ora[:\s]+([\d:hH]+\s*(?:am|pm)?)/);
    const fechaInicio = parsearFechaEspanol(
      fechaMatch?.[1]?.trim() || '',
      horaMatch?.[1]?.trim() || ''
    );
    if (!fechaInicio || !estaEnVentana72h(fechaInicio)) continue;

    // Extraer lugar
    const lugarMatch = texto.match(/[Ll]ugar[:\s]+([^.\n]+)/);
    const lugar = lugarMatch?.[1]?.trim() || 'Casa de la Cultura Núcleo Loja';

    if (await insertarEvento({
      titulo, descripcion: texto.substring(0, 300),
      tipo: detectarTipo(titulo + texto),
      fecha_inicio: fechaInicio, fecha_fin: fechaInicio,
      lugar_nombre: lugar.substring(0, 80),
      lugar_direccion: `${lugar}, Loja`,
      latitud: COORDS.cce.lat, longitud: COORDS.cce.lon,
      es_gratuito: esGratuito(texto), precio_display: esGratuito(texto) ? 'Gratis' : 'Ver detalles',
      relevancia: 88, origen: 'scraper_cce',
    }, fuenteId)) nuevos++;

    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`[CCE] ${nuevos} nuevos`);
  return nuevos;
}

// ── Función principal exportada ───────────────────────────────

export async function scrapearUTPL() {
  console.log('\n🤖 ===== SCRAPER INICIO:', new Date().toISOString(), '=====');
  let total = 0;

  for (const { nombre, fn } of [
    { nombre: 'UTPL',          fn: ejecutarScraperUTPL },
    { nombre: 'Cronometraje',  fn: ejecutarScraperCronometraje },
    { nombre: 'LDM Loja',      fn: ejecutarScraperLDM },
    { nombre: 'Municipio',     fn: ejecutarScraperMunicipio },
    { nombre: 'CCE Agenda',    fn: ejecutarScraperCCE },
  ]) {
    try { total += await fn(); }
    catch (e) { console.error(`[SCRAPER] ${nombre} falló:`, e.message); }
  }

  console.log(`\n🤖 ===== SCRAPER FIN — ${total} eventos nuevos =====\n`);
  return { nuevos: total };
}
