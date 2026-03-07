// ============================================================
// eventosCerca — Verificador de eventos con IA (Claude API)
// Analiza si un evento es real, coherente y publicable.
// Score >= 85 → auto-aprobado
// Score < 85  → cola de revisión humana
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Prompt del sistema ────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el verificador de eventos de eventosCerca, 
una app que muestra eventos culturales, deportivos y académicos locales 
gratuitos o de bajo costo en Ecuador.

Tu trabajo es analizar cada evento y devolver SOLO un JSON válido con:
{
  "score": (0-100, confianza en que el evento es real y publicable),
  "nota": "(explicación breve de máximo 150 caracteres)",
  "flags": ["lista de problemas encontrados, si hay alguno"]
}

Criterios para el score:
- 90-100: Evento completamente verificable, fuente confiable, fecha válida, info completa
- 75-89:  Evento probablemente real pero con algún dato faltante o poco claro
- 50-74:  Dudoso: fecha vaga, descripción muy corta, fuente desconocida
- 0-49:   Rechazar: spam evidente, fecha pasada, info incoherente, precio abusivo

Reglas absolutas:
- Nunca aprobar eventos del gobierno central (solo instituciones locales)
- Nunca aprobar eventos fuera de los próximos 72 horas
- Detectar si el "evento" es en realidad solo publicidad o contenido de redes
- Si tiene precio, verificar que el precio sea razonable (no más de $50 USD para un evento local)`;

// ── Analizar un evento con IA ─────────────────────────────────
export async function analizarConIA(id, evento) {
  try {
    const prompt = `Analiza este evento:
Título: ${evento.titulo}
Tipo: ${evento.tipo}
Fecha: ${evento.fecha_inicio}
Lugar: ${evento.lugar_nombre}
Descripción: ${evento.descripcion || '(sin descripción)'}
Fuente: ${evento.nombre_institucion || 'scraper automático'}
URL fuente: ${evento.fuente_url || 'no disponible'}
Gratuito: ${evento.es_gratuito ? 'Sí' : 'No'}
Precio: ${evento.precio_usd ? `$${evento.precio_usd} USD` : 'N/A'}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // modelo rápido y económico para verificación
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });

    const texto = response.content[0].text.trim();

    // Limpiar posibles backticks si el modelo los incluyó
    const jsonStr = texto.replace(/```json|```/g, '').trim();
    const resultado = JSON.parse(jsonStr);

    return {
      score: Math.max(0, Math.min(100, parseInt(resultado.score) || 0)),
      nota: resultado.nota || 'Análisis completado.',
      flags: resultado.flags || []
    };

  } catch (err) {
    logger.error('Error en analizarConIA:', err.message);
    // Si la IA falla, poner en cola de revisión humana con score bajo
    return {
      score: 60,
      nota: 'No se pudo analizar automáticamente. Requiere revisión manual.',
      flags: ['ia_error']
    };
  }
}

// ── Analizar cambio en un evento existente ────────────────────
// Detecta si hubo cambios importantes (cancelación, cambio de fecha/lugar)
export async function analizarCambio(eventoAnterior, eventoNuevo) {
  try {
    const prompt = `Compara estos dos estados del mismo evento y determina si hubo un cambio importante:

ANTES:
Título: ${eventoAnterior.titulo}
Fecha: ${eventoAnterior.fecha_inicio}
Lugar: ${eventoAnterior.lugar_nombre}
Estado: ${eventoAnterior.activo ? 'activo' : 'cancelado'}

AHORA:
Título: ${eventoNuevo.titulo}
Fecha: ${eventoNuevo.fecha_inicio}
Lugar: ${eventoNuevo.lugar_nombre}
Texto en página: ${eventoNuevo.textoOriginal?.slice(0, 300) || 'no disponible'}

Responde con JSON:
{
  "hay_cambio": true/false,
  "tipo_cambio": "cancelado|fecha_modificada|lugar_modificado|menor|ninguno",
  "descripcion": "descripción corta del cambio"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [{ role: 'user', content: prompt }]
    });

    const jsonStr = response.content[0].text.trim().replace(/```json|```/g, '');
    return JSON.parse(jsonStr);

  } catch (err) {
    logger.error('Error en analizarCambio:', err.message);
    return { hay_cambio: false, tipo_cambio: 'ninguno', descripcion: 'Error de análisis' };
  }
}
