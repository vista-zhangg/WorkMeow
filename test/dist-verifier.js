'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { artifactNames, verifyDist } = require('../scripts/verify-dist');
const { finalizeDist } = require('../scripts/finalize-dist');
const { verifyReleaseAssets } = require('../scripts/publish-release');

function createFixture(dist) {
  const version = '9.8.7';
  const [name] = artifactNames(version);
  fs.mkdirSync(dist, { recursive: true });
  const exe = Buffer.alloc(128);
  exe.write('MZ');
  exe.writeUInt32LE(64, 60);
  exe.writeUInt32LE(0x4550, 64);
  const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
  fs.writeFileSync(path.join(dist, name), exe);
  fs.writeFileSync(path.join(dist, 'latest.yml'), yaml.dump({
    version, files: [{ url: name, size: exe.length, sha512 }], path: name, sha512,
  }));
  return version;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-dist-test-'));
try {
  const dist = path.join(temp, 'dist');
  const version = createFixture(dist);
  const options = { dist, version, quiet: true };
  const verified = verifyDist(options);
  assert.deepStrictEqual(verified.files, artifactNames(version));
  const release = { tag_name: `v${version}`, assets: verified.files.map((name) => ({
    name, state: 'uploaded', size: fs.statSync(path.join(dist, name)).size, digest: `sha256:${verified.sha256[name]}`,
  })) };
  verifyReleaseAssets(release, verified);
  assert.throws(() => verifyReleaseAssets({ ...release, assets: release.assets.slice(1) }, verified), /asset count/);
  assert.throws(() => verifyReleaseAssets({ ...release, assets: release.assets.map((a) => ({ ...a, digest: 'sha256:wrong' })) }, verified), /integrity check/);

  const old = path.join(dist, 'WorkMeow-1.7.14-Windows-x64.exe');
  fs.writeFileSync(old, 'previous installer');
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), 'obsolete');
  fs.mkdirSync(path.join(dist, 'win-unpacked'));
  assert.throws(() => verifyDist(options), /Unexpected dist contents/);
  const metadataPath = path.join(dist, 'latest.yml');
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  fs.writeFileSync(metadataPath, metadata.replace('9.8.7', '9.8.6'));
  assert.throws(() => finalizeDist(options), /version is not/);
  assert(fs.existsSync(old), 'failed validation must retain the previous installer');
  fs.writeFileSync(metadataPath, metadata);
  const exePath = path.join(dist, artifactNames(version)[0]);
  const exe = fs.readFileSync(exePath);
  fs.appendFileSync(exePath, 'corruption');
  assert.throws(() => verifyDist(options), /size is stale/);
  fs.writeFileSync(exePath, exe);
  const corrupt = Buffer.from(exe);
  corrupt[100] = 1;
  fs.writeFileSync(exePath, corrupt);
  assert.throws(() => finalizeDist(options), /SHA-512 mismatch/);
  assert(fs.existsSync(old), 'a corrupt build must not remove old output');
  fs.writeFileSync(exePath, exe);
  const withoutSize = yaml.load(metadata);
  delete withoutSize.files[0].size;
  fs.writeFileSync(metadataPath, yaml.dump(withoutSize));
  assert.throws(() => verifyDist(options), /size is stale/);
  finalizeDist(options);
  assert.strictEqual(yaml.load(fs.readFileSync(metadataPath, 'utf8')).files[0].size, exe.length,
    'finalization fills omitted size only after authenticating the built installer');
  assert.deepStrictEqual(fs.readdirSync(dist).sort(), artifactNames(version).sort());
  assert(!fs.existsSync(old));
  fs.writeFileSync(exePath, Buffer.alloc(128));
  assert.throws(() => verifyDist(options), /Invalid Windows PE/);
} finally {
  if (fs.realpathSync(path.dirname(temp)) !== fs.realpathSync(os.tmpdir())) throw new Error('Unexpected test cleanup path');
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('dist verification, safe cleanup, and release digest checks passed');
