'use strict';

const { t } = window.WorkMeowI18n;
const ASSETS = window.WorkMeowPetAssets;
const $ = (id) => document.getElementById(id);

const toggle = $('auto-launch-toggle');
const statusEl = $('setting-status');
const updateToggle = $('auto-update-toggle');
const updateModeDescription = $('update-mode-description');
const currentVersionEl = $('current-version');
const latestVersionEl = $('latest-version');
const updateStatusEl = $('update-status');
const updateCheck = $('update-check');
const updateAction = $('update-action');
const updateProgress = $('update-progress');
const updateProgressBar = $('update-progress-bar');
const updateHint = $('update-hint');
const integrationSummary = $('integration-summary');
const integrationList = $('integration-list');
const integrationStatusEl = $('integration-status');
const integrationRefresh = $('integration-refresh');
const integrationRepair = $('integration-repair');
const lunchTime = $('xiaban-lunch-time');
const eveningTime = $('xiaban-evening-time');
const xiabanStatusEl = $('xiaban-status');
const xiabanSave = $('xiaban-save');
const xiabanReset = $('xiaban-reset');
const assetGallery = $('asset-gallery');
const assetStatus = $('asset-status');
const assetAdd = $('asset-add');
const assetReplace = $('asset-replace');
const assetRemove = $('asset-remove');
const assetReset = $('asset-reset');
const removeBackground = $('remove-bg-toggle');
const DEFAULT_XIABAN_TIMES = Object.freeze({ lunch: '10:55', evening: '16:55' });

let enabled = false;
let supported = true;
let busy = false;
let updateBusy = false;
let updateState = null;
let integrationBusy = false;
let integrationHealth = null;
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

function integrationModeLabel(mode) {
  if (mode === 'watcher') return t('settings.integrationsWatcher');
  if (mode === 'plugin') return t('settings.integrationsPlugin');
  return t('settings.integrationsHook');
}

function integrationStateLabel(state) {
  if (state === 'ready') return t('settings.integrationsReady');
  if (state === 'needs-repair') return t('settings.integrationsRepair');
  if (state === 'disabled') return t('settings.integrationsDisabled');
  return t('settings.integrationsMissing');
}

function integrationEventLabel(row) {
  if (!row.detected) return integrationModeLabel(row.mode);
  if (!row.lastEventAt) return `${integrationModeLabel(row.mode)} · ${t('settings.integrationsNoEvent')}`;
  const time = new Date(row.lastEventAt).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return `${integrationModeLabel(row.mode)} · ${t('settings.integrationsLastEvent', { time })}`;
}

function renderIntegrationHealth(report, messageKey = null, kind = '') {
  integrationHealth = report && Array.isArray(report.integrations) ? report : null;
  integrationList.replaceChildren();
  if (!integrationHealth) {
    integrationSummary.textContent = t('settings.integrationsCheckFailed');
    integrationStatusEl.textContent = messageKey ? t(messageKey) : '';
    integrationStatusEl.className = `setting-status${kind ? ` ${kind}` : ''}`;
    integrationRefresh.disabled = integrationBusy;
    integrationRepair.disabled = true;
    return;
  }

  const summary = integrationHealth.summary || {};
  integrationSummary.textContent = summary.detected === 0
    ? t('settings.integrationsNone')
    : summary.needsRepair === 0
      ? t('settings.integrationsHealthy', { detected: summary.detected })
      : t('settings.integrationsIssues', {
        ready: summary.ready, detected: summary.detected, issues: summary.needsRepair,
      });
  for (const row of integrationHealth.integrations) {
    const item = document.createElement('div');
    item.className = 'integration-row';
    const name = document.createElement('span');
    name.className = 'integration-name';
    name.textContent = row.label;
    const detail = document.createElement('span');
    detail.className = 'integration-detail';
    detail.textContent = integrationEventLabel(row);
    detail.title = detail.textContent;
    const state = document.createElement('span');
    state.className = `integration-state ${row.state}`;
    state.textContent = integrationStateLabel(row.state);
    item.append(name, detail, state);
    integrationList.appendChild(item);
  }
  integrationStatusEl.textContent = messageKey ? t(messageKey) : '';
  integrationStatusEl.className = `setting-status${kind ? ` ${kind}` : ''}`;
  integrationRefresh.disabled = integrationBusy;
  integrationRepair.disabled = integrationBusy || !(summary.repairable > 0);
}

async function loadIntegrationHealth(messageKey = null, kind = '') {
  if (integrationBusy) return;
  integrationBusy = true;
  integrationSummary.textContent = t('settings.integrationsChecking');
  integrationRefresh.disabled = true;
  integrationRepair.disabled = true;
  try {
    const report = await window.pet.getIntegrationHealth();
    if (!report || report.error === 'forbidden') throw new Error('health unavailable');
    renderIntegrationHealth(report, messageKey, kind);
  } catch {
    renderIntegrationHealth(null, 'settings.integrationsCheckFailed', 'error');
  } finally {
    integrationBusy = false;
    if (integrationHealth) renderIntegrationHealth(integrationHealth, messageKey, kind);
  }
}

async function repairIntegrations() {
  if (integrationBusy || !integrationHealth || !(integrationHealth.summary.repairable > 0)) return;
  integrationBusy = true;
  integrationStatusEl.textContent = t('settings.integrationsRepairing');
  integrationStatusEl.className = 'setting-status';
  integrationRefresh.disabled = true;
  integrationRepair.disabled = true;
  try {
    const report = await window.pet.repairIntegrations();
    if (!report || report.error === 'forbidden') throw new Error('repair unavailable');
    const message = report.ok
      ? 'settings.integrationsRepaired'
      : report.error === 'disabled-by-environment'
        ? 'settings.integrationsEnvDisabled'
        : 'settings.integrationsPartial';
    renderIntegrationHealth(report, message, report.ok ? '' : 'error');
  } catch {
    renderIntegrationHealth(integrationHealth, 'settings.integrationsCheckFailed', 'error');
  } finally {
    integrationBusy = false;
    if (integrationHealth) {
      integrationRefresh.disabled = false;
      integrationRepair.disabled = !(integrationHealth.summary.repairable > 0);
    }
  }
}

function updateStatusText(state) {
  const version = state.latestVersion || '--';
  switch (state.phase) {
    case 'checking': return t('settings.updateChecking');
    case 'up-to-date': return t('settings.updateLatest');
    case 'available': return t('settings.updateAvailable', { version });
    case 'downloading': return t('settings.updateDownloading', { percent: Math.round(state.progress || 0) });
    case 'downloaded': return t('settings.updateDownloaded');
    case 'error': return t('settings.updateFailed', { message: state.error || '未知错误' });
    case 'development': return t('settings.updateDevelopment');
    case 'unsupported': return t('settings.updateUnsupported');
    default: return t('settings.updateIdle');
  }
}

function renderUpdateState(next) {
  updateState = next && typeof next === 'object' ? next : {
    supported: false, mode: 'unsupported', autoCheck: false,
    currentVersion: '--', latestVersion: null, phase: 'unsupported', progress: null,
  };
  const state = updateState;
  const active = state.phase === 'checking' || state.phase === 'downloading';
  updateToggle.setAttribute('aria-checked', String(!!state.autoCheck));
  updateToggle.disabled = updateBusy || !state.supported;
  currentVersionEl.textContent = state.currentVersion || '--';
  latestVersionEl.textContent = state.latestVersion || '--';
  updateCheck.disabled = updateBusy || !state.supported || active;
  updateStatusEl.textContent = updateStatusText(state);
  updateStatusEl.className = `setting-status${state.phase === 'error' ? ' error' : ''}${!state.supported ? ' unsupported' : ''}`;

  const downloading = state.phase === 'downloading';
  updateProgress.hidden = !downloading;
  updateProgressBar.style.width = `${downloading ? Math.max(2, Number(state.progress) || 0) : 0}%`;

  updateAction.hidden = true;
  updateAction.dataset.action = '';
  if (state.mode === 'portable' && state.phase === 'available') {
    updateAction.hidden = false;
    updateAction.dataset.action = 'open';
    updateAction.textContent = t('settings.openDownload');
  } else if (state.mode === 'installer' && state.phase === 'available') {
    updateAction.hidden = false;
    updateAction.dataset.action = 'download';
    updateAction.textContent = t('settings.downloadUpdate');
  } else if (state.mode === 'installer' && state.phase === 'downloaded') {
    updateAction.hidden = false;
    updateAction.dataset.action = 'install';
    updateAction.textContent = t('settings.restartUpdate');
  }
  updateAction.disabled = updateBusy || active;

  if (state.mode === 'installer') {
    updateModeDescription.textContent = t('settings.installerUpdateDescription');
    updateHint.textContent = t('settings.updateInstallerHint');
  } else if (state.mode === 'portable') {
    updateModeDescription.textContent = t('settings.portableUpdateDescription');
    updateHint.textContent = t('settings.updatePortableHint');
  } else {
    updateModeDescription.textContent = t('settings.developmentUpdateDescription');
    updateHint.textContent = '';
  }
}

async function loadUpdateState() {
  try { renderUpdateState(await window.pet.getUpdateState()); }
  catch { renderUpdateState(null); }
}

async function toggleAutoUpdate() {
  if (!updateState || !updateState.supported || updateBusy) return;
  updateBusy = true;
  renderUpdateState(updateState);
  try {
    const result = await window.pet.setAutoUpdate(!updateState.autoCheck);
    renderUpdateState(result && result.ok ? result : { ...updateState, phase: 'error', error: '设置保存失败' });
  } catch { renderUpdateState({ ...updateState, phase: 'error', error: '设置保存失败' }); }
  finally { updateBusy = false; renderUpdateState(updateState); }
}

async function checkUpdatesNow() {
  if (!updateState || !updateState.supported || updateBusy) return;
  updateBusy = true;
  renderUpdateState({ ...updateState, phase: 'checking', error: null });
  try { renderUpdateState(await window.pet.checkForUpdates()); }
  catch { renderUpdateState({ ...updateState, phase: 'error', error: '检查更新失败，请稍后重试' }); }
  finally { updateBusy = false; renderUpdateState(updateState); }
}

async function runUpdateAction() {
  if (!updateState || updateBusy) return;
  updateBusy = true;
  renderUpdateState(updateState);
  try {
    if (updateAction.dataset.action === 'open') await window.pet.openUpdatePage();
    else if (updateAction.dataset.action === 'download') renderUpdateState(await window.pet.downloadUpdate());
    else if (updateAction.dataset.action === 'install') await window.pet.installUpdate();
  } catch { renderUpdateState({ ...updateState, phase: 'error', error: '更新操作失败，请稍后重试' }); }
  finally { updateBusy = false; renderUpdateState(updateState); }
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
  if (slot.custom.length) return `${slot.active.length} 个 · 自定义 ${slot.custom.length}`;
  if (slot.mode !== 'default') return `${slot.active.length} 个 · 已调整`;
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
  const modifiedCount = ASSETS.SLOTS.filter((def) => assetCatalog.slots[def.id].mode !== 'default').length;
  $('asset-summary').textContent = modifiedCount ? `已调整 ${modifiedCount} 个状态` : '当前全部使用默认表情';
}

function selectPreview(assetId) {
  selectedAssetId = assetId;
  renderInspector();
}

function describeAsset(asset) {
  if (asset.kind === 'builtin') return `默认 · ${asset.name} · 120×120`;
  const meta = asset.meta || {};
  const frames = Number(meta.frames) || 1;
  const duration = Number(meta.durationMs) || 0;
  const background = meta.backgroundMode === 'removed-solid' ? '已清理纯色背景'
    : meta.backgroundMode === 'preserved-transparency' ? '保留透明背景' : '保留原背景';
  return `自定义 · ${asset.name} · ${frames} 帧${duration ? ` · ${(duration / 1000).toFixed(1)} 秒` : ''} · ${background}`;
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
  $('asset-detail-meta').title = selected.name;
  $('asset-mode-badge').textContent = slot.mode === 'replace' ? '仅使用自定义'
    : slot.custom.length && slot.usingDefaults ? '默认 + 自定义轮换'
      : slot.custom.length ? '自定义轮换'
        : slot.mode !== 'default' ? '已隐藏部分默认' : '默认轮换';
  const variants = $('asset-variants');
  variants.replaceChildren(...slot.active.map(createVariant));
  assetReset.disabled = assetBusy || slot.mode === 'default';
  assetAdd.disabled = assetBusy;
  assetReplace.disabled = assetBusy;
  assetRemove.disabled = assetBusy || slot.active.length <= 1;
  assetRemove.title = slot.active.length <= 1 ? '每个状态至少要保留一个表情' : `从播放列表移出“${selected.name}”`;
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
  assetRemove.disabled = next || currentSlotData().active.length <= 1;
  assetReset.disabled = next || currentSlotData().mode === 'default';
  removeBackground.disabled = next;
}

async function importExpression(mode) {
  if (assetBusy) return;
  const definition = currentSlotDefinition();
  const selected = currentSlotData().active.find((asset) => asset.id === selectedAssetId) || currentSlotData().active[0];
  if (mode === 'replace-one') {
    const irreversible = selected.kind === 'custom' ? '\n\n旧的自定义副本会从打工喵中删除，原始 GIF 文件不受影响。' : '';
    const confirmed = window.confirm(`用新的 GIF 替换当前选中的“${selected.name}”吗？${irreversible}`);
    if (!confirmed) return;
  }
  setAssetBusy(true);
  showAssetStatus('请选择一个 GIF。选中后会自动处理背景、尺寸和动画帧，请稍候…', '', true);
  try {
    const result = await window.pet.importPetGif(selectedSlotId, mode, {
      removeBackground: removeBackground.checked,
      assetId: mode === 'replace-one' ? selected.id : undefined,
    });
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
    showAssetStatus(mode === 'replace-one'
      ? `已替换“${definition.label}”中选中的表情。${warning}`
      : `已为“${definition.label}”新增一个轮换表情。${warning}`, 'success');
  } catch {
    showAssetStatus('GIF 导入失败，请稍后重试。', 'error');
  } finally {
    setAssetBusy(false);
  }
}

async function removeSelectedExpression() {
  const slot = currentSlotData();
  const asset = slot.active.find((item) => item.id === selectedAssetId) || slot.active[0];
  if (assetBusy || !asset || slot.active.length <= 1) return;
  const definition = currentSlotDefinition();
  const detail = asset.kind === 'custom'
    ? '\n\n自定义副本会从打工喵中删除，原始 GIF 文件不受影响。'
    : '\n\n可随时通过“恢复默认”重新启用它。';
  if (!window.confirm(`从“${definition.label}”的播放列表中移出“${asset.name}”吗？${detail}`)) return;
  setAssetBusy(true);
  showAssetStatus('正在移出选中的表情…', '', true);
  try {
    const result = await window.pet.removePetAsset(selectedSlotId, asset.id);
    if (!result || !result.ok) {
      if (result && result.error === 'last-asset') {
        showAssetStatus('每个状态至少要保留一个表情；请先新增或替换。', 'error');
        return;
      }
      throw new Error('remove failed');
    }
    assetCatalog = ASSETS.normalizeCatalog(result.catalog);
    selectedAssetId = null;
    renderAssets();
    showAssetStatus('选中的表情已移出；播放列表已立即更新。', 'success');
  } catch { showAssetStatus('移出失败，请重试。', 'error'); }
  finally { setAssetBusy(false); }
}

async function resetSlot() {
  if (assetBusy || currentSlotData().mode === 'default') return;
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
integrationRefresh.addEventListener('click', () => loadIntegrationHealth());
integrationRepair.addEventListener('click', repairIntegrations);
updateToggle.addEventListener('click', toggleAutoUpdate);
updateCheck.addEventListener('click', checkUpdatesNow);
updateAction.addEventListener('click', runUpdateAction);
xiabanSave.addEventListener('click', () => saveXiabanSchedule());
xiabanReset.addEventListener('click', () => saveXiabanSchedule(DEFAULT_XIABAN_TIMES));
assetAdd.addEventListener('click', () => importExpression('append'));
assetReplace.addEventListener('click', () => importExpression('replace-one'));
assetRemove.addEventListener('click', removeSelectedExpression);
assetReset.addEventListener('click', resetSlot);
for (const tab of document.querySelectorAll('.settings-tab')) tab.addEventListener('click', () => setTab(tab.dataset.tab));
if (window.pet.onPetAssets) window.pet.onPetAssets((catalog) => {
  assetCatalog = ASSETS.normalizeCatalog(catalog);
  renderAssets();
});
if (window.pet.onUpdateState) window.pet.onUpdateState(renderUpdateState);
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
loadIntegrationHealth();
loadUpdateState();
loadXiabanSchedule();
loadAssetCatalog();
