'use strict';

// Developer CLI for the same aggregate hook lifecycle used by the app.

const hooks = require('./hooks');
const { readRuntimeConfig } = require('./transport');

if (process.argv.includes('--uninstall')) {
  console.log(hooks.uninstall());
} else {
  const runtime = readRuntimeConfig();
  if (!runtime) {
    console.error('打工喵尚未运行，无法获取本次运行的本机端口和令牌。');
    process.exitCode = 1;
  } else {
    console.log(hooks.install(runtime.port, runtime.token));
  }
}
