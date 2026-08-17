'use strict';

// 脱离终端启动器（开发态 `npm start` 专用）。
//
// 问题：直接 `electron .` 时，PET 是启动它的命令行窗口所在进程组的子进程；
// 一旦关闭那个终端/命令行窗口，操作系统会连带着终止整个进程组，PET 随之退出。
//
// 解决：用普通 node 以 `detached: true` + `stdio: 'ignore'` 拉起 electron，
// 让 GUI 进程拥有独立的进程组、不再挂接原控制台 —— 关终端后 PET 继续后台运行。
// （打包后的 WorkMeow.exe 本身就是独立 GUI 进程，不走这里。）

const { spawn } = require('child_process');
const path = require('path');

// 普通 node 加载 `electron` 包时，module.exports 即 electron 可执行文件路径。
const electron = require('electron');
const appDir = path.join(__dirname);

const child = spawn(electron, [appDir], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});

child.unref();

child.on('error', (err) => {
  console.error('启动打工喵失败：', err.message);
  process.exit(1);
});

// 启动器自身立即退出，把 GUI 进程留在后台独立运行。
