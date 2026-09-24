'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
async function build() {
  const assets = path.resolve(__dirname, '..', 'assets');
  const source = path.join(assets, 'brand', 'icon-source.png');
  await sharp(source).resize(512, 512).png().toFile(path.join(assets, 'agentpaw-icon.png'));
  await sharp(source).resize(64, 64).png().toFile(path.join(assets, 'agentpaw-tray.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((png, index) => {
    const at = 6 + index * 16, size = sizes[index];
    header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  fs.writeFileSync(path.join(assets, 'agentpaw-icon.ico'), Buffer.concat([header, ...images]));
  console.log('AgentPaw icons built: PNG, tray PNG and 7-size ICO');
}
build().catch((error) => { console.error(error); process.exitCode = 1; });
