'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { verifyArtifacts, verifyDist } = require('./verify-dist');

function finalizeDist(options = {}) {
  const result = verifyArtifacts({ ...options, allowMissingSize: true });
  // Without differentialPackage, electron-builder omits size. Add it only
  // after validating the version, file name, PE header and both SHA-512 fields.
  if (result.metadata.files[0].size == null) {
    result.metadata.files[0].size = result.installerSize;
    fs.writeFileSync(path.join(result.dist, 'latest.yml'), yaml.dump(result.metadata, { lineWidth: -1 }), 'utf8');
  }
  verifyArtifacts(options);
  const directory = fs.realpathSync(result.dist);
  const keep = new Set(result.files);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    const target = path.resolve(directory, entry.name);
    // Resolve and check every deletion target against the validated dist.
    if (path.dirname(target) !== directory) throw new Error(`Cleanup path escapes dist: ${target}`);
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  }
  return verifyDist({ ...options, dist: directory });
}

if (require.main === module) finalizeDist();
module.exports = { finalizeDist };
