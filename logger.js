// utils/logger.js
export const logger = {
  info:  (msg, ...args) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`, ...args),
  warn:  (msg, ...args) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`, ...args),
};
