'use strict';

const { t } = window.WorkMeowI18n;

const $ = (id) => document.getElementById(id);
const toggle = $('auto-launch-toggle');
const statusEl = $('setting-status');
const lunchTime = $('xiaban-lunch-time');
const eveningTime = $('xiaban-evening-time');
const xiabanStatusEl = $('xiaban-status');
const xiabanSave = $('xiaban-save');
const xiabanReset = $('xiaban-reset');
const DEFAULT_XIABAN_TIMES = Object.freeze({ lunch: '10:55', evening: '16:55' });
let enabled = false;
let supported = true;
let busy = false;
let xiabanBusy = false;

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

function renderStatus(messageKey = null, kind = '') {
  toggle.setAttribute('aria-checked', String(enabled));
  toggle.disabled = !supported || busy;
  statusEl.className = `setting-status${kind ? ` ${kind}` : ''}`;
  if (messageKey) {
    statusEl.textContent = t(messageKey);
  } else {
    statusEl.textContent = t(enabled ? 'settings.enabled' : 'settings.disabled');
  }
}

function applyState(result, messageKey = null, kind = '') {
  supported = result && result.supported !== false;
  enabled = !!(result && result.enabled);
  const hasError = !!(result && result.error);
  renderStatus(
    messageKey || (hasError ? 'settings.failed' : supported ? null : 'settings.unsupported'),
    kind || (hasError ? 'error' : supported ? '' : 'unsupported'),
  );
}

async function loadSettings() {
  try {
    applyState(await window.pet.getAutoLaunch());
  } catch {
    supported = true;
    renderStatus('settings.failed', 'error');
  }
}

async function toggleAutoLaunch() {
  if (!supported || toggle.disabled) return;
  busy = true;
  renderStatus('settings.saving');
  try {
    const result = await window.pet.setAutoLaunch(!enabled);
    if (result && result.ok) {
      applyState(result, 'settings.saved');
    } else {
      applyState(result, 'settings.failed', 'error');
    }
  } catch {
    renderStatus('settings.failed', 'error');
  } finally {
    busy = false;
    toggle.disabled = !supported;
  }
}

function isClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function scheduleFrom(result) {
  const schedule = result && result.schedule ? result.schedule : result;
  if (!schedule || !isClockTime(schedule.lunch) || !isClockTime(schedule.evening)) return null;
  return { lunch: schedule.lunch, evening: schedule.evening };
}

function renderXiabanStatus(messageKey = null, kind = '') {
  xiabanStatusEl.className = 'setting-status' + (kind ? ' ' + kind : '');
  xiabanStatusEl.textContent = messageKey ? t(messageKey) : '';
}

function applyXiabanInputs(schedule) {
  lunchTime.value = schedule.lunch;
  eveningTime.value = schedule.evening;
}

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

toggle.addEventListener('click', toggleAutoLaunch);
xiabanSave.addEventListener('click', () => saveXiabanSchedule());
xiabanReset.addEventListener('click', () => saveXiabanSchedule(DEFAULT_XIABAN_TIMES));
$('close').addEventListener('click', () => window.pet.closeSettings());
$('done').addEventListener('click', () => window.pet.closeSettings());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  window.pet.closeSettings();
});

applyStaticI18n();
loadSettings();
loadXiabanSchedule();
