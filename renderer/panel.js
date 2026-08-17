'use strict';

const $ = (id) => document.getElementById(id);
let lastOpKey = null;
const t = (key, vars) => window.WorkMeowI18n.t(key, vars);

let hoursSummary = '';
let usageMetric = 'tokens';
let usageRange = 'today';

const THEME = {
  name: '打工喵',
  logo: '🐱',
  color: '#3b82f6',
  barGradient: 'linear-gradient(180deg, #7fb3f8, #3b82f6)',
  nowGradient: 'linear-gradient(180deg, #bfdcff, #60a5fa)',
};

function fmt(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function shortModel(m) {
  if (!m) return '?';
  const s = String(m);
  if (s.startsWith('gpt') || s.startsWith('o1') || s.startsWith('o3') || s.startsWith('chatgpt')) {
    return s.replace(/^gpt-/, 'GPT-').replace(/^o(\d)/, 'O$1').replace(/^chatgpt-/, 'ChatGPT-');
  }
  return s.replace(/^claude-/, '').replace(/\[1m\]/, '·1M');
}

function contextLabel(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return `上下文 ${Math.max(0, Math.min(100, Number(value))).toFixed(0)}%`;
}

let lastStats = null;

function applyAgentTheme() {
  // 主题已由 panel.css 的淡蓝配色承担，这里只填品牌与静态文案。
  $('brand-logo').textContent = THEME.logo;
  $('brand-title').textContent = THEME.name;
  const badge = $('agent-badge');
  if (badge) badge.classList.add('hidden');
  $('main-cost-label').textContent = '今日 API 等价估算（全部工具）';
  $('token-detail-title').textContent = 'Token 明细（今日）';
}

// 合并口径下：cacheRead 已是各工具缓存读取之和（含 Codex/WorkBuddy/TRAE 的
// cachedInput，主进程合并时已折算），cacheWrite5m/1h 为缓存写入之和。
// 总输入用主进程算好的 inputTotal（Claude/opencode 的缓存是独立字段，
// Codex/WorkBuddy/TRAE 的 input 已含缓存子集，直接在面板相加会混口径）。
function calcCacheStats(today) {
  const cacheReadTokens = Math.max(0, Number(today.cacheRead) || Number(today.cachedInput) || 0);
  const cacheWrite5m = Math.max(0, Number(today.cacheWrite5m) || Number(today.cacheWrite) || 0);
  const cacheWrite1h = Math.max(0, Number(today.cacheWrite1h) || 0);
  const cacheWriteTokens = cacheWrite5m + cacheWrite1h;
  const hasInputTotal = today.inputTotal !== undefined && today.inputTotal !== null
    && Number.isFinite(Number(today.inputTotal));
  const totalInputTokens = hasInputTotal
    ? Math.max(0, Number(today.inputTotal))
    : Math.max(0, Number(today.input) || 0) + cacheWriteTokens + cacheReadTokens;

  // 缓存命中率 = 缓存读取 / 总输入
  const hitRate = totalInputTokens > 0
    ? Math.min(100, (cacheReadTokens / totalInputTokens) * 100)
    : 0;

  return {
    hitRate,
    cacheReadTokens,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteTokens,
    totalInputTokens,
  };
}

function rangeDays() {
  return usageRange === '30d' ? 30 : usageRange === '7d' ? 7 : 1;
}

function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDateOffset(offset) {
  const d = new Date();
  // Noon avoids a DST boundary moving the date into the neighbouring bucket.
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d;
}

function periodLabel() {
  if (usageRange === '7d') return '近 7 天';
  if (usageRange === '30d') return '近 30 天';
  return '今日';
}

function rangeUsage(s) {
  if (usageRange === 'today') return { ...(s.today || {}) };
  const out = {
    input: 0, output: 0, inputTotal: 0, tokens: 0, cost: 0, messages: 0, msgs: 0,
    cacheRead: 0, cachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWrite: 0, cacheCreate: 0, reasoningOutput: 0,
  };
  const todayKey = localDayKey(new Date());
  const daily = s.daily || {};
  for (let offset = rangeDays() - 1; offset >= 0; offset--) {
    const key = localDayKey(localDateOffset(offset));
    // Prefer the live today aggregate because it includes the latest scan.
    const row = key === todayKey ? (s.today || {}) : (daily[key] || {});
    const cacheRead = Number(row.cacheRead) || Number(row.cachedInput) || 0;
    const cacheWrite5m = Number(row.cacheWrite5m) || Number(row.cacheWrite) || 0;
    const cacheWrite1h = Number(row.cacheWrite1h) || 0;
    const hasInputTotal = row.inputTotal !== undefined && row.inputTotal !== null
      && Number.isFinite(Number(row.inputTotal));
    const inputTotal = hasInputTotal
      ? Number(row.inputTotal)
      : (Number(row.input) || 0) + cacheRead + cacheWrite5m + cacheWrite1h;
    const values = {
      input: Number(row.input) || 0,
      output: Number(row.output) || 0,
      inputTotal: Math.max(0, inputTotal),
      tokens: Number(row.tokens) || 0,
      cost: Number(row.cost) || 0,
      messages: Number(row.messages) || Number(row.msgs) || 0,
      cacheRead: Math.max(0, cacheRead),
      cachedInput: Number(row.cachedInput) || 0,
      cacheWrite5m: Math.max(0, cacheWrite5m),
      cacheWrite1h: Math.max(0, cacheWrite1h),
      cacheWrite: Math.max(0, cacheWrite5m),
      cacheCreate: Math.max(0, cacheWrite5m + cacheWrite1h),
      reasoningOutput: Number(row.reasoningOutput) || 0,
    };
    values.msgs = values.messages;
    for (const keyName of Object.keys(values)) out[keyName] = (out[keyName] || 0) + values[keyName];
  }
  out.messages = out.msgs;
  return out;
}

function renderRangeDetails(s) {
  const usage = rangeUsage(s);
  const cacheStats = calcCacheStats(usage);
  const todayMsgs = usage.msgs || usage.messages || 0;
  const label = periodLabel();

  const hitRateEl = $('cache-hit-rate');
  hitRateEl.textContent = cacheStats.hitRate.toFixed(1) + '%';
  if (cacheStats.hitRate >= 50) hitRateEl.style.color = '#34c759';
  else if (cacheStats.hitRate >= 20) hitRateEl.style.color = '#d4a000';
  else hitRateEl.style.color = '#2563eb';

  $('cache-input-total').textContent = `${t('panel.cacheInputTotal')} ${fmt(cacheStats.totalInputTokens)}`;
  $('cache-tokens').textContent = fmt(cacheStats.cacheReadTokens);
  $('cache-detail').textContent = `写入 ${fmt(cacheStats.cacheWriteTokens)} · 占输入 ${cacheStats.hitRate.toFixed(1)}%`;
  $('token-detail-title').textContent = `Token 明细（${label}）`;

  const tokenRows = $('token-rows');
  tokenRows.innerHTML = `
    <div class="row"><span>${t('panel.cacheInputTotal')} Tokens</span><b id="t-in">${fmt(cacheStats.totalInputTokens)}</b></div>
    <div class="row"><span>${t('panel.tokOut')} Tokens</span><b id="t-out">${fmt(usage.output || 0)}</b></div>
    ${cacheStats.cacheWrite5m ? `<div class="row"><span>${t('panel.tokCacheWrite5m')}</span><b>${fmt(cacheStats.cacheWrite5m)}</b></div>` : ''}
    ${cacheStats.cacheWrite1h ? `<div class="row"><span>${t('panel.tokCacheWrite1h')}</span><b>${fmt(cacheStats.cacheWrite1h)}</b></div>` : ''}
    ${usage.reasoningOutput ? `<div class="row"><span>推理 Tokens</span><b>${fmt(usage.reasoningOutput)}</b></div>` : ''}
    <div class="row cache-read-row"><span>${t('panel.tokCacheRead')}</span><b id="t-cr">${fmt(cacheStats.cacheReadTokens)}</b></div>
    <div class="row total"><span>${t('panel.msgRounds')}</span><b id="t-msg">${todayMsgs}</b></div>
  `;
}

function render(s) {
  if (!s) return;
  lastStats = s;

  // 头部信息
  if (s.active && s.active.project) {
    const context = contextLabel(s.context && s.context.percent);
    $('active-sub').textContent = `${s.active.project} · ${shortModel(s.active.model)}${context ? ' · ' + context : ''}`;
  } else {
    $('active-sub').textContent = t('panel.waitingSession');
  }

  // 今日总览
  $('today-cost').textContent = '$' + (s.today.cost || 0).toFixed(3);
  const todayTokens = s.today.tokens || 0;
  const todayMsgs = s.today.msgs || s.today.messages || 0;
  $('today-foot').textContent = `${fmt(todayTokens)} tokens · ${todayMsgs} 轮`;

  // Cache and token details follow the selected trend range. The top summary
  // remains explicitly “today” so the panel never mixes periods silently.
  renderRangeDetails(s);

  // 累计统计
  const lt = s.lifetime || {};
  $('lt-cost').textContent = '$' + (lt.cost || 0).toFixed(2);
  $('lt-tokens').textContent = fmt(lt.tokens || 0);
  $('lt-msgs').textContent = lt.msgs || lt.messages || 0;

  // 按模型统计
  renderByModel(s.byModel || {});

  // 用量趋势图
  renderChart(s);

  // 会话列表
  renderSessList(s.sessions || []);

  // 操作流
  renderOps(s.lastOps || []);

  // 首次渲染时自适应高度一次，之后不再自动调整
  if (!hasAutoFitted) fitOnce();
}

function renderOps(ops) {
  const list = $('ops');
  if (ops.length === 0) {
    list.innerHTML = '<li class="empty">' + escapeHtml(t('panel.waitingOps')) + '</li>';
    return;
  }
  const topKey = ops[0].ts + ops[0].detail;
  const isNew = topKey !== lastOpKey;
  lastOpKey = topKey;
  list.innerHTML = ops
    .slice(0, 30)
    .map(
      (o, i) =>
        `<li class="${i === 0 && isNew ? 'new' : ''}"><span>${o.icon || '🔧'}</span><span>${escapeHtml(o.detail)}</span><span class="op-proj">${escapeHtml(o.project || '')}</span><span class="op-time">${timeStr(o.ts)}</span></li>`
    )
    .join('');
}

let hasAutoFitted = false;
let fitRaf = 0;

// 只在首次加载时执行一次高度自适应，之后不再自动调整
// （自动调整会在 stats 周期性更新时反复触发 setBounds，导致窗口拉长/拖动失效）
function fitOnce() {
  if (hasAutoFitted) return;
  if (fitRaf) cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    if (!window.pet || !window.pet.setPanelHeight) return;
    const card = $('card');
    if (!card) return;
    const h = Math.ceil(card.scrollHeight + 14);
    const maxH = Math.floor(window.screen.availHeight * 0.9);
    const finalH = Math.min(Math.max(h, 500), maxH);
    if (finalH > 100) {
      hasAutoFitted = true;
      window.pet.setPanelHeight(finalH);
    }
  });
}

function fitPanelHeight() { fitOnce(); }

function renderByModel(byModel) {
  const bm = $('by-model');
  const entries = Object.entries(byModel).sort((a, b) =>
    ((b[1].cost || 0) - (a[1].cost || 0)) || ((b[1].tokens || 0) - (a[1].tokens || 0))
  );
  if (!entries.length) { bm.innerHTML = '<div class="empty">' + escapeHtml(t('panel.noData')) + '</div>'; return; }
  const totCost = entries.reduce((s, [, v]) => s + (v.cost || 0), 0);
  const totTok = entries.reduce((s, [, v]) => s + (v.tokens || 0), 0);
  // Some providers intentionally report zero cost when no matching price is
  // available. Keep the model comparison useful by falling back to tokens.
  const useCostShare = totCost > 0;
  const base = useCostShare ? totCost : (totTok || 1);
  let html = '';
  for (const [model, v] of entries) {
    const share = useCostShare ? (v.cost || 0) : (v.tokens || 0);
    const pct = Math.round((share / base) * 100);
    const cacheRead = v.cacheRead || v.cachedInput || 0;
    const hasDetail = (v.input || v.output || cacheRead || v.cacheWrite5m || v.cacheWrite1h || v.reasoningOutput);
    let detail = '';
    if (hasDetail) {
      detail = `<div class="m-detail">入 ${fmt(v.inputTotal || v.input)} · 出 ${fmt(v.output)} · 缓读 ${fmt(cacheRead)}${v.cacheWrite5m ? ` · 写 ${fmt(v.cacheWrite5m)}` : ''}${v.reasoningOutput ? ` · 推理 ${fmt(v.reasoningOutput)}` : ''}${v.msgs ? ` · ${v.msgs}轮` : ''}</div>`;
    }
    html += `<div class="m-item">`
      + `<div class="m-head"><span class="mc">${escapeHtml(shortModel(model))}</span>`
      + `<span class="m-bar"><i style="width:${pct}%;background:${THEME.color}"></i></span>`
      + `<b class="m-cost">$${(v.cost || 0).toFixed(3)}</b>`
      + `<span class="m-tok">${fmt(v.tokens)} · ${pct}%</span></div>`
      + detail + `</div>`;
  }
  html += `<div class="m-item m-total"><div class="m-head"><span class="mc">合计</span>`
    + `<span class="m-bar"></span><b class="m-cost">$${totCost.toFixed(3)}</b>`
    + `<span class="m-tok">${fmt(totTok)}</span></div></div>`;
  bm.innerHTML = html;
}

const STATE_META = {
  working: { key: 'state.working', cls: 'st-working' },
  juggling: { key: 'state.juggling', cls: 'st-working' },
  sweeping: { key: 'state.sweeping', cls: 'st-working' },
  thinking: { key: 'state.thinking', cls: 'st-thinking' },
  loafing: { key: 'state.loafing', cls: 'st-idle' },
  waiting: { key: 'state.waiting', cls: 'st-waiting' },
  needsinput: { key: 'state.needsinput', cls: 'st-needsinput' },
  error: { key: 'state.error', cls: 'st-error' },
  done: { key: 'state.done', cls: 'st-done' },
  idle: { key: 'state.idle', cls: 'st-idle' },
  sleeping: { key: 'state.sleeping', cls: 'st-sleeping' },
  greet: { key: 'state.greet', cls: 'st-greet' },
  talking: { key: 'state.talking', cls: 'st-talking' },
};

const AGENT_ICON = {
  claude: '<svg viewBox="0 0 24 24" fill="#d97757"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>',
  codex: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b82f6"/><path d="M7 8l4 4-4 4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5h4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  trae: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#16b8a6"/><path d="M7 17L17 7M17 7H9M17 7V15" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  workbuddy: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#6d5efc"/><path d="M12 6l1.35 3.65L17 11l-3.65 1.35L12 16l-1.35-3.65L7 11l3.65-1.35z" fill="#fff"/></svg>',
  opencode: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#17181c"/><path d="M8.5 6.5v11L17.5 12z" fill="#ff5f1f"/></svg>',
};
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', trae: 'TRAE', workbuddy: 'WorkBuddy', opencode: 'opencode' };

function renderSessList(sessions) {
  const el = $('sess-list');
  const activeStates = new Set(['waiting', 'needsinput', 'error', 'working', 'juggling', 'sweeping', 'thinking', 'loafing']);
  const priority = { waiting: 0, needsinput: 1, error: 2, sweeping: 3, juggling: 4, working: 5, thinking: 6, loafing: 7 };
  const filtered = (sessions || [])
    .filter((s) => s && !s.headless && (activeStates.has(s.state) || s.badge === 'done' || s.badge === 'interrupted'))
    .sort((a, b) => {
      const ae = a.badge === 'interrupted' ? 'error' : a.badge === 'done' ? 'done' : a.state;
      const be = b.badge === 'interrupted' ? 'error' : b.badge === 'done' ? 'done' : b.state;
      const ap = ae === 'done' ? 8 : (priority[ae] == null ? 9 : priority[ae]);
      const bp = be === 'done' ? 8 : (priority[be] == null ? 9 : priority[be]);
      return ap - bp || Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
  if (!filtered.length) {
    el.innerHTML = '<div class="empty">' + escapeHtml(t('panel.noActiveSession')) + '</div>';
    return;
  }
  el.innerHTML = filtered
    .slice(0, 8)
    .map((s) => {
      const effState = s.state === 'idle' && s.badge === 'done' ? 'done'
        : s.state === 'idle' && s.badge === 'interrupted' ? 'error'
        : s.state;
      const m = STATE_META[effState] || STATE_META.idle;
      const detail =
        effState === 'waiting' ? escapeHtml(s.reason ? t('wait.' + s.reason) : t('wait.default'))
        : effState === 'needsinput' ? escapeHtml((s.choice && s.choice.question) || t('state.needsinput'))
        : (effState === 'working' || effState === 'juggling' || effState === 'sweeping' || effState === 'thinking') && s.op ? escapeHtml(s.op)
        : escapeHtml(t(m.key));
      const context = contextLabel(s.contextPercent);
      const contextSuffix = context ? ` · ${context}` : '';
      const icon = AGENT_ICON[s.agent] || AGENT_ICON.claude;
      const who = AGENT_NAME[s.agent] || 'Claude';
      const proj = escapeHtml(s.project || '');
      const detailTitle = `${detail}${contextSuffix}`;
      return `<div class="row sess"><span class="badge ${m.cls}">${escapeHtml(t(m.key))}</span><span class="sess-agent" title="${who}">${icon}</span><span class="sess-proj" title="${proj}">${proj}</span><span class="sess-op" title="${detailTitle}">${detail}${escapeHtml(contextSuffix)}</span></div>`;
    })
    .join('');
}

function buildChartPoints(s) {
  if (usageRange === 'today') {
    const values = usageMetric === 'cost' ? (s.hourly || []) : (s.hourlyTok || []);
    const hours = values.length === 24 ? values : new Array(24).fill(0);
    return hours.map((value, hour) => ({
      value: Number(value) || 0,
      label: `${hour}:00`,
      axis: [0, 6, 12, 18, 23].includes(hour) ? `${hour}${t('panel.hourUnit')}` : '',
      isNow: hour === new Date().getHours(),
    }));
  }

  const daily = s.daily || {};
  const todayKey = localDayKey(new Date());
  const points = [];
  for (let offset = rangeDays() - 1; offset >= 0; offset--) {
    const date = localDateOffset(offset);
    const key = localDayKey(date);
    const row = key === todayKey ? (s.today || {}) : (daily[key] || {});
    const value = usageMetric === 'cost' ? Number(row.cost) || 0 : Number(row.tokens) || 0;
    const label = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const tick = rangeDays() === 7
      ? [0, 2, 4, 6].includes(points.length)
      : [0, 6, 12, 18, 24, 29].includes(points.length);
    points.push({ value, label, axis: tick ? label : '', isNow: key === todayKey });
  }
  return points;
}

function renderChart(s) {
  const el = $('chart');
  const axis = $('chart-axis');
  if (!el || !axis) return;
  const points = buildChartPoints(s);
  const max = Math.max(0.000001, ...points.map((point) => point.value));
  let total = 0;
  let peakIndex = -1;
  let peakValue = 0;
  const count = points.length || 1;
  el.style.setProperty('--bar-count', count);
  axis.style.setProperty('--bar-count', count);
  el.innerHTML = points.map((point, index) => {
    const value = point.value;
    total += value;
    if (value > peakValue) { peakValue = value; peakIndex = index; }
    const pct = Math.max(4, Math.round((value / max) * 100));
    const cls = value <= 0 ? 'bar empty' : point.isNow ? 'bar now' : 'bar';
    const display = usageMetric === 'cost' ? '$' + value.toFixed(3) : fmt(value) + ' tokens';
    const barBg = point.isNow ? THEME.nowGradient : THEME.barGradient;
    return `<div class="${cls}" data-label="${escapeHtml(point.label)}" data-v="${escapeHtml(display)}" style="height:${pct}%;background:${value <= 0 ? '' : barBg}" title="${escapeHtml(point.label)} · ${escapeHtml(display)}"></div>`;
  }).join('');
  axis.innerHTML = points.map((point) => `<span>${escapeHtml(point.axis)}</span>`).join('');

  const peak = peakIndex >= 0 ? points[peakIndex] : null;
  const range = periodLabel();
  hoursSummary = usageMetric === 'cost'
    ? `${range}总计 $${total.toFixed(3)} · 峰值 ${peak ? `${peak.label} $${peakValue.toFixed(3)}` : '—'}`
    : `${range}总计 ${fmt(total)} tokens · 峰值 ${peak ? `${peak.label} ${fmt(peakValue)}` : '—'}`;
  const ro = $('hours-readout');
  if (ro) ro.innerHTML = hoursSummary;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 事件监听
window.pet.onPanelStats(render);
window.pet.onPrice((m) => {
  const el = $('price-src');
  if (!el || !m) return;
  const sources = Array.isArray(m.sources) ? m.sources : [];
  const names = sources.map((source) => source.name).filter(Boolean).join('、');
  const scope = names ? `${names} · ${m.count || 0} 个模型` : `${m.count || 0} 个模型`;
  if (m.live) {
    const when = m.ts ? new Date(m.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '缓存';
    el.textContent = `价目表: 在线（${scope}，${when} 更新）${m.stale ? ' · 建议刷新' : ''}`;
  } else if (m.mixed) {
    el.textContent = `价目表: 部分在线、部分内置（${scope}）${m.stale ? ' · 建议刷新' : ''}`;
  } else {
    el.textContent = `价目表: 内置价格（${scope}）`;
  }
  el.title = m.estimate ? '部分数据源在未匹配到精确价格时会采用估算；WorkBuddy 未匹配模型不计费。' : '所有数据源均使用精确价格或用户覆盖。';
});

function applyStaticI18n() {
  document.documentElement.lang = 'zh-CN';
  document.title = '打工喵 · 详情';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

$('close').addEventListener('click', () => window.pet.closePanel());

// 详情面板是独立窗口，ESC 直接收起它，不需要把鼠标移到右上角。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  window.pet.closePanel();
});

document.querySelectorAll('.metric-tabs .mt').forEach((b) =>
  b.addEventListener('click', () => {
    usageMetric = b.dataset.metric === 'cost' ? 'cost' : 'tokens';
    document.querySelectorAll('.metric-tabs .mt').forEach((x) => x.classList.toggle('active', x === b));
    if (lastStats) {
      renderChart(lastStats);
      setTimeout(fitPanelHeight, 50);
    }
  })
);

document.querySelectorAll('.range-tabs .range').forEach((b) =>
  b.addEventListener('click', () => {
    usageRange = ['today', '7d', '30d'].includes(b.dataset.range) ? b.dataset.range : 'today';
    document.querySelectorAll('.range-tabs .range').forEach((x) => x.classList.toggle('active', x === b));
    if (lastStats) {
      renderRangeDetails(lastStats);
      renderChart(lastStats);
      setTimeout(fitPanelHeight, 50);
    }
  })
);

// 悬停查看具体数值
$('chart').addEventListener('mouseover', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) $('hours-readout').innerHTML = `${escapeHtml(bar.dataset.label)} · <b>${escapeHtml(bar.dataset.v)}</b>`;
});
$('chart').addEventListener('mouseleave', () => { $('hours-readout').innerHTML = hoursSummary; });

// 初始化
(async () => {
  applyStaticI18n();
  applyAgentTheme();
  const s = await window.pet.getStats();
  if (s) render(s);
  // 首次数据渲染后，延迟一次确保内容完全渲染，再做自适应高度
  setTimeout(fitOnce, 300);
})();
