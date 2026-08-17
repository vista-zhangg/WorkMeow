'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const portableOnly = process.argv.includes('--portable');
const prefix = `WorkMeow-${pkg.version}-Windows-x64`;
const artifacts = portableOnly ? [`${prefix}.zip`] : [`${prefix}.exe`, `${prefix}.zip`];

if (!fs.existsSync(dist)) throw new Error(`Missing build directory: ${dist}`);
for (const name of artifacts) {
  if (!fs.existsSync(path.join(dist, name))) throw new Error(`Missing build artifact: ${name}`);
}

const keep = new Set(artifacts);
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!keep.has(entry.name)) fs.rmSync(path.join(dist, entry.name), { recursive: true, force: true });
}

const checksums = artifacts.map((name) => {
  const data = fs.readFileSync(path.join(dist, name));
  return `${crypto.createHash('sha256').update(data).digest('hex')}  ${name}`;
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');

console.log(`Finalized ${artifacts.length} artifact(s) in ${dist}`);
