'use strict';

// 打工喵 WorkMeow transport — original implementation.
//
// Shared between the hook script and the server: a small set of localhost ports,
// a runtime file that records which port the running app bound, the identity
// header the hook uses to recognize our server, and the hook-to-server POST.
//
// The protocol facts this targets (Claude Code's hook command/HTTP shape, the
// PermissionRequest response JSON) are interfaces, not anyone's code — this file
// is written from scratch with WorkMeow's own protocol/ports/paths.

const fs = require('fs');
const path = require('path');
const http = require('http');
const BRAND = require('../shared/brand');
const { statePath, legacyStateDirs } = require('./paths');
const LEGACY_PROTOCOLS = require('./protocol-compat');

const SERVER_ID = BRAND.serverId;
const SERVER_HEADER = BRAND.serverHeader;
const TOKEN_HEADER = BRAND.tokenHeader;
const BASE_PORT = 41330;
const PORT_COUNT = 5;
const PORTS = Array.from({ length: PORT_COUNT }, (_, i) => BASE_PORT + i);
const STATE_PATH = '/state';
const PERMISSION_PATH = '/permission';
const RUNTIME_PATH = statePath('runtime.json');
const POST_TIMEOUT_MS = 120;
const PROTOCOLS = Object.freeze([
  Object.freeze({ serverId: SERVER_ID, serverHeader: SERVER_HEADER, tokenHeader: TOKEN_HEADER }),
  ...LEGACY_PROTOCOLS,
]);

function inRange(port) {
  const p = Number(port);
  return Number.isInteger(p) && PORTS.includes(p) ? p : null;
}

function validToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{48,128}$/i.test(token) ? token : null;
}

function readRuntimeConfig() {
  const candidates = [RUNTIME_PATH, ...legacyStateDirs().map((dir) => path.join(dir, 'runtime.json'))];
  for (const file of candidates) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const protocol = PROTOCOLS.find(({ serverId }) => obj && obj.app === serverId);
      const port = inRange(obj && obj.port);
      const token = validToken(obj && obj.token);
      if (protocol && port && token) return { app: protocol.serverId, port, token, tokenHeader: protocol.tokenHeader };
    } catch {}
  }
  return null;
}

function writeRuntimeConfig(port, token) {
  const p = inRange(port);
  const t = validToken(token);
  if (!p || !t) return false;
  try {
    fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
    const tmp = path.join(path.dirname(RUNTIME_PATH), `.runtime.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ app: SERVER_ID, port: p, token: t }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, RUNTIME_PATH);
    try { fs.chmodSync(RUNTIME_PATH, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function clearRuntimeConfig() {
  try { fs.unlinkSync(RUNTIME_PATH); return true; } catch { return false; }
}

// Candidate ports to try, runtime-recorded port first.
function getPortCandidates() {
  const out = [];
  const add = (p) => { const v = inRange(p); if (v && !out.includes(v)) out.push(v); };
  const runtime = readRuntimeConfig();
  add(runtime && runtime.port);
  PORTS.forEach(add);
  return out;
}

function buildPermissionUrl(port, token) {
  const base = `http://127.0.0.1:${inRange(port) || BASE_PORT}${PERMISSION_PATH}`;
  const t = validToken(token);
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

function headerIsOurs(res) {
  const headers = res && res.headers;
  if (!headers) return false;
  return PROTOCOLS.some(({ serverId, serverHeader }) => {
    const value = headers[serverHeader];
    return (Array.isArray(value) ? value[0] : value) === serverId;
  });
}

function tokenFromHeaders(headers) {
  if (!headers) return undefined;
  for (const { tokenHeader } of PROTOCOLS) {
    const value = headers[tokenHeader];
    if (value !== undefined) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function serverHeaders(extra = {}) {
  const out = { ...extra, [SERVER_HEADER]: SERVER_ID };
  for (const { serverId, serverHeader } of LEGACY_PROTOCOLS) out[serverHeader] = serverId;
  return out;
}

// Probe one port's GET /state; callback(true) if it's our server.
function probe(port, timeoutMs, cb) {
  const req = http.get({ hostname: '127.0.0.1', port, path: STATE_PATH, timeout: timeoutMs }, (res) => {
    res.resume();
    cb(headerIsOurs(res));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

// POST a state body to the first reachable WorkMeow server. Best-effort + fast:
// the hook must not block Claude Code, so it gives up quickly on each port.
function postState(body, cb) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const runtime = readRuntimeConfig();
  if (!runtime) { cb && cb(false); return; }
  const ports = getPortCandidates();
  let i = 0;
  const tryNext = () => {
    if (i >= ports.length) { cb && cb(false); return; }
    const port = ports[i++];
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: STATE_PATH, method: 'POST',
        timeout: POST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          [runtime.tokenHeader || TOKEN_HEADER]: runtime.token,
        },
      },
      (res) => {
        const ok = headerIsOurs(res) && res.statusCode >= 200 && res.statusCode < 300;
        res.resume();
        if (ok) cb && cb(true, port);
        else tryNext();
      }
    );
    req.on('error', tryNext);
    req.on('timeout', () => { req.destroy(); tryNext(); });
    req.end(payload);
  };
  tryNext();
}

module.exports = {
  SERVER_ID, SERVER_HEADER, TOKEN_HEADER, PORTS, BASE_PORT, STATE_PATH, RUNTIME_PATH,
  validToken, readRuntimeConfig, writeRuntimeConfig, clearRuntimeConfig,
  getPortCandidates, buildPermissionUrl, probe, postState,
  headerIsOurs, tokenFromHeaders, serverHeaders,
};
