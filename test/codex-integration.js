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
assert(/require\('\.\/backend\/codex-watch'\)/.test(main), 'main process must load the Codex watcher');
assert(/codexWatch\s*=\s*createCodexWatch\(/.test(main), 'main process must create the Codex watcher');
assert(/codexWatch\.start\(\)/.test(main), 'main process must start the Codex watcher');
assert(/if \(codexWatch\) codexWatch\.stop\(\)/.test(main), 'app shutdown must stop the Codex watcher');
assert(/function sendPetEvent\(ev\)/.test(main) && /sendPet\(IPC\.PET_EVENT, ev\)/.test(main), 'Codex events must reach the single unified pet');
assert(/function createPetWindows\(\)/.test(main) && /makePetWindow\('all'\)/.test(main), 'single-pet mode must create exactly one unified pet');
assert(!/dedicatedWins/.test(main), 'per-tool dedicated pets must be gone (single unified pet only)');
assert(/petPosition: null/.test(config) && !/petMode|dedicatedAgents|petPositionCodex|petPositions|skinCodex|budget5h/.test(config), 'Codex pet settings must use the fixed cat without legacy selectors');
assert(!/launch(Claude|Codex|Trae|Workbuddy|Opencode)\s*:/.test(preload), 'desktop-app launchers must be removed from the preload bridge');
assert(/closePet: \(\) => ipcRenderer\.send\(IPC\.CLOSE_PET\)/.test(preload), 'the unified pet must remain independently closable');
assert(/\| Claude Code \|/.test(readme) && /\| Codex \|/.test(readme) && /rollout JSONL/.test(readme),
  'public documentation must describe Claude Code and Codex support');
assert(TESTS.includes('codex-watch.js'), 'npm test must execute Codex watcher tests');
assert(TESTS.includes('codex-integration.js'), 'npm test must execute the Codex integration contract');

console.log('codex integration checks passed');
