'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = require('../backend/config');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pet = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(root, 'renderer', 'settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'renderer', 'settings.js'), 'utf8');

assert.deepStrictEqual(config.DEFAULT_XIABAN_TIMES, { lunch: '10:55', evening: '16:55' });
assert.deepStrictEqual(config.sanitize({}).xiabanTimes, { lunch: '10:55', evening: '16:55' });
assert.deepStrictEqual(config.sanitize({
  xiabanTimes: { lunch: '12:10', evening: '18:20' },
}).xiabanTimes, { lunch: '12:10', evening: '18:20' });
assert.deepStrictEqual(config.sanitize({
  xiabanTimes: { lunch: '25:00', evening: '18:20' },
}).xiabanTimes, { lunch: '10:55', evening: '16:55' });

assert(/GET_XIABAN_SCHEDULE/.test(main) && /SET_XIABAN_SCHEDULE/.test(main),
  'main process must expose xiaban schedule read/write IPC');
assert(/sendPet\(IPC\.XIABAN_SCHEDULE/.test(main),
  'saved xiaban schedule must reach the pet immediately');
assert(/XIABAN_DEFAULT_TIMES/.test(pet) && /applyXiabanSchedule/.test(pet),
  'pet renderer must support a runtime xiaban schedule');
assert(/id="xiaban-lunch-time"/.test(settingsHtml) && /id="xiaban-evening-time"/.test(settingsHtml),
  'settings UI must expose both xiaban time inputs');
assert(/setXiabanSchedule/.test(settingsJs), 'settings UI must save the xiaban schedule');

console.log('xiaban schedule checks passed');
