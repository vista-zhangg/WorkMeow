'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { artifactNames, parseChecksums, verifyDist } = require('../scripts/verify-dist');

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createFixture(dist) {
  const version = '9.8.7';
  const prefix = `WorkMeow-${version}-Windows-x64`;
  fs.mkdirSync(dist, { recursive: true });
  const content = new Map([
    [`${prefix}.exe`, Buffer.from('installer')],
    [`${prefix}.exe.blockmap`, Buffer.from('blockmap')],
    ['latest.yml', Buffer.from(`version: ${version}\nfiles:\n  - url: ${prefix}.exe\n    size: 9\npath: ${prefix}.exe\n`)],
  ]);
  for (const [name, data] of content) fs.writeFileSync(path.join(dist, name), data);
  const sums = [...content].map(([name, data]) => `${hash(data)}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums);
  return version;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-dist-test-'));
try {
  const full = path.join(temp, 'full');
  const version = createFixture(full, false);
  const verified = verifyDist({ dist: full, version, quiet: true });
  assert.deepStrictEqual(verified.files, artifactNames(version).sort());

  fs.writeFileSync(path.join(full, 'WorkMeow-1.5.0-Windows-x64.zip'), 'old');
  assert.throws(() => verifyDist({ dist: full, version, quiet: true }), /Unexpected dist contents/);
  fs.rmSync(path.join(full, 'WorkMeow-1.5.0-Windows-x64.zip'));
  fs.writeFileSync(path.join(full, `WorkMeow-${version}-Windows-x64.zip`), 'portable builds are retired');
  assert.throws(() => verifyDist({ dist: full, version, quiet: true }), /Unexpected dist contents/);
  assert.strictEqual(parseChecksums(`${'a'.repeat(64)}  file.zip\n`).get('file.zip'), 'a'.repeat(64));
  assert.throws(() => parseChecksums('not-a-checksum'), /Invalid SHA256SUMS line/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('dist artifact verifier checks passed');
