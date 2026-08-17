'use strict';

// Canonical environment namespace. Older aliases live only in this upgrade
// bridge so runtime modules and documentation can consistently use WORKMEOW_*.
const LEGACY_ALIASES = Object.freeze({
  NO_CODEX: ['LLMPET_NO_CODEX'],
  CODEX_DIR: ['LLMPET_CODEX_DIR'],
  WORKBUDDY_DIR: ['LLMPET_WORKBUDDY_DIR'],
  NO_TRAE: ['LLMPET_NO_TRAE'],
  TRAE_DIR: ['LLMPET_TRAE_DIR'],
  NO_OPENCODE: ['LLMPET_NO_OPENCODE'],
  OPENCODE_USAGE: ['LLMPET_OPENCODE_USAGE'],
  NO_HOOKS: ['OCTOPUS_NO_HOOKS'],
  NO_NET: ['OCTOPUS_NO_NET'],
  ALLOW_MULTI: ['OCTOPUS_ALLOW_MULTI'],
  DEBUG: ['OCTOPUS_DEBUG'],
});

function value(name, source = process.env) {
  const current = source[`WORKMEOW_${name}`];
  if (current !== undefined) return current;
  for (const alias of LEGACY_ALIASES[name] || []) {
    if (source[alias] !== undefined) return source[alias];
  }
  return undefined;
}

function flag(name, source = process.env) {
  return value(name, source) === '1';
}

module.exports = { LEGACY_ALIASES, value, flag };
