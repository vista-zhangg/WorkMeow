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

assert.strictEqual(pkg.name, 'agentpaw');
assert.strictEqual(pkg.build.productName, BRAND.displayName);
assert.strictEqual(pkg.build.executableName, 'AgentPaw');
assert.strictEqual(pkg.build.appId, BRAND.appId);
assert.strictEqual(pkg.author, 'vista-zhang');
assert.strictEqual(pkg.repository.url, 'git+https://github.com/vista-zhangg/codex-desktop-pet.git');
assert(pkg.build.files.includes('LICENSE'), 'packaged app must retain the upstream MIT license');
assert.strictEqual(pkg.build.win.artifactName, 'AgentPaw-${version}-Windows-${arch}.${ext}');
assert(/--publish never(?:\s|$)/.test(pkg.scripts['package:win']), 'Windows packaging must use the unified release job');
assert.strictEqual(pkg.scripts.test, 'node test/run-all.js');
assert(/name: agentpaw-windows-x64/.test(read('.github/workflows/release.yml')), 'release artifact must use AgentPaw');
assert(read('scripts/publish-release.js').includes('${BRAND.fullName} ${result.version}')
  && read('scripts/publish-release.js').includes('process.env.GITHUB_REF_NAME !== tag'),
  'release title and pushed tag must follow the verified package version');
assert.strictEqual(lock.version, pkg.version);
assert.strictEqual(lock.packages[''].version, pkg.version);
assert.strictEqual(lock.name, 'agentpaw');
assert.strictEqual(lock.packages[''].name, 'agentpaw');
assert(/app\.setName\(BRAND\.name\)/.test(main), 'Electron app name must come from the brand registry');
assert(/app\.setAppUserModelId\(BRAND\.appId\)/.test(main), 'Windows app identity must come from the brand registry');
assert(/const WINDOW_ICON_PATH = path\.join\(__dirname, 'assets', 'agentpaw-icon\.ico'\)/.test(main),
  'every Windows surface must share the independent product icon');
assert.strictEqual(pkg.build.win.icon, 'assets/agentpaw-icon.ico', 'Windows icon uses the new brand asset');
assert.strictEqual((main.match(/icon:\s*WINDOW_ICON/g) || []).length, 3,
  'pet, detail, and settings windows must all receive the product icon');
assert(/function applyWindowBranding\(win\)/.test(main) && /win\.setIcon\(WINDOW_ICON\)/.test(main)
  && /win\.setAppDetails\(\{/.test(main) && /appIconPath: WINDOW_ICON_PATH/.test(main),
  'Windows taskbar buttons must be explicitly refreshed with the generated icon');
assert(/hook[\\/]agentpaw-hook\.js/.test(read('README.md').replace(/`/g, '')), 'Claude hook docs must use the AgentPaw filename');
assert(/基于 \[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\) 二次开发/.test(readme),
  'README must retain explicit upstream attribution');
assert(/Copyright \(c\) 2026 myunwang/.test(read('LICENSE')),
  'the upstream MIT copyright notice must remain intact');
assert(/Windows x64 only/.test(readmeEn), 'English README must state the Windows-only support boundary');
assert(/\[LLMPET\]\(https:\/\/github\.com\/myunwang\/LLMPET\)/.test(readmeEn),
  'English README must retain explicit upstream attribution');
assert(readme.includes('assets/cat/CREDITS.md') && readmeEn.includes('assets/cat/CREDITS.md') && /@月薪喵/.test(credits),
  'README links must preserve original attribution in dedicated asset credits');
assert(readme.includes('assets/characters/milktea-mouse/CREDITS.md') && readmeEn.includes('assets/characters/milktea-mouse/CREDITS.md'));
assert(read('assets/characters/milktea-mouse/CREDITS.md').includes('阿翅 Achi'));
assert.equal(fs.readdirSync(path.join(root, 'assets/characters/milktea-mouse')).filter((name) => name.endsWith('.gif')).length, 15);
assert(readme.includes('assets/characters/mimi-bee/CREDITS.md') && readmeEn.includes('assets/characters/mimi-bee/CREDITS.md'));
assert(read('assets/characters/mimi-bee/CREDITS.md').includes('花栗鼠发发'));
assert.equal(fs.readdirSync(path.join(root, 'assets/characters/mimi-bee')).filter((name) => name.endsWith('.gif')).length, 16);
assert.equal(pkg.build.nsis.guid, '8737e7ad-d3e9-5b66-8bd0-f2a73c6219ec', 'rebranding preserves the installer upgrade identity');
for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'docs/PRIVACY.md']) {
  assert(fs.existsSync(path.join(root, file)), `${file} must exist`);
}

assert(/tray\.setToolTip\(t\('tray\.tooltip'\)\)/.test(main), 'tray tooltip must come from i18n');
const tip = i18n.DICT.zh['tray.tooltip'];
assert(tip.includes(BRAND.displayName) && tip.includes(BRAND.name), 'tray tooltip must use the canonical brand');
assert(read('renderer/panel.html').includes(`<title>${BRAND.displayName} · 详情</title>`), 'detail title must use the canonical brand');
assert(readme.includes(`产品名称和所有对外发布物统一使用 **${BRAND.fullName}**`));

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
  if (!file.startsWith('.github/')) assert(!/meow|喵/i.test(text), `${file} exposes the former brand`);
}

const compatibilityFiles = new Set([
  path.join(root, 'backend', 'env.js'),
  path.join(root, 'backend', 'paths.js'),
  path.join(root, 'backend', 'protocol-compat.js'),
  path.join(root, 'backend', 'hook-compat.js'),
  path.join(root, 'backend', 'windows-brand-compat.js'),
  path.join(root, 'backend', 'character-compat.js'),
]);
const runtimeFiles = [
  path.join(root, 'main.js'), path.join(root, 'preload.js'),
  ...walk(path.join(root, 'backend')),
  ...walk(path.join(root, 'hook')),
  ...walk(path.join(root, 'renderer')),
  ...walk(path.join(root, 'shared')),
].filter((file) => file.endsWith('.js') && !compatibilityFiles.has(file));
for (const file of runtimeFiles) {
  assert(!/llmpet|octopus|meow|喵/i.test(fs.readFileSync(file, 'utf8')),
    `${path.relative(root, file)} leaks a retired identifier outside the compatibility boundary`);
}

console.log('branding checks passed');
