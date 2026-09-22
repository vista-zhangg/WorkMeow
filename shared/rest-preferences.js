'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowRestPreferences = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const DEFAULTS = Object.freeze({
    enabled: true,
    waterEnabled: true,
    waterMinutes: 45,
    stretchEnabled: true,
    stretchMinutes: 60,
    eyesEnabled: false,
    eyesMinutes: 20,
    snoozeMinutes: 10,
  });
  const MIN_MINUTES = 5;
  const MAX_MINUTES = 240;

  function sanitizePreferences(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (typeof fallback === 'boolean') {
        result[key] = typeof source[key] === 'boolean' ? source[key] : fallback;
      } else {
        const value = source[key];
        const number = typeof value === 'number' || (typeof value === 'string' && value.trim())
          ? Number(value) : NaN;
        result[key] = Number.isFinite(number)
          ? Math.max(key === 'snoozeMinutes' ? 1 : MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(number))) : fallback;
      }
    }
    return result;
  }

  return { DEFAULTS, MIN_MINUTES, MAX_MINUTES, sanitizePreferences };
});
