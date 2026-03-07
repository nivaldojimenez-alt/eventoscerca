// ============================================================
// eventosCerca — API Backend
// Runtime: Node.js + Express
// Base de datos: Supabase (PostgreSQL + PostGIS)
// Despliegue: Railway o Render (plan gratuito)
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { convertirPrecio } from './currency.js';
import { calcularRelevancia } from './relevancia.js';
import { analizarConIA } from './ia_verifier.js';
import { logger } from './logger.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Supabase (dos clientes: público y admin) ──────────────────
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY   // solo lectura pública
);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // escritura — solo servidor
);

// ── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10kb' }));

// Rate limiting: 60 req/min por IP (sin auth de usuario)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta en un minuto.' }
});
app.use('/api/', limiter);

// ── MIDDLEWARE: detectar moneda por país ─────────────────────
// Se infiere del header Accept-Language o del parámetro ?pais=
// NUNCA se guarda la IP ni el país del usuario.
function detectarMoneda(req, _res, next) {
  const pais = req.query.pais || req.headers['x-pais'] || 'EC';
  const monedasPorPais = {
    EC: 'USD', PE: 'PEN', CO: 'COP',
    BR: 'BRL', MX: 'MXN', DE: 'EUR', ES: 'EUR'
  };
  req.moneda = monedasPorPais[pais.toUpperCase()] || 'USD';
  next();
}

// ============================================================
// RUTAS PÚBLICAS (app del usuario)
// ============================================================

// GET /api/eventos
// Devuelve eventos en un radio dado. Sin auth, sin cookies.
app.get('/api/eventos', detectarMoneda, async (req, res) => {
  try {
    const {
      lat, lon,
      radio = 3,      // km, por defecto 3
      tipo,           // cultural|deportivo|academico|lectura
      page = 1,
      limit = 20
    } = req.query;

    // Validar coordenadas
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);
    const radioN = Math.min(parseFloat(radio) || 3, 10); // máx 10 km

    if (isNaN(latN) || isNaN(lonN)) {
      return res.status(400).json({ error: 'Se requieren coordenadas lat y lon válidas.' });
    }

    // Llamar a la función PostGIS
    const { data: eventos, error } = await supabasePublic.rpc('buscar_eventos_por_radio', {
      lat: latN,
      lon: lonN,
      radio_km: radioN,
      tipo_filtro: tipo || null
    });

    if (error) throw error;

    // Convertir precios a moneda local del usuario
    const eventosConPrecio = await Promise.all(
      (eventos || []).map(async (ev) => {
        if (!ev.es_gratuito && ev.precio_usd) {
          ev.precio_local = await convertirPrecio(ev.precio_usd, 'USD', req.moneda);
          ev.moneda_local = req.moneda;
        }
        return ev;
      })
    );

    // Paginación simple
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const pagina = eventosConPrecio.slice(offset, offset + parseInt(limit));

    res.json({
      ok: true,
      total: eventosConPrecio.length,
      pagina: parseInt(page),
      radio_km: radioN,
      moneda: req.moneda,
      eventos: pagina
    });

  } catch (err) {
    logger.error('GET /api/eventos', err);
    res.status(500).json({ error: 'Error al obtener eventos.' });
  }
});

// GET /api/eventos/:id
// Detalle completo de un evento específico
app.get('/api/eventos/:id', detectarMoneda, async (req, res) => {
  try {
    const { data, error } = await supabasePublic
      .from('eventos')
      .select(`*, fuentes_institucionales(nombre, url_base)`)
      .eq('id', req.params.id)
      .eq('estado', 'aprobado')
      .eq('activo', true)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Evento no encontrado.' });

    if (!data.es_gratuito && data.precio_usd) {
      data.precio_local = await convertirPrecio(data.precio_usd, 'USD', req.moneda);
      data.moneda_local = req.moneda;
    }

    res.json({ ok: true, evento: data });
  } catch (err) {
    logger.error('GET /api/eventos/:id', err);
    res.status(500).json({ error: 'Error al obtener el evento.' });
  }
});

// GET /api/bibliotecas
// Directorio de bibliotecas cercanas
app.get('/api/bibliotecas', async (req, res) => {
  try {
    const { lat, lon, radio = 5 } = req.query;
    const latN = parseFloat(lat);
    const lonN = parseFloat(lon);

    let query = supabasePublic
      .from('bibliotecas')
      .select('*')
      .eq('activa', true);

    // Si hay coordenadas, filtrar por distancia (aproximación simple)
    // La búsqueda PostGIS precisa se hace vía RPC igual que eventos
    const { data, error } = await query;
    if (error) throw error;

    res.json({ ok: true, total: data.length, bibliotecas: data });
  } catch (err) {
    logger.error('GET /api/bibliotecas', err);
    res.status(500).json({ error: 'Error al obtener bibliotecas.' });
  }
});

// POST /api/sugerencias
// Cualquier persona u organización puede sugerir un evento.
// NO requiere auth. NO guarda datos de quien sugiere (salvo email
// opcional para notificar la aprobación, que se borra después).
app.post('/api/sugerencias', async (req, res) => {
  try {
    const {
      titulo, descripcion, tipo, fecha_inicio, fecha_fin,
      lugar_nombre, lugar_direccion, es_gratuito, precio_desc,
      nombre_institucion, url_institucion, contacto_email
    } = req.body;

    // Validación básica
    if (!titulo || !tipo || !fecha_inicio || !lugar_nombre || !nombre_institucion) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    // Validar tipo
    const tiposValidos = ['cultural','deportivo','academico','lectura'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de evento no válido.' });
    }

    // Validar que la fecha es dentro de los próximos 30 días
    const fecha = new Date(fecha_inicio);
    const ahora = new Date();
    const en30dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (fecha < ahora || fecha > en30dias) {
      return res.status(400).json({ error: 'La fecha debe ser dentro de los próximos 30 días.' });
    }

    // Análisis de IA (async, no bloquea la respuesta)
    const sugerenciaData = {
      titulo, descripcion, tipo, fecha_inicio, fecha_fin,
      lugar_nombre, lugar_direccion,
      es_gratuito: es_gratuito !== false,
      precio_desc,
      nombre_institucion, url_institucion,
      contacto_email: contacto_email || null,
      estado: 'nueva'
    };

    // Insertar en BD
    const { data, error } = await supabaseAdmin
      .from('sugerencias')
      .insert(sugerenciaData)
      .select('id')
      .single();

    if (error) throw error;

    // Analizar con IA en segundo plano (no esperar resultado)
    analizarConIA(data.id, sugerenciaData).catch(err =>
      logger.error('Error análisis IA sugerencia:', err)
    );

    res.status(201).json({
      ok: true,
      mensaje: 'Sugerencia recibida. Será revisada en menos de 24 horas.',
      id: data.id
    });

  } catch (err) {
    logger.error('POST /api/sugerencias', err);
    res.status(500).json({ error: 'Error al registrar sugerencia.' });
  }
});

// GET /api/tipos-cambio
// Devuelve tasas de cambio actuales (caché de 1 hora)
app.get('/api/tipos-cambio', async (req, res) => {
  try {
    const { data, error } = await supabasePublic
      .from('tipos_cambio')
      .select('moneda_destino, tasa, actualizado_en');
    if (error) throw error;
    res.json({ ok: true, base: 'USD', tasas: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener tipos de cambio.' });
  }
});

// ============================================================
// RUTAS DE ADMIN (requieren API key interna)
// Solo accesibles desde el panel de administración.
// ============================================================

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

// GET /admin/cola
// Eventos pendientes de revisión humana
app.get('/admin/cola', requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('eventos')
      .select(`*, fuentes_institucionales(nombre)`)
      .eq('estado', 'pendiente')
      .eq('activo', true)
      .order('creado_en', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, total: data.length, eventos: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener cola.' });
  }
});

// PATCH /admin/eventos/:id/aprobar
app.patch('/admin/eventos/:id/aprobar', requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('eventos')
      .update({ estado: 'aprobado', aprobado_por: 'admin', aprobado_en: new Date() })
      .eq('id', req.params.id)
      .select('id, titulo')
      .single();
    if (error) throw error;
    await supabaseAdmin.from('log_actividad').insert({
      tipo: 'aprobado_manual', descripcion: `Evento aprobado por admin: ${data.titulo}`, evento_id: data.id
    });
    res.json({ ok: true, mensaje: 'Evento aprobado y publicado.', evento: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al aprobar evento.' });
  }
});

// PATCH /admin/eventos/:id/rechazar
app.patch('/admin/eventos/:id/rechazar', requireAdminKey, async (req, res) => {
  try {
    const { motivo } = req.body;
    const { data, error } = await supabaseAdmin
      .from('eventos')
      .update({ estado: 'rechazado', nota_ia: motivo || 'Rechazado por admin' })
      .eq('id', req.params.id)
      .select('id, titulo')
      .single();
    if (error) throw error;
    await supabaseAdmin.from('log_actividad').insert({
      tipo: 'rechazado_manual', descripcion: `Evento rechazado: ${data.titulo}. Motivo: ${motivo || 'sin motivo'}`, evento_id: data.id
    });
    res.json({ ok: true, mensaje: 'Evento rechazado.' });
  } catch (err) {
    res.status(500).json({ error: 'Error al rechazar evento.' });
  }
});

// POST /admin/scrapers/ejecutar
// Ejecuta manualmente el ciclo de scraping
app.post('/admin/scrapers/ejecutar', requireAdminKey, async (req, res) => {
  try {
    const { ejecutarScraper } = await import('./scraper.js');
    res.json({ ok: true, mensaje: 'Scraper iniciado en segundo plano.' });
    ejecutarScraper(supabaseAdmin).catch(err => logger.error('Error scraper manual:', err));
  } catch (err) {
    res.status(500).json({ error: 'Error al iniciar scraper.' });
  }
});

// GET /admin/log
app.get('/admin/log', requireAdminKey, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const { data, error } = await supabaseAdmin
      .from('log_actividad')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(parseInt(limit));
    if (error) throw error;
    res.json({ ok: true, log: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener log.' });
  }
});

// ── Healthcheck ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date() }));

// ── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// ── Inicio ──────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 eventosCerca API corriendo en puerto ${PORT}`);
});

export default app;
