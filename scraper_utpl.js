// ============================================================
// eventosCerca — Scraper multi-fuente
// Fuentes: UTPL + Cronometraje Instantáneo (deportes Loja)
// Se ejecuta automáticamente cada 3 horas desde server.js
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
  utpl:   { lat: -3.9850, lon: -79.1950 },
  loja:   { lat: -3.9931, lon: -79.2042 },
};

const PALABRAS_LOJA = [
  'loja', 'vilcabamba', 'catamayo', 'cariamanga',
  'saraguro', 'celica', 'catacocha', 'alamor'
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
    .insert({ nombre, url_base: url, tipo: 'academico', activa: true, ciudad: 'Loja' })
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
  if (error) { console.error(`[SCRAPER] Error:`, error.message); return false; }
  console.log(`[SCRAPER] ✅ ${evento.titulo}`);
  return true;
}

function parsearFechaEspanol(texto, hora = '') {
  if (!texto) return null;
  const meses = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  const m = texto.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  let h = 8, min = 0;
  const mh = hora.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (mh) {
    h = parseInt(mh[1]); min = parseInt(mh[2]);
    if (mh[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (mh[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  }
  const mes = meses[m[2].toLowerCase()];
  if (!mes) return null;
  return new Date(parseInt(m[3]), mes-1, parseInt(m[1]), h, min).toISOString();
}

function parsearFechaDDMMYYYY(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), 8, 0).toISOString();
}

function estaEnVentana72h(fechaIso) {
  if (!fechaIso) return false;
  const ahora = new Date();
  const fecha = new Date(fechaIso);
  const limite = new Date(ahora.getTime() + 72 * 60 * 60 * 1000);
  return fecha >= ahora && fecha <= limite;
}

// ── Scraper UTPL ──────────────────────────────────────────────

async function ejecutarScraperUTPL() {
  console.log('[UTPL] Iniciando...');
  const fuenteId = await obtenerOCrearFuente('UTPL Loja', 'https://eventos.utpl.edu.ec');
  const resp = await fetch('https://eventos.utpl.edu.ec/', { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`UTPL HTTP ${resp.status}`);

  const $ = cheerio.load(await resp.text());
  const urls = new Set();
  $('a[href*="eventos.utpl.edu.ec"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('categorias') && !href.includes('turisticos') &&
        !href.endsWith('/') && href.length > 30) urls.add(href);
  });

  let nuevos = 0;
  for (const url of [...urls].slice(0, 15)) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const r2 = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r2.ok) continue;
      const $d = cheerio.load(await r2.text());
      const texto = $d('body').text();
      const titulo = $d('h1').first().text().trim();
      if (!titulo) continue;

      const fechaInicioTxt = texto.match(/Fecha de inicio[:\s]+([^\n]+)/i)?.[1]?.trim();
      const fechaFinTxt = texto.match(/Fecha de finalización[:\s]+([^\n]+)/i)?.[1]?.trim();
      const horaTxt = texto.match(/Hora[:\s]+([\d:]+\s*(?:am|pm)?)/i)?.[1]?.trim();

      const fechaInicio = parsearFechaEspanol(fechaInicioTxt, horaTxt);
      if (!fechaInicio || !estaEnVentana72h(fechaInicio)) continue;

      const fechaFin = parsearFechaEspanol(fechaFinTxt || fechaInicioTxt, horaTxt) || fechaInicio;
      const lugarTxt = texto.match(/Descripción del lugar\s*([^\n]+)/i)?.[1]?.trim();
      const lugar = (lugarTxt && lugarTxt.length > 3) ? lugarTxt : 'Campus UTPL';
      const descripcion = texto.match(/Detalle del evento[:\s]*([^]*?)(?:Tipo de evento|Compartir|$)/i)?.[1]?.trim().substring(0, 300)
        || `Evento UTPL. Más info: ${url}`;

      const ok = await insertarEvento({
        titulo, descripcion, tipo: 'academico',
        fecha_inicio: fechaInicio, fecha_fin: fechaFin,
        lugar_nombre: lugar.length < 4 ? 'Campus UTPL' : lugar,
        lugar_direccion: 'San Cayetano Alto, Loja',
        latitud: COORDS.utpl.lat, longitud: COORDS.utpl.lon,
        es_gratuito: true, precio_display: 'Gratis',
        relevancia: 75, origen: 'scraper_utpl',
      }, fuenteId);
      if (ok) nuevos++;
    } catch (e) { console.error(`[UTPL] Error ${url}:`, e.message); }
  }
  console.log(`[UTPL] ${nuevos} nuevos`);
  return nuevos;
}

// ── Scraper Cronometraje Instantáneo ─────────────────────────

async function ejecutarScraperCronometraje() {
  console.log('[CRONOMETRAJE] Iniciando...');
  const fuenteId = await obtenerOCrearFuente(
    'Cronometraje Instantáneo', 'https://cronometrajeinstantaneo.com'
  );

  const resp = await fetch('https://cronometrajeinstantaneo.com/eventos/ecuador.html', {
    headers: { 'User-Agent': UA }
  });
  if (!resp.ok) throw new Error(`Cronometraje HTTP ${resp.status}`);

  const $ = cheerio.load(await resp.text());
  const promesas = [];

  $('h5').each((_, el) => {
    const bloque = $(el).closest('div, li, article');
    const titulo = $(el).text().trim();
    if (!titulo) return;

    const textoBloque = bloque.text();
    const fechaTxt = textoBloque.match(/\d{2}\/\d{2}\/\d{4}/)?.[0];
    const fechaInicio = parsearFechaDDMMYYYY(fechaTxt);
    if (!fechaInicio || !estaEnVentana72h(fechaInicio)) return;

    // Ciudad — línea después de la fecha en el bloque
    const lineas = textoBloque.split('\n').map(l => l.trim()).filter(Boolean);
    const idxFecha = lineas.findIndex(l => l.includes(fechaTxt || ''));
    const ciudad = lineas[idxFecha + 1] || '';

    // Solo eventos de Loja
    const textoLower = (titulo + ' ' + ciudad).toLowerCase();
    if (!PALABRAS_LOJA.some(p => textoLower.includes(p))) return;

    const href = bloque.find('a[href*="inscripciones"]').attr('href') || '';

    promesas.push(insertarEvento({
      titulo,
      descripcion: `Evento deportivo en ${ciudad}. Detalles: ${href}`,
      tipo: 'deportivo',
      fecha_inicio: fechaInicio, fecha_fin: fechaInicio,
      lugar_nombre: ciudad || 'Loja',
      lugar_direccion: `${ciudad}, Ecuador`,
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

// ── Exportación principal ─────────────────────────────────────

export async function scrapearUTPL() {
  console.log('\n🤖 [SCRAPER] Ciclo:', new Date().toISOString());
  let total = 0;
  try { total += await ejecutarScraperUTPL(); }
  catch (e) { console.error('[SCRAPER] UTPL falló:', e.message); }
  try { total += await ejecutarScraperCronometraje(); }
  catch (e) { console.error('[SCRAPER] Cronometraje falló:', e.message); }
  console.log(`🤖 [SCRAPER] Total nuevos: ${total}\n`);
  return { nuevos: total };
}
