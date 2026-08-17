'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BRAND = require('../shared/brand');
const i18n = require('../shared/i18n');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const main = read('main.js');
const readme = read('README.md');
const readmeEn = read('README_EN.md');
const credits = read('assets/cat/CREDITS.md');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

assert.strictEqual(pkg.name, 'workmeow');
assert.strictEqual(pkg.build.productName, BRAND.displayName);
assert.strictEqual(pkg.build.executableName, 'WorkMeow');
assert.strictEqual(pkg.build.appId, BRAND.appId);
assert.strictEqual(pkg.author, 'vista-zhang');
assert.strictEqual(pkg.repository.url, 'git+https://github.com/vista-zhangg/WorkMeow.git');
assert(pkg.build.files.includes('LICENSE'), 'packaged app must retain the upstream MIT license');
assert.strictEqual(pkg.build.win.artifactName, 'WorkMeow-${version}-Windows-${arch}.${ext}');
assert(/--publish never(?:\s|$)/.test(pkg.scripts['package:win']), 'Windows packaging must use the unified release job');
assert.strictEqual(pkg.scripts.test, 'node test/run-all.js');
assert(/name: workmeow-windows-x64/.test(read('.github/workflows/release.yml')), 'release artifact must use WorkMeow');
assert(/WorkMeow \$\{GITHUB_REF_NAME#v\}/.test(read('.github/workflows/release.yml')), 'release title must follow the pushed version tag');
assert.strictEqual(lock.name, 'workmeow');
assert.strictEqual(lock.packages[''].name, 'workmeow');
assert(/app\.setName\(BRAND\.name\)/.test(main), 'Electron app name must come from the brand registry');
assert(/app\.setAppUserModelId\(BRAND\.appId\)/.test(main), 'Windows app identity must come from the brand registry');
assert(/hook[\\/]workmeow-hook\.js/.test(read('README.md').replace(/`/g, '')), 'Claude hook docs must use the WorkMeow filename');
assert(/基于 \[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\) 二次开发/.test(readme),
  'README must retain explicit upstream attribution');
assert(/Copyright \(c\) 2026 myunwang/.test(read('LICENSE')),
  'the upstream MIT copyright notice must remain intact');
assert(/Windows x64 only/.test(readmeEn), 'English README must state the Windows-only support boundary');
assert(/\[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\)/.test(readmeEn),
  'English README must retain explicit upstream attribution');
assert(/@月薪喵/.test(readme) && /@月薪喵/.test(readmeEn) && /@月薪喵/.test(credits),
  'both READMEs and asset credits must retain the artist source attribution');
for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'docs/PRIVACY.md']) {
  assert(fs.existsSync(path.join(root, file)), `${file} must exist`);
}

assert(/tray\.setToolTip\(t\('tray\.tooltip'\)\)/.test(main), 'tray tooltip must come from i18n');
const tip = i18n.DICT.zh['tray.tooltip'];
assert(/打工喵/.test(tip) && /WorkMeow/.test(tip), 'tray tooltip must use the canonical brand');
assert(/<title>打工喵 · 详情<\/title>/.test(read('renderer/panel.html')), 'detail title must use 打工喵');
assert(/产品名称和所有对外发布物统一使用 \*\*打工喵（WorkMeow）\*\*/.test(readme));

const publicFiles = [
  'README.md', 'README_EN.md', 'docs/介绍.md', 'docs/LOCAL_DEPLOYMENT.md', 'STATES.md',
  'main.js', 'renderer/pet.html', 'renderer/pet.js', 'renderer/panel.html',
  'renderer/panel.js', '.github/workflows/release.yml',
];
for (const file of publicFiles) {
  const text = read(file)
    .replace(/\[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\)/g, '')
    .replace(/https?:\/\/\S+/g, '');
  assert(!/\bOctopus\b|\bLLMPET\b/.test(text), `${file} still exposes a retired public brand`);
}

const compatibilityFiles = new Set([
  path.join(root, 'backend', 'env.js'),
  path.join(root, 'backend', 'paths.js'),
  path.join(root, 'backend', 'protocol-compat.js'),
  path.join(root, 'backend', 'hook-compat.js'),
]);
const runtimeFiles = [
  path.join(root, 'main.js'), path.join(root, 'preload.js'),
  ...walk(path.join(root, 'backend')),
  ...walk(path.join(root, 'hook')),
  ...walk(path.join(root, 'renderer')),
  ...walk(path.join(root, 'shared')),
].filter((file) => file.endsWith('.js') && !compatibilityFiles.has(file));
for (const file of runtimeFiles) {
  assert(!/llmpet|octopus/i.test(fs.readFileSync(file, 'utf8')),
    `${path.relative(root, file)} leaks a retired identifier outside the compatibility boundary`);
}

console.log('branding checks passed');
