'use strict';

// Give the offscreen Electron process file handles, never a short-lived shell pipe.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.inspect', 'ui-preview');
fs.mkdirSync(out, { recursive: true });
const stdout = fs.openSync(path.join(out, 'stdout.log'), 'w');
const stderr = fs.openSync(path.join(out, 'stderr.log'), 'w');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let child;
try {
  child = spawn(require('electron'), [path.join(__dirname, 'preview-ui.cjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
} finally {
  fs.closeSync(stdout);
  fs.closeSync(stderr);
}
child.once('error', (error) => {
  console.error(`UI preview could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.exitCode = code === 0 ? 0 : 1;
  console.log(`UI preview ${code === 0 ? 'passed' : 'failed'}: ${out}`);
});
