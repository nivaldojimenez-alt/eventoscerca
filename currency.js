// ============================================================
// eventosCerca — Servicio de conversión de moneda
// Caché local de 1 hora. Fuente: ExchangeRate-API (plan free)
// ============================================================

import { logger } from '../utils/logger.js';

let cacheMoneda = {};        // { "USD_PEN": { tasa, ts } }
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

export async function convertirPrecio(cantidad, origen, destino) {
  if (origen === destino) return { cantidad, moneda: destino, display: formatearPrecio(cantidad, destino) };

  const clave = `${origen}_${destino}`;
  const ahora = Date.now();

  // Usar caché si está fresca
  if (cacheMoneda[clave] && (ahora - cacheMoneda[clave].ts) < CACHE_TTL_MS) {
    const resultado = cantidad * cacheMoneda[clave].tasa;
    return { cantidad: resultado, moneda: destino, display: formatearPrecio(resultado, destino) };
  }

  // Consultar API externa
  try {
    const url = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGERATE_API_KEY}/pair/${origen}/${destino}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();

    if (data.result === 'success') {
      const tasa = data.conversion_rate;
      cacheMoneda[clave] = { tasa, ts: ahora };
      const resultado = cantidad * tasa;
      return { cantidad: resultado, moneda: destino, display: formatearPrecio(resultado, destino) };
    }
  } catch (err) {
    logger.error('Error conversión moneda:', err.message);
  }

  // Fallback: devolver en USD si falla la conversión
  return { cantidad, moneda: 'USD', display: formatearPrecio(cantidad, 'USD') };
}

function formatearPrecio(cantidad, moneda) {
  const simbolos = { USD:'$', PEN:'S/', COP:'$', BRL:'R$', EUR:'€', MXN:'$' };
  const decimales = moneda === 'COP' ? 0 : 2;
  const simbolo = simbolos[moneda] || moneda + ' ';
  return `${simbolo}${cantidad.toFixed(decimales)} ${moneda}`;
}
