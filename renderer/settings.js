'use strict';

const { t } = window.WorkMeowI18n;
const ASSETS = window.WorkMeowPetAssets;
const $ = (id) => document.getElementById(id);

const toggle = $('auto-launch-toggle');
const statusEl = $('setting-status');
const lunchTime = $('xiaban-lunch-time');
const eveningTime = $('xiaban-evening-time');
const xiabanStatusEl = $('xiaban-status');
const xiabanSave = $('xiaban-save');
const xiabanReset = $('xiaban-reset');
const assetGallery = $('asset-gallery');
const assetStatus = $('asset-status');
const assetAdd = $('asset-add');
const assetReplace = $('asset-replace');
const assetReset = $('asset-reset');
const removeBackground = $('remove-bg-toggle');
const DEFAULT_XIABAN_TIMES = Object.freeze({ lunch: '10:55', evening: '16:55' });

let enabled = false;
let supported = true;
let busy = false;
let xiabanBusy = false;
let assetBusy = false;
let selectedSlotId = 'working';
let selectedAssetId = null;
let assetCatalog = ASSETS.defaultCatalog();
let assetStatusTimer = null;

function applyStaticI18n() {
  document.documentElement.lang = 'zh-CN';
  document.title = t('settings.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const label = t(el.dataset.i18nTitle);
    el.title = label;
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', label);
  }
}

function setTab(tabId) {
  for (const tab of document.querySelectorAll('.settings-tab')) {
    const active = tab.dataset.tab === tabId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll('.settings-panel')) {
    const active = panel.dataset.panel === tabId;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
  if (tabId === 'expressions') renderAssets();
}

function renderStatus(messageKey = null, kind = '') {
  toggle.setAttribute('aria-checked', String(enabled));
  toggle.disabled = !supported || busy;
  statusEl.className = `setting-status${kind ? ` ${kind}` : ''}`;
  statusEl.textContent = messageKey ? t(messageKey) : t(enabled ? 'settings.enabled' : 'settings.disabled');
}

function applyState(result, messageKey = null, kind = '') {
  supported = result && result.supported !== false;
  enabled = !!(result && result.enabled);
  const hasError = !!(result && result.error);
  renderStatus(messageKey || (hasError ? 'settings.failed' : supported ? null : 'settings.unsupported'),
    kind || (hasError ? 'error' : supported ? '' : 'unsupported'));
}

async function loadSettings() {
  try { applyState(await window.pet.getAutoLaunch()); }
  catch { supported = true; renderStatus('settings.failed', 'error'); }
}

async function toggleAutoLaunch() {
  if (!supported || toggle.disabled) return;
  busy = true;
  renderStatus('settings.saving');
  try {
    const result = await window.pet.setAutoLaunch(!enabled);
    if (result && result.ok) applyState(result, 'settings.saved');
    else applyState(result, 'settings.failed', 'error');
  } catch { renderStatus('settings.failed', 'error'); }
  finally { busy = false; toggle.disabled = !supported; }
}

function isClockTime(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function scheduleFrom(result) {
  const schedule = result && result.schedule ? result.schedule : result;
  if (!schedule || !isClockTime(schedule.lunch) || !isClockTime(schedule.evening)) return null;
  return { lunch: schedule.lunch, evening: schedule.evening };
}
function renderXiabanStatus(messageKey = null, kind = '') {
  xiabanStatusEl.className = 'setting-status' + (kind ? ' ' + kind : '');
  xiabanStatusEl.textContent = messageKey ? t(messageKey) : '';
}
function applyXiabanInputs(schedule) { lunchTime.value = schedule.lunch; eveningTime.value = schedule.evening; }
async function loadXiabanSchedule() {
  try {
    const schedule = scheduleFrom(await window.pet.getXiabanSchedule());
    if (!schedule) throw new Error('invalid xiaban schedule');
    applyXiabanInputs(schedule);
  } catch {
    applyXiabanInputs(DEFAULT_XIABAN_TIMES);
    renderXiabanStatus('settings.timeSaveFailed', 'error');
  }
}
async function saveXiabanSchedule(next = null) {
  if (xiabanBusy) return false;
  const schedule = next || { lunch: lunchTime.value, evening: eveningTime.value };
  if (!isClockTime(schedule.lunch) || !isClockTime(schedule.evening)) {
    renderXiabanStatus('settings.timeInvalid', 'error');
    return false;
  }
  xiabanBusy = true;
  xiabanSave.disabled = true;
  xiabanReset.disabled = true;
  renderXiabanStatus('settings.timeSaving');
  try {
    const result = await window.pet.setXiabanSchedule(schedule);
    const saved = scheduleFrom(result);
    if (result && result.ok && saved) {
      applyXiabanInputs(saved);
      renderXiabanStatus('settings.timeSaved');
      return true;
    }
    if (saved) applyXiabanInputs(saved);
    renderXiabanStatus('settings.timeSaveFailed', 'error');
    return false;
  } catch {
    renderXiabanStatus('settings.timeSaveFailed', 'error');
    return false;
  } finally {
    xiabanBusy = false;
    xiabanSave.disabled = false;
    xiabanReset.disabled = false;
  }
}

function showAssetStatus(message, kind = '', sticky = false) {
  if (assetStatusTimer) clearTimeout(assetStatusTimer);
  assetStatusTimer = null;
  assetStatus.textContent = message || '';
  assetStatus.className = `asset-status${message ? ' show' : ''}${kind ? ` ${kind}` : ''}`;
  if (message && !sticky) {
    assetStatusTimer = setTimeout(() => {
      assetStatus.className = 'asset-status';
      assetStatus.textContent = '';
    }, 6500);
  }
}

function currentSlotDefinition() { return ASSETS.SLOT_BY_ID[selectedSlotId] || ASSETS.SLOT_BY_ID.working; }
function currentSlotData() { return assetCatalog.slots[selectedSlotId] || ASSETS.defaultCatalog().slots[selectedSlotId]; }
function assetCountLabel(slot) {
  if (slot.mode === 'replace') return `${slot.active.length} 个 · 已替换`;
  if (slot.custom.length) return `${slot.active.length} 个 · 新增 ${slot.custom.length}`;
  return `${slot.active.length} 个默认表情`;
}

function createImage(asset, alt) {
  const image = document.createElement('img');
  image.src = asset.url;
  image.alt = alt;
  image.draggable = false;
  image.loading = 'lazy';
  return image;
}

function selectSlot(slotId) {
  if (!ASSETS.SLOT_BY_ID[slotId]) return;
  selectedSlotId = slotId;
  selectedAssetId = null;
  renderAssets();
  const inspector = $('asset-inspector');
  if (inspector && typeof inspector.scrollIntoView === 'function' && window.innerWidth < 760) {
    inspector.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function createStateCard(definition) {
  const slot = assetCatalog.slots[definition.id];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `asset-card${selectedSlotId === definition.id ? ' selected' : ''}`;
  button.setAttribute('aria-pressed', String(selectedSlotId === definition.id));
  button.addEventListener('click', () => selectSlot(definition.id));

  const preview = document.createElement('span');
  preview.className = 'asset-card-preview checkerboard';
  preview.appendChild(createImage(slot.active[0], `${definition.label}预览`));
  const copy = document.createElement('span');
  copy.className = 'asset-card-copy';
  const title = document.createElement('span');
  title.className = 'asset-card-title';
  title.textContent = definition.label;
  const count = document.createElement('span');
  count.className = `asset-card-count${slot.custom.length ? ' asset-card-custom' : ''}`;
  count.textContent = assetCountLabel(slot);
  copy.append(title, count);
  button.append(preview, copy);
  return button;
}

function renderGallery() {
  assetGallery.replaceChildren();
  for (const group of ASSETS.SLOT_GROUPS) {
    const section = document.createElement('section');
    section.className = 'asset-group';
    const heading = document.createElement('h2');
    heading.className = 'asset-group-title';
    heading.textContent = group.label;
    const grid = document.createElement('div');
    grid.className = 'asset-grid';
    for (const slot of ASSETS.SLOTS.filter((item) => item.group === group.id)) grid.appendChild(createStateCard(slot));
    section.append(heading, grid);
    assetGallery.appendChild(section);
  }
  const customCount = ASSETS.SLOTS.reduce((sum, def) => sum + assetCatalog.slots[def.id].custom.length, 0);
  $('asset-summary').textContent = customCount ? `已添加 ${customCount} 个自定义表情` : '当前全部使用默认表情';
}

function selectPreview(assetId) {
  selectedAssetId = assetId;
  renderInspector();
}

function describeAsset(asset) {
  if (asset.kind === 'builtin') return '内置表情 · 120×120';
  const meta = asset.meta || {};
  const frames = Number(meta.frames) || 1;
  const duration = Number(meta.durationMs) || 0;
  const background = meta.backgroundMode === 'removed-solid' ? '已清理纯色背景'
    : meta.backgroundMode === 'preserved-transparency' ? '保留透明背景' : '保留原背景';
  return `自定义 · ${frames} 帧${duration ? ` · ${(duration / 1000).toFixed(1)} 秒` : ''} · ${background}`;
}

function createVariant(asset) {
  const card = document.createElement('div');
  card.className = `variant-card checkerboard${selectedAssetId === asset.id ? ' selected' : ''}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `预览 ${asset.name}`);
  card.title = asset.name;
  card.appendChild(createImage(asset, asset.name));
  const kind = document.createElement('span');
  kind.className = 'variant-kind';
  kind.textContent = asset.kind === 'custom' ? '自定义' : '默认';
  card.appendChild(kind);
  const choose = () => selectPreview(asset.id);
  card.addEventListener('click', choose);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
  });
  if (asset.kind === 'custom') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'variant-remove';
    remove.textContent = '✕';
    remove.title = '删除这个自定义表情';
    remove.setAttribute('aria-label', `删除 ${asset.name}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeExpression(asset);
    });
    card.appendChild(remove);
  }
  return card;
}

function renderInspector() {
  const definition = currentSlotDefinition();
  const slot = currentSlotData();
  let selected = slot.active.find((asset) => asset.id === selectedAssetId);
  if (!selected) {
    selected = slot.active[0];
    selectedAssetId = selected.id;
  }
  $('asset-detail-icon').textContent = definition.icon;
  $('asset-detail-title').textContent = definition.label;
  $('asset-detail-description').textContent = definition.description;
  $('asset-detail-preview').src = selected.url;
  $('asset-detail-preview').alt = `${definition.label}：${selected.name}`;
  $('asset-detail-meta').textContent = describeAsset(selected);
  $('asset-mode-badge').textContent = slot.mode === 'replace' ? '仅使用自定义' : slot.custom.length ? '默认 + 自定义轮换' : '默认轮换';
  const variants = $('asset-variants');
  variants.replaceChildren(...slot.active.map(createVariant));
  assetReset.disabled = assetBusy || slot.custom.length === 0;
  assetAdd.disabled = assetBusy;
  assetReplace.disabled = assetBusy;
}

function renderAssets() {
  assetCatalog = ASSETS.normalizeCatalog(assetCatalog);
  renderGallery();
  renderInspector();
}

function setAssetBusy(next) {
  assetBusy = next;
  assetAdd.disabled = next;
  assetReplace.disabled = next;
  assetReset.disabled = next || currentSlotData().custom.length === 0;
  removeBackground.disabled = next;
}

async function importExpression(mode) {
  if (assetBusy) return;
  const definition = currentSlotDefinition();
  if (mode === 'replace') {
    const confirmed = window.confirm(`确定替换“${definition.label}”的整组表情吗？\n\n替换后只播放新选择的 GIF；默认和旧的自定义表情不会继续播放。你仍可一键恢复默认。`);
    if (!confirmed) return;
  }
  setAssetBusy(true);
  showAssetStatus('请选择一个 GIF。选中后会自动处理背景、尺寸和动画帧，请稍候…', '', true);
  try {
    const result = await window.pet.importPetGif(selectedSlotId, mode, { removeBackground: removeBackground.checked });
    if (!result || result.canceled) {
      showAssetStatus('没有选择文件，当前表情保持不变。');
      return;
    }
    if (!result.ok) {
      showAssetStatus(result.message || 'GIF 导入失败，请换一个文件重试。', 'error');
      return;
    }
    assetCatalog = ASSETS.normalizeCatalog(result.catalog);
    selectedAssetId = result.imported && result.imported.id;
    renderAssets();
    const warning = Array.isArray(result.warnings) && result.warnings.length ? ` ${result.warnings.join('；')}。` : '';
    showAssetStatus(mode === 'replace' ? `已替换“${definition.label}”。${warning}` : `已为“${definition.label}”新增一个轮换表情。${warning}`, 'success');
  } catch {
    showAssetStatus('GIF 导入失败，请稍后重试。', 'error');
  } finally {
    setAssetBusy(false);
  }
}

async function removeExpression(asset) {
  if (assetBusy || asset.kind !== 'custom') return;
  if (!window.confirm(`删除自定义表情“${asset.name}”吗？\n\n删除后无法从打工喵中恢复，原始 GIF 文件不会受到影响。`)) return;
  setAssetBusy(true);
  showAssetStatus('正在删除自定义表情…', '', true);
  try {
    const result = await window.pet.removePetAsset(selectedSlotId, asset.id);
    if (!result || !result.ok) throw new Error('remove failed');
    assetCatalog = ASSETS.normalizeCatalog(result.catalog);
    selectedAssetId = null;
    renderAssets();
    showAssetStatus('自定义表情已删除；播放列表已立即更新。', 'success');
  } catch { showAssetStatus('删除失败，请重试。', 'error'); }
  finally { setAssetBusy(false); }
}

async function resetSlot() {
  if (assetBusy || !currentSlotData().custom.length) return;
  const definition = currentSlotDefinition();
  if (!window.confirm(`恢复“${definition.label}”的默认表情吗？\n\n这个状态下添加的所有自定义表情都会从打工喵中删除。原始 GIF 文件不会受到影响。`)) return;
  setAssetBusy(true);
  showAssetStatus('正在恢复默认表情…', '', true);
  try {
    const result = await window.pet.resetPetSlot(selectedSlotId);
    if (!result || !result.ok) throw new Error('reset failed');
    assetCatalog = ASSETS.normalizeCatalog(result.catalog);
    selectedAssetId = null;
    renderAssets();
    showAssetStatus(`“${definition.label}”已恢复默认表情。`, 'success');
  } catch { showAssetStatus('恢复失败，请重试。', 'error'); }
  finally { setAssetBusy(false); }
}

async function loadAssetCatalog() {
  try { assetCatalog = ASSETS.normalizeCatalog(await window.pet.getPetAssets()); }
  catch { showAssetStatus('自定义表情读取失败，当前显示默认表情。', 'error'); }
  renderAssets();
}

toggle.addEventListener('click', toggleAutoLaunch);
xiabanSave.addEventListener('click', () => saveXiabanSchedule());
xiabanReset.addEventListener('click', () => saveXiabanSchedule(DEFAULT_XIABAN_TIMES));
assetAdd.addEventListener('click', () => importExpression('append'));
assetReplace.addEventListener('click', () => importExpression('replace'));
assetReset.addEventListener('click', resetSlot);
for (const tab of document.querySelectorAll('.settings-tab')) tab.addEventListener('click', () => setTab(tab.dataset.tab));
if (window.pet.onPetAssets) window.pet.onPetAssets((catalog) => {
  assetCatalog = ASSETS.normalizeCatalog(catalog);
  renderAssets();
});
$('close').addEventListener('click', () => window.pet.closeSettings());
$('done').addEventListener('click', () => window.pet.closeSettings());
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  window.pet.closeSettings();
});

applyStaticI18n();
setTab('general');
loadSettings();
loadXiabanSchedule();
loadAssetCatalog();
