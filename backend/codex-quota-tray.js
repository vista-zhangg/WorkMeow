'use strict';

const WEEKDAYS = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

function two(value) {
  return String(value).padStart(2, '0');
}

function percentText(window) {
  if (!window || !Number.isFinite(window.remainingPercent)) return '--';
  return `${Math.round(Math.max(0, Math.min(100, window.remainingPercent)))}%`;
}

function resetText(window, kind) {
  if (!window || !Number.isFinite(window.resetsAt)) return '--';
  const date = new Date(window.resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return '--';
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return kind === 'weekly' ? `${WEEKDAYS[date.getDay()]} ${time}` : time;
}

function updatedText(updatedAt) {
  if (!Number.isFinite(updatedAt)) return '--';
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return '--';
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function maskedEmail(email) {
  if (typeof email !== 'string' || !email) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return `${email.slice(0, 1)}***`;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function accountText(account) {
  if (!account || account.type !== 'chatgpt') return '--';
  const plan = typeof account.planType === 'string' && account.planType
    ? `${account.planType.slice(0, 1).toUpperCase()}${account.planType.slice(1)}`
    : null;
  const parts = [maskedEmail(account.email), plan].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'ChatGPT';
}

function displayRows(state) {
  const windows = state && state.windows ? state.windows : {};
  return {
    fiveHour: {
      label: '5h',
      remaining: percentText(windows.fiveHour),
      reset: resetText(windows.fiveHour, 'fiveHour'),
    },
    weekly: {
      label: '7d',
      remaining: percentText(windows.weekly),
      reset: resetText(windows.weekly, 'weekly'),
    },
    account: accountText(state && state.account),
    status: state && typeof state.status === 'string' ? state.status : 'unavailable',
    error: state && typeof state.error === 'string' ? state.error : null,
    updated: updatedText(state && state.updatedAt),
  };
}

module.exports = {
  percentText,
  resetText,
  updatedText,
  maskedEmail,
  accountText,
  displayRows,
};
