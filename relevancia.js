// ============================================================
// eventosCerca — Índice de relevancia social
// Calcula 0-100 basado en señales de redes sociales.
// Pesos: shares 40%, comentarios 25%, likes 20%, medios 15%
// ============================================================

import { logger } from '../utils/logger.js';

// Umbrales para normalizar a 0-100 por tipo de evento
const UMBRALES = {
  shares: 200, likes: 1000, comments: 100, menciones_media: 5
};

export async function calcularRelevancia(evento) {
  try {
    let shares = 0, likes = 0, comments = 0, menciones = 0;

    // Intentar obtener señales de la URL del evento
    if (evento.fuente_url) {
      try {
        // Búsqueda básica de menciones vía nombre del evento
        // En producción se conectaría a APIs oficiales de Meta/X
        // con las claves de la app. Por ahora: estimación por heurística.
        const tituloCodificado = encodeURIComponent(evento.titulo);
        // (placeholder — en producción: llamada real a API)
        shares   = estimarSeñal('shares', evento.tipo);
        likes    = estimarSeñal('likes', evento.tipo);
        comments = estimarSeñal('comments', evento.tipo);
        menciones = estimarSeñal('menciones', evento.tipo);
      } catch (_) { /* señales no disponibles */ }
    }

    // Calcular índice ponderado
    const scoreShares  = Math.min(shares   / UMBRALES.shares,   1) * 40;
    const scoreLikes   = Math.min(likes    / UMBRALES.likes,    1) * 20;
    const scoreComment = Math.min(comments / UMBRALES.comments, 1) * 25;
    const scoreMedios  = Math.min(menciones/ UMBRALES.menciones_media, 1) * 15;

    const relevancia = Math.round(scoreShares + scoreLikes + scoreComment + scoreMedios);

    return {
      relevancia: Math.max(10, Math.min(100, relevancia)), // mínimo 10 para eventos aprobados
      shares_count: shares,
      likes_count: likes,
      comments_count: comments,
      menciones_media: menciones
    };

  } catch (err) {
    logger.error('Error calcularRelevancia:', err.message);
    return { relevancia: 10, shares_count: 0, likes_count: 0, comments_count: 0, menciones_media: 0 };
  }
}

// Estimación heurística mientras no hay APIs conectadas
function estimarSeñal(tipo, tipoEvento) {
  const base = { cultural: 1.4, deportivo: 1.2, academico: 0.8, lectura: 0.9 };
  const factor = base[tipoEvento] || 1;
  const ruido = Math.random() * 0.4 + 0.8; // 0.8 – 1.2
  const valores = { shares: 30, likes: 150, comments: 20, menciones: 1 };
  return Math.round((valores[tipo] || 10) * factor * ruido);
}
