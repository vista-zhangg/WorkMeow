'use strict';

// Structural checks for the reduced pet surface. The cat keeps its state,
// radial menu, ask card and action center; the removed session window, language
// switcher, audio path, and old territory/loot visuals must not come back
// accidentally.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('renderer/pet.css');
const js = read('renderer/pet.js');
const html = read('renderer/pet.html');
const main = read('main.js');
const preload = read('preload.js');
const config = read('backend/config.js');
const i18n = read('shared/i18n.js');
const panel = read('renderer/panel.js');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

assert(/const POPUP_W = 520;/.test(js), 'popup measurement width must remain stable');
assert(/const ASK_VIEWPORT_MAX_H = 520;/.test(js), 'ask measurement must retain its height cap');
assert(/function fitPopup[\s\S]*el === askEl[\s\S]*ASK_VIEWPORT_MAX_H/.test(js), 'ask popup must keep dynamic sizing');
assert(/\.ask\s*\{[\s\S]*background\s*:\s*rgba\(255, 255, 255, 0\.98\)/.test(css), 'ask card styling must remain');
assert(/\.action-pop\s*\{/.test(css) && /id="action-pop"/.test(html), 'action center must remain');
assert(/id="ask"/.test(html) && /id="sessions"/.test(html), 'ask card and status dots must remain');
assert(/\.peek\s*\{/.test(css) && /id="peek"/.test(html), 'left-click work peek must remain');
assert(/\.peek-row-project\s*\{[^}]*display:\s*block[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s.test(css), 'long peek task titles must stay inside their grid column');
assert(/\.peek-row-detail\s*\{[^}]*display:\s*block[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s.test(css), 'peek task details must stay inside their grid column');
assert(/\.bubble\.hidden\s*\{[\s\S]*?display:\s*none;/.test(css), 'hidden completion bubbles must leave the flex layout');
assert(/\.chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*21px;/.test(css), 'resting capsule must keep its full height');
assert(/function handleCatClick\(\)[\s\S]*openPeek\(\)/.test(js), 'short cat click must route to the work peek');
assert(/const HIT_SEL = '[^']*#peek/.test(js), 'work peek must participate in transparent-window hit testing');
assert(/if \(!g\.moved && Math\.abs\(dx\) \+ Math\.abs\(dy\) > 4\) g\.moved = true/.test(js), 'drag threshold must remain ahead of click dispatch');

const sessionPopupRefs = /sesslist|sl-(?:rows|sub|title|back|session-view|loot|search|filters|archived-toggle|new|panel)|sessListOpen|toggleSessList|openSessList|closeSessList|renderSessList|setSessionPrefs|set-session-prefs/;
assert(!sessionPopupRefs.test(js + css + html + main + preload + config), 'session popup code and IPC must be removed');
assert(!/左键短按[^\n]*会话|会话列表 HUD/.test(js + css + html), 'cat click must not mention the removed session window');

const soundRefs = /muted|toggleMute|toggle-mute|AudioContext|webkitAudioContext|\bSOUND\b|\bbeep\s*\(/;
assert(!soundRefs.test(js + main + preload + config), 'sound playback and mute controls must be removed');
assert(!/\.(?:mp3|wav|ogg|m4a)\b/i.test(walk(path.join(root, 'assets')).join('\n')), 'audio assets must be removed');

assert(!/\bLANGS\b|\bsetLang\b|\bgetLang\b|tray\.language|lang\.(?:zh|en|ja)|cfg\.lang|config\.get\(\)\.lang/.test(main + js + panel + preload + config + i18n), 'language switching code must be removed');
assert(!/const (?:en|ja)\s*=/.test(i18n) && /const DICT = \{ zh \}/.test(i18n), 'only the Chinese dictionary must remain');
assert(/document\.documentElement\.lang = 'zh-CN'/.test(js) && /document\.documentElement\.lang = 'zh-CN'/.test(panel), 'renderers must stay in Chinese');

assert(/#stage\.edge-below\s*\{[^}]*justify-content\s*:\s*flex-start\s*;/s.test(css), 'top-edge layout must remain');
assert(/anchoredLayoutPayload/.test(js) && /choosePopupLayout/.test(js), 'popup sizing must preserve the visible pet anchor');
assert(/PetGeometry\.cornerMenuLayout/.test(js), 'radial menu geometry must remain bounded');
assert(/getWindowMetrics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC\.GET_WINDOW_METRICS\)/.test(preload), 'radial menu must retain window metrics access');
assert(/ipcMain\.handle\(IPC\.GET_WINDOW_METRICS/.test(main), 'main process must retain window metrics IPC');

const radialSource = js.match(/const MENU = \[[\s\S]*?\n\];/)?.[0] || '';
assert(!/menu\.(?:pending|background)/.test(radialSource), 'radial menu must remove duplicate panel entries');
assert.strictEqual((radialSource.match(/window\.pet\.openPanel\(/g) || []).length, 1, 'radial menu must keep one detail entry');
assert(/#stage\.edge-(?:left|right) \.chip[\s\S]*?width:\s*120px[\s\S]*?justify-content:\s*center/.test(css), 'edge token chip must stay centred under the cat');
// 单宠时代（2026-08-07 起）：不再有 per-tool 名牌，agent-tag 样式必须整体移除
assert(!/agent-tag/.test(css), 'per-tool agent tag styles must be gone (single unified pet)');
assert(/function positionProp\(\)[\s\S]*propEl\.style\.left/.test(js), 'action prop must use the visible cat geometry');
assert(!/#stage\.edge-right \.prop/.test(css), 'action prop must not use a fixed edge offset');
assert(/function pointerScreenX\(e\)/.test(js) && /function pointerScreenY\(e\)/.test(js), 'dragging must normalize pointer coordinates');
assert(/g !== gesture \|\| gesture\.win/.test(js), 'stale async window-position results must not cross drag gestures');
assert(/document\.addEventListener\('keydown',[\s\S]*e\.key !== 'Escape'[\s\S]*window\.pet\.closePanel\(\)/.test(panel), 'detail panel must close on Escape');

console.log('popup style checks passed');
