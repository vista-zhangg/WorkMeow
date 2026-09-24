'use strict';

// This card lives beside the shared capsule, so it works with or without the
// cat artwork. Agent state never starts, stops or resets the reminder clock.
(function () {
  const card = document.getElementById('rest-reminder');
  if (!card || !window.pet.getCompanionState) return;
  const title = document.getElementById('rest-title');
  const message = document.getElementById('rest-message');
  const status = document.getElementById('rest-action-status');
  const badge = document.getElementById('rest-pending');
  const buttons = ['done', 'snooze', 'skip'].map(name => document.getElementById('rest-' + name));
  let value = null;
  let open = false;
  let signature = '';
  let submitting = false;
  let deferredUntil = 0;
  let deferTimer = null;

  function hide() {
    if (!open) return;
    open = false;
    signature = '';
    card.classList.add('hidden');
    requestAnimationFrame(refresh);
  }

  function refresh() {
    const pending = value && value.rest && value.rest.pending;
    const hidden = document.hidden === true || (value && value.visibility && value.visibility.visible === false);
    const occupied = askActive || actionPopOpen || peekOpen || quotaPopoverOpen || radialOpen || !!g || Date.now() < deferredUntil;
    const blocked = hidden || occupied;
    // A permission may wait for hours while the person works elsewhere. Keep
    // the reminder visible in the capsule without closing or stealing focus
    // from the current card. Clicking the small reminder defers it safely.
    if (badge) {
      badge.hidden = !pending || hidden || !occupied;
      if (!badge.hidden) {
        badge.textContent = pending.kinds.includes('water') ? '♡ 喝口水' : pending.kinds.includes('stretch') ? '♡ 伸个懒腰' : '♡ 看看远处';
        const label = `休息提醒：${badge.textContent.slice(2)}；点击推迟 ${value.rest.preferences.snoozeMinutes || 10} 分钟`;
        badge.title = label;
        badge.setAttribute('aria-label', label);
      }
    }
    if (!pending || blocked) {
      const wasOpen = open;
      hide();
      if (wasOpen && !blocked) resetPetSize();
      return;
    }
    const nextSignature = pending.id + ':' + pending.kinds.join(',') + ':' + value.rest.preferences.snoozeMinutes;
    if (open && signature === nextSignature) return;
    signature = nextSignature;
    const names = { water: '喝口水', stretch: '起身伸个懒腰', eyes: '看看远处' };
    title.textContent = pending.kinds.map(kind => names[kind]).filter(Boolean).join('，') + '吧';
    message.textContent = pending.kinds.includes('stretch')
      ? '离开座位走两步，让肩颈也放松一下。伙伴继续帮你看着进度。'
      : pending.kinds.includes('water') ? '给自己补一点水，慢慢来，伙伴陪你。' : '把视线从屏幕移开一会儿，让眼睛也休息一下。';
    document.getElementById('rest-snooze').textContent = `${value.rest.preferences.snoozeMinutes || 10} 分钟后`;
    status.textContent = '';
    bubble.classList.add('hidden');
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    open = true;
    card.classList.remove('hidden');
    fitPopup(card);
  }

  function receive(next) {
    if (!next || !next.rest) return;
    value = next;
    refresh();
  }

  function defer(milliseconds) {
    hide();
    deferredUntil = Date.now() + Math.max(0, Number(milliseconds) || 0);
    clearTimeout(deferTimer);
    deferTimer = setTimeout(refresh, Math.max(0, deferredUntil - Date.now()) + 20);
    if (deferTimer && typeof deferTimer.unref === 'function') deferTimer.unref();
  }

  async function act(action) {
    const pending = value && value.rest && value.rest.pending;
    if (!pending || submitting) return;
    submitting = true;
    buttons.forEach(button => { button.disabled = true; });
    if (badge) badge.disabled = true;
    try {
      const next = await window.pet.restAction({ id: pending.id, action });
      if (next && next.rest) receive(next);
      if (!next || !next.ok) status.textContent = next && next.rest && !next.rest.pending ? '' : '没有保存成功，请再试一次';
    } catch { status.textContent = '没有保存成功，请再试一次'; }
    finally { submitting = false; buttons.forEach(button => { button.disabled = false; }); if (badge) badge.disabled = false; }
  }

  buttons[0].addEventListener('click', () => act('done'));
  buttons[1].addEventListener('click', () => act('snooze'));
  buttons[2].addEventListener('click', () => act('skip-today'));
  if (badge) badge.addEventListener('click', (event) => { event.stopPropagation(); act('snooze'); });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); act('snooze'); }
  });
  window.AgentPawCompanion = { refresh, hide, defer, isOpen: () => open };
  if (window.pet.onCompanionState) window.pet.onCompanionState(receive);
  document.addEventListener('visibilitychange', refresh);
  window.pet.getCompanionState().then(receive).catch(() => {});
})();
