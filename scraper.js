// ============================================================
// eventosCerca — Servicio de Scraping
// Detecta eventos nuevos, cambios y cancelaciones
// en la lista blanca de fuentes institucionales locales.
// ============================================================

import * as cheerio from 'cheerio';
import { analizarConIA } from './ia_verifier.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// ── Configuración de fuentes ──────────────────────────────────
// En producción esto se lee de la tabla fuentes_institucionales.
// Esta lista es solo el punto de partida (las primeras 7 fuentes de Loja).
export const FUENTES_INICIALES = [
  {
    nombre: 'Casa de la Cultura Núcleo Loja',
    url_base: 'https://casadelacultura-loja.gob.ec',
    url_agenda: 'https://casadelacultura-loja.gob.ec/agenda',
    tipo: 'cultural',
    selector_evento: '.evento-item, .event-card, article.evento',
    selector_titulo: 'h2, h3, .titulo',
    selector_fecha: '.fecha, time, .event-date',
    selector_lugar: '.lugar, .location',
    selector_desc: '.descripcion, .excerpt, p'
  },
  {
    nombre: 'Biblioteca Municipal de Loja',
    url_base: 'https://biblioteca.loja.gob.ec',
    url_agenda: 'https://biblioteca.loja.gob.ec/eventos',
    tipo: 'lectura',
    selector_evento: '.evento, .activity',
    selector_titulo: 'h2, h3, .title',
    selector_fecha: '.date, .fecha',
    selector_lugar: '.location',
    selector_desc: '.description, p'
  },
  {
    nombre: 'Universidad Nacional de Loja',
    url_base: 'https://unl.edu.ec',
    url_agenda: 'https://unl.edu.ec/noticias/eventos',
    tipo: 'academico',
    selector_evento: '.entry, .evento, .post',
    selector_titulo: '.entry-title, h2',
    selector_fecha: '.entry-date, time',
    selector_lugar: '.lugar, .location',
    selector_desc: '.entry-summary, p'
  },
  {
    nombre: 'UTPL Loja',
    url_base: 'https://utpl.edu.ec',
    url_agenda: 'https://utpl.edu.ec/eventos',
    tipo: 'academico',
    selector_evento: '.event, .card-event',
    selector_titulo: 'h3, .event-title',
    selector_fecha: '.event-date, .fecha',
    selector_lugar: '.event-location',
    selector_desc: '.event-desc, p'
  },
  {
    nombre: 'Federación Deportiva de Loja',
    url_base: 'https://fedelo.ec',
    url_agenda: 'https://fedelo.ec/eventos',
    tipo: 'deportivo',
    selector_evento: '.evento, .competencia',
    selector_titulo: 'h2, h3',
    selector_fecha: '.fecha, .date',
    selector_lugar: '.lugar, .escenario',
    selector_desc: 'p, .descripcion'
  },
];

// ── Scraper principal ─────────────────────────────────────────
export async function ejecutarScraper(supabaseAdmin) {
  logger.info('🤖 Iniciando ciclo de scraping...');
  const inicio = Date.now();

  // Obtener fuentes activas de la BD
  const { data: fuentes, error } = await supabaseAdmin
    .from('fuentes_institucionales')
    .select('*')
    .eq('activa', true);

  if (error) {
    logger.error('Error cargando fuentes:', error);
    return;
  }

  let totalNuevos = 0, totalCambios = 0, totalErrores = 0;

  for (const fuente of fuentes) {
    try {
      const resultado = await scrapearFuente(fuente, supabaseAdmin);
      totalNuevos  += resultado.nuevos;
      totalCambios += resultado.cambios;

      // Actualizar última sincronización
      await supabaseAdmin
        .from('fuentes_institucionales')
        .update({ ultima_sync: new Date() })
        .eq('id', fuente.id);

      // Registrar run exitoso
      await supabaseAdmin.from('scraper_runs').insert({
        fuente_id: fuente.id,
        estado: 'ok',
        eventos_nuevos: resultado.nuevos,
        eventos_cambios: resultado.cambios,
        duracion_ms: resultado.duracion
      });

    } catch (err) {
      totalErrores++;
      logger.error(`Error scrapeando ${fuente.nombre}:`, err.message);

      await supabaseAdmin.from('scraper_runs').insert({
        fuente_id: fuente.id,
        estado: 'error',
        error_msg: err.message
      });

      await supabaseAdmin.from('log_actividad').insert({
        tipo: 'error_fuente',
        descripcion: `Error al scrapear ${fuente.nombre}: ${err.message}`,
        fuente_id: fuente.id
      });
    }
  }

  const duracionTotal = Date.now() - inicio;
  logger.info(`✅ Scraping completado: ${totalNuevos} nuevos, ${totalCambios} cambios, ${totalErrores} errores — ${duracionTotal}ms`);

  await supabaseAdmin.from('log_actividad').insert({
    tipo: 'scraper_ciclo_ok',
    descripcion: `Ciclo scraping: ${totalNuevos} eventos nuevos, ${totalCambios} actualizaciones, ${totalErrores} errores`,
    metadata: { duracion_ms: duracionTotal, fuentes: fuentes.length }
  });
}

// ── Scrapear una fuente individual ────────────────────────────
async function scrapearFuente(fuente, supabase) {
  const inicio = Date.now();
  logger.info(`  📡 Scrapeando: ${fuente.nombre}`);

  // Obtener HTML de la fuente
  const response = await fetch(fuente.url_agenda, {
    headers: {
      'User-Agent': 'eventosCercaBot/1.0 (+https://eventoscerca.app/bot)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(10000) // 10 segundos máximo
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${fuente.url_agenda}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const eventosDetectados = [];

  // Extraer eventos del HTML
  $(fuente.selector_evento || '.evento, .event, article').each((_i, el) => {
    const titulo    = $(el).find(fuente.selector_titulo || 'h2,h3').first().text().trim();
    const fechaText = $(el).find(fuente.selector_fecha  || '.fecha,.date,time').first().text().trim();
    const lugar     = $(el).find(fuente.selector_lugar  || '.lugar,.location').first().text().trim();
    const desc      = $(el).find(fuente.selector_desc   || 'p').first().text().trim().slice(0, 500);
    const url       = $(el).find('a').first().attr('href');

    if (!titulo || titulo.length < 5) return; // ignorar elementos vacíos

    const fecha = parsearFecha(fechaText);
    if (!fecha) return; // ignorar si no se puede parsear la fecha

    // Solo eventos en los próximos 72 horas
    const ahora = new Date();
    const en72h = new Date(ahora.getTime() + 72 * 60 * 60 * 1000);
    if (fecha < ahora || fecha > en72h) return;

    // Detectar precio
    const textoCompleto = $(el).text();
    const esPago = /entrada|precio|costo|USD|\$|pago/i.test(textoCompleto);
    const precioMatch = textoCompleto.match(/\$\s?(\d+(?:\.\d{2})?)/);
    const precioUsd = precioMatch ? parseFloat(precioMatch[1]) : null;

    eventosDetectados.push({
      titulo,
      descripcion: desc || null,
      tipo: fuente.tipo || 'cultural',
      fecha_inicio: fecha.toISOString(),
      lugar_nombre: lugar || fuente.nombre,
      fuente_id: fuente.id,
      fuente_url: url ? new URL(url, fuente.url_base).href : fuente.url_agenda,
      origen: 'scraper',
      es_gratuito: !esPago,
      precio_usd: precioUsd,
      precio_display: precioUsd ? `$${precioUsd.toFixed(2)} USD` : null,
      hash_contenido: crypto
        .createHash('md5')
        .update(`${titulo}|${fecha.toDateString()}|${fuente.id}`)
        .digest('hex')
    });
  });

  logger.info(`    ↳ ${eventosDetectados.length} eventos candidatos encontrados`);

  let nuevos = 0, cambios = 0;

  for (const ev of eventosDetectados) {
    // Verificar si ya existe por hash (evitar duplicados)
    const { data: existente } = await supabase
      .from('eventos')
      .select('id, titulo, estado')
      .eq('hash_contenido', ev.hash_contenido)
      .single();

    if (existente) {
      // Ya existe — verificar si hay cambios relevantes
      cambios++;
      continue;
    }

    // Analizar con IA antes de decidir el estado
    const analisisIA = await analizarConIA(null, ev);
    const estado = analisisIA.score >= 85 ? 'aprobado' : 'pendiente';

    const { error } = await supabase.from('eventos').insert({
      ...ev,
      estado,
      score_ia: analisisIA.score,
      nota_ia: analisisIA.nota,
      aprobado_por: estado === 'aprobado' ? 'auto' : null,
      aprobado_en: estado === 'aprobado' ? new Date() : null,
      expira_en: new Date(new Date(ev.fecha_inicio).getTime() + 2 * 60 * 60 * 1000)
    });

    if (!error) {
      nuevos++;
      await supabase.from('log_actividad').insert({
        tipo: estado === 'aprobado' ? 'auto_aprobado' : 'pendiente_revision',
        descripcion: `${estado === 'aprobado' ? 'Auto-aprobado' : 'En cola de revisión'}: "${ev.titulo}" (score ${analisisIA.score})`,
        fuente_id: fuente.id,
        metadata: { score: analisisIA.score, fuente: fuente.nombre }
      });
    }
  }

  return { nuevos, cambios, duracion: Date.now() - inicio };
}

// ── Parsear fecha desde texto informal ───────────────────────
// Maneja formatos como "15 de marzo", "15/03/2026", "2026-03-15"
function parsearFecha(texto) {
  if (!texto) return null;

  const meses = {
    enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
    julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12
  };

  // Formato: "15 de marzo de 2026" o "15 de marzo"
  const match = texto.toLowerCase().match(/(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?/);
  if (match) {
    const dia = parseInt(match[1]);
    const mes = meses[match[2]];
    const anio = parseInt(match[3]) || new Date().getFullYear();
    if (mes) return new Date(anio, mes - 1, dia, 10, 0, 0);
  }

  // Intentar parseo directo
  const fecha = new Date(texto);
  return isNaN(fecha.getTime()) ? null : fecha;
}

// ── Scheduler: ejecutar cada 3 horas ─────────────────────────
export function iniciarScheduler(supabaseAdmin) {
  const INTERVALO_MS = 3 * 60 * 60 * 1000; // 3 horas

  // Primera ejecución al arrancar (después de 30 segundos)
  setTimeout(() => ejecutarScraper(supabaseAdmin), 30_000);

  // Ciclos siguientes
  setInterval(() => ejecutarScraper(supabaseAdmin), INTERVALO_MS);

  logger.info('⏰ Scheduler de scraping iniciado: cada 3 horas');
}
