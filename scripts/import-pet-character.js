'use strict';

// Local character setup; a running app reads the selected role on restart.
const { PetCharacterStore } = require('../backend/pet-characters');
const path = require('path');
async function main() {
  const manifest = process.argv[2];
  if (!manifest) throw new Error('用法：node scripts/import-pet-character.js <character.json>');
  const store = new PetCharacterStore();
  const result = await store.importPack(path.resolve(manifest));
  console.log(JSON.stringify({ ok: result.ok, id: result.characterId, name: result.catalog.character.name,
    states: Object.keys(result.catalog.slots).length, message: '已导入并选中，重启桌宠后生效。' }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
