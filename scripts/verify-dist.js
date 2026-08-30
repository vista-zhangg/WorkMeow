'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function artifactNames(version) {
  const prefix = `WorkMeow-${version}-Windows-x64`;
  return [`${prefix}.exe`, `${prefix}.exe.blockmap`, 'latest.yml', 'SHA256SUMS.txt'];
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyDist(options = {}) {
  const dist = options.dist || path.join(root, 'dist');
  const version = options.version || require(path.join(root, 'package.json')).version;
  const expected = artifactNames(version).sort();
  if (!fs.existsSync(dist)) throw new Error(`Missing build directory: ${dist}`);

  const entries = fs.readdirSync(dist, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error('dist must contain files only');
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected dist contents\nExpected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`);
  }

  const sumsFile = path.join(dist, 'SHA256SUMS.txt');
  const checksums = parseChecksums(fs.readFileSync(sumsFile, 'utf8'));
  const artifacts = expected.filter((name) => name !== 'SHA256SUMS.txt');
  if (checksums.size !== artifacts.length || artifacts.some((name) => !checksums.has(name))) {
    throw new Error('SHA256SUMS.txt does not cover the exact artifact set');
  }
  for (const name of artifacts) {
    const file = path.join(dist, name);
    if (fs.statSync(file).size <= 0) throw new Error(`Empty build artifact: ${name}`);
    if (sha256(file) !== checksums.get(name)) throw new Error(`SHA256 mismatch: ${name}`);
  }

  const prefix = `WorkMeow-${version}-Windows-x64`;
  const updateInfo = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(updateInfo)) {
    throw new Error(`latest.yml version is not ${version}`);
  }
  if (!updateInfo.includes(`url: ${prefix}.exe`) || !updateInfo.includes(`path: ${prefix}.exe`)) {
    throw new Error('latest.yml does not point to the current EXE installer');
  }
  const exeSize = fs.statSync(path.join(dist, `${prefix}.exe`)).size;
  if (!updateInfo.includes(`size: ${exeSize}`)) throw new Error('latest.yml EXE size is stale');

  const result = { dist, version, files: actual };
  if (options.quiet !== true) console.log(`Verified ${actual.length} WorkMeow ${version} dist file(s)`);
  return result;
}

if (require.main === module) {
  verifyDist();
}

module.exports = { artifactNames, parseChecksums, verifyDist };
