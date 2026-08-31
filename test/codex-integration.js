'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const main = read('main.js');
const preload = read('preload.js');
const config = read('backend/config.js');
const readme = read('README.md');
const { TESTS } = require('./run-all');

assert(fs.existsSync(path.join(root, 'backend/codex-watch.js')), 'Codex watcher must ship with the app');
assert(fs.existsSync(path.join(root, 'test/codex-watch.js')), 'Codex watcher regression tests must remain in the suite');
assert(fs.existsSync(path.join(root, 'backend/codex-rate-limits.js')), 'Codex rate-limit App Server client must ship independently');
assert(fs.existsSync(path.join(root, 'backend/codex-quota-tray.js')), 'Codex quota tray presentation must remain independent');
assert(fs.existsSync(path.join(root, 'backend/codex-cli-resolver.js')), 'Codex CLI discovery must remain isolated');
assert(fs.existsSync(path.join(root, 'backend/codex-account-watch.js')), 'Codex account switching must remain isolated');
const rateLimits = read('backend/codex-rate-limits.js');
const cliResolver = read('backend/codex-cli-resolver.js');
const pet = read('renderer/pet.js');
assert(/require\('\.\/backend\/codex-watch'\)/.test(main), 'main process must load the Codex watcher');
assert(/codexWatch\s*=\s*createCodexWatch\(/.test(main), 'main process must create the Codex watcher');
assert(/codexWatch\.start\(\)/.test(main), 'main process must start the Codex watcher');
assert(/if \(codexWatch\) codexWatch\.stop\(\)/.test(main), 'app shutdown must stop the Codex watcher');
assert(/createCodexRateLimits\(/.test(main) && /codexRateLimits\.start\(\)/.test(main),
  'main process must keep one Codex App Server quota client alive');
assert(/if \(codexRateLimits\) codexRateLimits\.stop\(\)/.test(main),
  'app shutdown must stop its Codex App Server child');
assert(/\['app-server', '--stdio'\]/.test(cliResolver), 'quota client must use the official stdio App Server');
assert(/account\/rateLimits\/read/.test(rateLimits) && /account\/rateLimits\/updated/.test(rateLimits),
  'quota client must read and subscribe through the official rate-limit methods');
assert(!/auth\.json|chatgpt\.com\/backend-api/i.test(rateLimits),
  'quota client must not inspect credentials or scrape ChatGPT web endpoints');
assert(/account\/read/.test(rateLimits), 'quota client must identify the current App Server account before showing quota');
assert(!/appendFile|createWriteStream|console\.(?:log|info|warn|error)/.test(rateLimits),
  'quota refreshes must not create polling logs');
assert(/\.slice\(-64\)/.test(rateLimits), 'the only persisted quota alert state must remain bounded');
assert((main.match(/new Tray\(/g) || []).length === 1, 'Codex quota must reuse the existing tray slot');
assert(/assets', 'salary-cat-tray\.png'/.test(main), 'the tray must use the generated 月薪喵 avatar');
assert(!/refreshTrayQuotaIcon|renderTrayIcon/.test(main), 'quota must never replace the mascot tray icon');
assert(/tray\.setToolTip\(baseTooltip\)/.test(main) && !/quotaTooltip/.test(main),
  'tray hover text must not expose quota details');
assert(/quota\.status === 'ready' \? \[\] :/.test(main),
  'healthy quota layout must stay compact and reserve the status row for failures');
assert(/function enqueueQuotaAlert\(ev\)/.test(pet) && /showBubble\(text, 6500\)/.test(pet)
  && !/quota[^\n]*setState\(/.test(pet),
  'quota alerts must queue for the current bubble without adding a pet state');
assert(
  /function sendPetEvent\(ev\)/.test(main)
    && /sendPet\(IPC\.PET_EVENT, privacy\.protectEvent\(ev, config\.get\(\)\.privacyMode === true\)\)/.test(main),
  'Codex events must reach the single unified pet through the privacy boundary',
);
assert(/function createPetWindows\(\)/.test(main) && /makePetWindow\('all'\)/.test(main), 'single-pet mode must create exactly one unified pet');
assert(!/dedicatedWins/.test(main), 'per-tool dedicated pets must be gone (single unified pet only)');
assert(/petPosition: null/.test(config) && !/petMode|dedicatedAgents|petPositionCodex|petPositions|skinCodex|budget5h/.test(config), 'Codex pet settings must use the fixed cat without legacy selectors');
assert(!/launch(Claude|Codex|Trae|Workbuddy|Opencode)\s*:/.test(preload), 'desktop-app launchers must be removed from the preload bridge');
assert(/closePet: \(\) => ipcRenderer\.send\(IPC\.CLOSE_PET\)/.test(preload), 'the unified pet must remain independently closable');
assert(/\| Claude Code \|/.test(readme) && /\| Codex \|/.test(readme) && /rollout JSONL/.test(readme),
  'public documentation must describe Claude Code and Codex support');
assert(TESTS.includes('codex-watch.js'), 'npm test must execute Codex watcher tests');
assert(TESTS.includes('codex-rate-limits.js'), 'npm test must execute Codex quota tests');
assert(TESTS.includes('codex-integration.js'), 'npm test must execute the Codex integration contract');
assert(fs.existsSync(path.join(root, 'assets/salary-cat.png')), 'generated 月薪喵 avatar must ship with the app');
assert(fs.existsSync(path.join(root, 'assets/salary-cat-tray.png')), 'generated 月薪喵 tray avatar must ship with the app');

console.log('codex integration checks passed');
