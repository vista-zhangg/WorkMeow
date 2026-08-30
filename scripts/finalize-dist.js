'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const prefix = `WorkMeow-${pkg.version}-Windows-x64`;
const artifacts = [`${prefix}.exe`];
const updateArtifacts = ['latest.yml', `${prefix}.exe.blockmap`];
const requiredArtifacts = [...artifacts, ...updateArtifacts];

if (!fs.existsSync(dist)) throw new Error(`Missing build directory: ${dist}`);
for (const name of requiredArtifacts) {
  if (!fs.existsSync(path.join(dist, name))) throw new Error(`Missing build artifact: ${name}`);
}

const keep = new Set(requiredArtifacts);
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!keep.has(entry.name)) fs.rmSync(path.join(dist, entry.name), { recursive: true, force: true });
}

const checksums = requiredArtifacts.map((name) => {
  const data = fs.readFileSync(path.join(dist, name));
  return `${crypto.createHash('sha256').update(data).digest('hex')}  ${name}`;
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');

console.log(`Finalized ${requiredArtifacts.length} artifact(s) in ${dist}`);
