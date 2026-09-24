'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');

function artifactNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  return [`AgentPaw-${version}-Windows-x64.exe`, 'latest.yml'];
}

// Also used before cleanup: a missing, incomplete or mismatched new build must
// never cause a valid old installer to be removed.
function verifyArtifacts(options = {}) {
  const dist = path.resolve(options.dist || path.join(root, 'dist'));
  const version = options.version || require(path.join(root, 'package.json')).version;
  const files = artifactNames(version);
  for (const name of files) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Missing build artifact: ${name}`);
    if (fs.statSync(file).size === 0) throw new Error(`Empty build artifact: ${name}`);
  }
  const exe = fs.readFileSync(path.join(dist, files[0]));
  const peOffset = exe.length >= 64 ? exe.readUInt32LE(60) : -1;
  if (exe.toString('ascii', 0, 2) !== 'MZ' || peOffset < 64 || peOffset + 4 > exe.length
      || exe.readUInt32LE(peOffset) !== 0x4550) throw new Error('Invalid Windows PE installer');
  const updateFile = fs.readFileSync(path.join(dist, 'latest.yml'));
  if (updateFile.length > 32768) throw new Error('Update metadata is unexpectedly large');
  const info = yaml.load(updateFile.toString('utf8'), { schema: yaml.JSON_SCHEMA });
  if (!info || info.version !== version) throw new Error(`latest.yml version is not ${version}`);
  if (!Array.isArray(info.files) || info.files.length !== 1 || info.files[0].url !== files[0]
      || info.path !== files[0]) throw new Error('latest.yml must reference only the current installer');
  const missingSize = info.files[0].size == null && options.allowMissingSize === true;
  if (!missingSize && info.files[0].size !== exe.length) throw new Error('latest.yml EXE size is stale');
  const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
  if (info.files[0].sha512 !== sha512 || info.sha512 !== sha512) throw new Error('latest.yml SHA-512 mismatch');
  const sha256 = Object.fromEntries([[files[0], exe], ['latest.yml', updateFile]]
    .map(([name, data]) => [name, crypto.createHash('sha256').update(data).digest('hex')]));
  return { dist, version, files, sha256, metadata: info, installerSize: exe.length };
}

function verifyDist(options = {}) {
  const result = verifyArtifacts(options);
  const entries = fs.readdirSync(result.dist, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile()) || JSON.stringify(actual) !== JSON.stringify([...result.files].sort())) {
    throw new Error(`Unexpected dist contents\nExpected: ${result.files.join(', ')}\nActual: ${actual.join(', ')}`);
  }
  if (options.quiet !== true) console.log(`Verified AgentPaw ${result.version}: installer + latest.yml, PE header and SHA-512 valid`);
  return result;
}

if (require.main === module) verifyDist();
module.exports = { artifactNames, verifyArtifacts, verifyDist };
