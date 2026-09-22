const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.inspect', 'ui-preview');
fs.mkdirSync(out, { recursive: true });
const logFile = path.join(out, 'preview.log');
fs.writeFileSync(logFile, '');
const log = (...values) => fs.appendFileSync(logFile, require('util').format(...values) + '\n');
const fail = (error) => {
  try { log(error && error.stack || error); } finally { app.exit(1); }
};
// Diagnostic tools must never leave modal Electron errors on the user's desktop.
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const deadline = setTimeout(() => fail(new Error('UI preview timed out after 90 seconds')), 90000);
app.on('will-quit', () => clearTimeout(deadline));
const version = require('../package.json').version;
app.setPath('userData', path.join(out, 'electron-profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const defaults = { showCat: true, showStatus: true, showQuota: true, showTokens: false, showCost: true };
let chipDisplay = { ...defaults };
const today = { cost: 8.426, tokens: 1286400, input: 362400, output: 86400, inputTotal: 1200000, cacheRead: 837600, messages: 42 };
const sessions = [
  { id: 'demo1', agent: 'codex', state: 'working', project: 'WorkMeow', op: '调整详情面板与设置页面', model: 'gpt-5.5', createdAt: Date.now(), turnStartedAt: Date.now()-124000, contextPercent: 32 },
  { id: 'demo2', agent: 'claude', state: 'thinking', project: 'Design system', op: '检查组件与交互细节', model: 'claude-sonnet-4', createdAt: Date.now(), contextPercent: 18 },
];
const daily = {};
for (let i = 1; i < 30; i++) { const date = new Date(); date.setDate(date.getDate()-i); const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; daily[key] = { ...today, tokens: 400000 + ((i*137231)%1500000), cost: 2+(i*1.23)%9 }; }
const stats = { today, sessions, active: sessions[0], lifetime: { cost: 136.72, tokens: 22460000, messages: 628 },
  byModel: { 'gpt-5.5': { tokens: 824000, cost: 5.642 }, 'claude-sonnet-4': { tokens: 462400, cost: 2.784 } },
  hourlyTok: Array.from({length:24}, (_,i) => i<7 || i>21 ? 0 : 12000+(i*91317)%200000), hourly: Array.from({length:24}, (_,i) => i<7 || i>21 ? 0 : .12+(i*.371)%1.4), daily,
  lastOps: [{ icon:'◈', detail:'更新界面样式', project:'WorkMeow', ts:Date.now() },{ icon:'↗', detail:'检查交互行为', project:'WorkMeow', ts:Date.now()-13000 }],
  idleMs: 0, bg: {}, chipDisplay,
  codexQuota: { status:'ready', updatedAt:Date.now(), windows:{ fiveHour:{ remainingPercent:76, usedPercent:24, resetsAt:Math.floor(Date.now()/1000)+6200 }, weekly:{ remainingPercent:92,usedPercent:8,resetsAt:Math.floor(Date.now()/1000)+320000 } } }
};
const noop = () => {};
let companion = { quietMinutes: 30, rest: { preferences: { ...require('../shared/rest-preferences').DEFAULTS }, pending: null },
  visibility: { visible: true, autoHideFullscreen: true, quietUntil: 0 } };
const report = { hooksEnabled:true, summary:{detected:4,ready:4,needsRepair:0,repairable:0}, integrations: ['Claude Code','Codex','TRAE','WorkBuddy','opencode','ZCode'].map((label,i)=>({label,detected:i<4,mode:i===1?'watcher':i===4?'plugin':'hook',state:i<4?'ready':'not-detected',lastEventAt:i<4?Date.now()-120000:null})) };
const handlers = {
  'companion:get-state': () => companion,
  'companion:set-preferences': (_, value) => {
    if (value.restReminders) companion.rest.preferences = { ...companion.rest.preferences, ...value.restReminders };
    if (typeof value.autoHideFullscreen === 'boolean') companion.visibility.autoHideFullscreen = value.autoHideFullscreen;
    if (value.quietMinutes) companion.quietMinutes = value.quietMinutes;
    return { ok: true, ...companion };
  },
  'rest:action': () => { companion.rest.pending = null; return { ok: true, ...companion }; },
  'get-stats': () => ({...stats,chipDisplay}),
  'get-auto-launch': () => ({ supported:true,enabled:true }),
  'set-auto-launch': (_,enabled) => ({ supported:true,enabled }),
  'privacy:get': () => ({ok:true,enabled:false}),
  'privacy:set': (_,enabled) => ({ok:true,enabled}),
  'chip:get-display': () => chipDisplay,
  'chip:set-display': (_,value) => ({ok:true,...(chipDisplay={...chipDisplay,...value})}),
  'integrations:get-health': () => report,
  'get-xiaban-schedule': () => ({lunch:'12:00',evening:'18:00'}),
  'set-xiaban-schedule': (_,schedule) => ({ok:true,schedule}),
  'get-pet-assets': () => require('../shared/pet-assets').defaultCatalog(),
  'update:get-state': () => ({supported:true,autoCheck:true,currentVersion:version,latestVersion:version,phase:'not-available',mode:'installer'}),
  'get-win-pos': () => [0,0],
  'get-window-metrics': () => ({bounds:{x:0,y:0,width:520,height:520},workArea:{x:0,y:0,width:1920,height:1080},scaleFactor:1}),
};
Object.entries(handlers).forEach(([name,fn]) => ipcMain.handle(name,fn));
['set-panel-height','set-pet-size','set-ignore-mouse','quota-alert:shown','pet-blur','pet:hide-menu'].forEach(name=>ipcMain.on(name,noop));
const errors=[];
async function create(page,width,height) {
  const win = new BrowserWindow({width,height,show:false,frame:false,webPreferences:{offscreen:true,preload:path.join(root,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('paint', (_event, _dirty, bitmap) => { if (!bitmap.isEmpty()) { win.previewBitmap = bitmap; win.previewRevision = (win.previewRevision || 0) + 1; } });
  win.webContents.on('console-message',(_e,...args) => { const detail=args.length===1?args[0]:null; const level=detail?detail.level:args[0]; const message=detail?detail.message:args[1]; if(level===3 || level==='error') errors.push({page,message}); });
  win.webContents.on('render-process-gone',(_e,details)=>errors.push({page,details}));
  await win.loadFile(path.join(root,'renderer',page+'.html'));
  await new Promise(resolve=>setTimeout(resolve,700));
  return win;
}
async function capture(win, name) {
  log('capture', name);
  const before = win.previewRevision || 0;
  win.webContents.startPainting();
  await win.webContents.executeJavaScript(`document.body.style.opacity='.999';requestAnimationFrame(()=>{document.body.style.opacity='1'})`);
  for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
    win.webContents.invalidate();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (elapsed >= 800 && win.previewRevision > before) break;
  }
  if (!win.previewBitmap || !(win.previewRevision > before)) throw new Error('No fresh offscreen frame: ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), win.previewBitmap.toPNG());
}
async function dimensions(win) { return win.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,panels:[...document.querySelectorAll('.settings-panel')].filter(x=>!x.hidden).map(x=>x.id),outside:[...document.querySelectorAll('button,input,.chip,.stat,.block,.asset-card,.asset-inspector')].filter(x=>x.getClientRects().length).filter(x=>{const r=x.getBoundingClientRect();return r.left<0 || r.right>innerWidth+1}).map(x=>x.id||x.className)})`); }
app.whenReady().then(async()=>{
  try {
    const result=[];
    const settings=await create('settings',840,760);
    log('settings loaded');
    for(const tab of ['general','companion','appearance','integrations','updates','expressions']) {
      await settings.webContents.executeJavaScript(`document.getElementById('tab-${tab}').click()`);
      result.push({page:tab,...await dimensions(settings)});
      await capture(settings,'settings-'+tab);
    }
    await settings.webContents.executeJavaScript(`document.getElementById('tab-companion').click(); document.getElementById('rest-water-minutes').value=35; document.getElementById('rest-snooze-minutes').value=7; document.getElementById('rest-save').click();`);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(companion.rest.preferences.waterMinutes,35,'custom water interval saved');
    assert.equal(companion.rest.preferences.snoozeMinutes,7,'custom reminder snooze saved');
    await settings.webContents.executeJavaScript(`document.getElementById('quiet-minutes').value=47; document.getElementById('quiet-minutes').dispatchEvent(new Event('change')); document.getElementById('fullscreen-toggle').click(); document.getElementById('settings-content').scrollTop=900;`);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(companion.quietMinutes,47,'custom quiet duration saved');
    assert.equal(companion.visibility.autoHideFullscreen,false,'fullscreen can be disabled');
    await capture(settings,'settings-companion-lower');
    await settings.webContents.executeJavaScript(`document.getElementById('tab-appearance').click()`);
    for(const key of ['showCat','showStatus','showQuota','showTokens','showCost']) {
      const before=chipDisplay[key];
      await settings.webContents.executeJavaScript(`document.getElementById('${key}-toggle').click()`);
      await new Promise(r=>setTimeout(r,50));
      assert.equal(chipDisplay[key],!before,'toggle persists '+key);
      const field={showCat:'cat',showStatus:'status',showQuota:'quota',showTokens:'tokens',showCost:'cost'}[key];
      assert.equal(await settings.webContents.executeJavaScript(`document.getElementById('preview-${field}').hidden`),before,'preview follows '+key);
    }
    await settings.webContents.executeJavaScript(`document.getElementById('tab-appearance').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    assert.equal(await settings.webContents.executeJavaScript('document.activeElement.id'),'tab-integrations');
    await settings.webContents.executeJavaScript(`document.getElementById('tab-appearance').click()`);
    // Every supported combination must keep the preview within its card.
    for (let mask=0;mask<32;mask++) {
      const value=Object.fromEntries(Object.keys(defaults).map((key,index)=>[key,!!(mask & (1<<index))]));
      await settings.webContents.executeJavaScript(`renderChipPreview(${JSON.stringify(value)})`);
      assert(await settings.webContents.executeJavaScript(`(() => {const r=document.querySelector('.preview-compact').getBoundingClientRect();const p=document.querySelector('.capsule-preview').getBoundingClientRect();return r.width<=p.width-30})()`),'preview fits '+mask);
    }
    for (const tab of ['general','companion','appearance','integrations','updates','expressions']) {
      settings.setSize(720,620);
      await settings.webContents.executeJavaScript(`document.getElementById('tab-${tab}').click()`);
      result.push({page:tab+'-small',...await dimensions(settings)});
    }
    await capture(settings,'settings-small');
    settings.destroy();
    chipDisplay={...defaults};
    const panel=await create('panel',620,900);
    await capture(panel,'panel');
    result.push({page:'panel',...await dimensions(panel)});
    for(const range of ['7d','30d','today']) {
      await panel.webContents.executeJavaScript(`document.querySelector('[data-range="${range}"]').click()`);
      assert.equal(await panel.webContents.executeJavaScript(`document.querySelectorAll('#chart .bar').length`),range==='7d'?7:range==='30d'?30:24);
    }
    panel.setSize(420,700);
    result.push({page:'panel-small',...await dimensions(panel)});
    await capture(panel,'panel-small');
    panel.destroy();
    const pet=await create('pet',520,420);
    pet.webContents.send('pet:stats',stats);
    await capture(pet,'pet');
    await pet.webContents.executeJavaScript(`Object.defineProperty(document,'hidden',{configurable:true,value:false}); void 0;`);
    companion.rest.pending={id:'preview-rest-cat',kinds:['water','stretch'],createdAt:Date.now()};
    pet.webContents.send('companion:state',companion);
    await capture(pet,'pet-rest');
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('rest-reminder').classList.contains('hidden')`),false,'rest reminder visible during agent work');
    await pet.webContents.executeJavaScript(`document.getElementById('rest-done').click()`);
    await new Promise(r=>setTimeout(r,100));

    await pet.webContents.executeJavaScript(`document.getElementById('chip-quota').click()`);
    await capture(pet,'pet-quota');
    result.push({page:'pet',...await dimensions(pet)});
    await pet.webContents.executeJavaScript(`document.getElementById('chip-quota').click()`);
    pet.webContents.send('pet:stats',{...stats,chipDisplay:{...defaults,showCat:false,showTokens:true}});
    await capture(pet,'pet-compact');
    companion.rest.pending={id:'preview-rest-capsule',kinds:['water'],createdAt:Date.now()};
    pet.webContents.send('companion:state',companion);
    await capture(pet,'pet-compact-rest');
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('rest-reminder').classList.contains('hidden')`),false,'capsule shows rest reminder');
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('rest-snooze').textContent`),'7 分钟后','configured snooze text');
    pet.webContents.send('pet:event',{kind:'waiting',choice:{kind:'perm',permId:'demo-perm',sessionId:'demo1',project:'WorkMeow',tool:'Bash',command:'npm test',options:[{label:'允许',key:'allow'}]}});
    await new Promise(r=>setTimeout(r,100));
    await capture(pet,'pet-compact-rest-pending');
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('rest-pending').hidden`),false,'rest reminder stays visible beside waiting permission');
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('rest-reminder').classList.contains('hidden')`),true,'permission form keeps priority');
    await pet.webContents.executeJavaScript(`document.getElementById('rest-pending').click()`);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('ask').classList.contains('hidden')`),false,'snoozing rest never closes permission');

    await pet.webContents.executeJavaScript(`document.getElementById('rest-snooze').click()`);
    await new Promise(r=>setTimeout(r,100));

    const compact=await pet.webContents.executeJavaScript(`({hidden:document.getElementById('cat').getAttribute('aria-hidden'),width:document.getElementById('chip').getBoundingClientRect().width})`);
    assert.equal(compact.hidden,'true');
    await pet.webContents.debugger.attach('1.3');
    await pet.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await pet.webContents.executeJavaScript(`updateCapsuleState('error','异常');`);
    assert.equal(await pet.webContents.executeJavaScript(`document.getElementById('chip-context').getAnimations().length`),0,'reduced motion disables status animation');
    pet.destroy();
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({errors,result,completedAt:new Date().toISOString()},null,2));
    assert.equal(errors.length,0,JSON.stringify(errors));
    assert(result.every(x=>!x.overflow && x.outside.length===0),JSON.stringify(result));
    log(JSON.stringify({status:'passed',screenshots:out,checks:result.length,errors}));
  } catch(error) { log(error); process.exitCode=1; }
  clearTimeout(deadline);
  app.exit(process.exitCode || 0);
});
