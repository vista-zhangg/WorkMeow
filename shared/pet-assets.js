'use strict';

// One visual-asset vocabulary shared by the main process, pet renderer and
// settings gallery. A slot always resolves to an ordered list: one GIF behaves
// like a normal replacement, while multiple GIFs rotate without repetition.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowPetAssets = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const SLOT_GROUPS = Object.freeze([
    { id: 'work', label: '工作状态' },
    { id: 'feedback', label: '反馈与互动' },
    { id: 'rest', label: '闲时与彩蛋' },
  ]);

  const SLOTS = Object.freeze([
    { id: 'idle', group: 'work', label: '待命', icon: '🌿', description: '本轮已收尾，等待你的下一条指令。', defaultFiles: ['cat-idle.gif'] },
    { id: 'working', group: 'work', label: '干活中', icon: '⌨️', description: '工具执行、编辑文件和持续处理任务时播放。', defaultFiles: ['cat-working.gif', 'cat-working-2.gif', 'cat-working-3.gif', 'cat-working-4.gif', 'cat-working-5.gif'] },
    { id: 'thinking', group: 'work', label: '思考中', icon: '💭', description: '模型正在推理、尚未开始工具操作。', defaultFiles: ['cat-thinking.gif', 'cat-thinking-2.gif'] },
    { id: 'talking', group: 'work', label: '回应中', icon: '💬', description: '任务完成后正在向你回复。', defaultFiles: ['cat-talking.gif'] },
    { id: 'juggling', group: 'work', label: '并行子任务', icon: '🧶', description: '多条任务或子代理同时进行。', defaultFiles: ['cat-juggling.gif', 'cat-juggling-2.gif', 'cat-juggling-3.gif'] },
    { id: 'sweeping', group: 'work', label: '清理上下文', icon: '🧹', description: '压缩上下文或整理会话时播放。', defaultFiles: ['cat-sweeping.gif'] },
    { id: 'loafing', group: 'work', label: '工具间隙', icon: '🐟', description: '上一步完成、下一步尚未到来时短暂摸鱼。', defaultFiles: ['cat-loafing.gif', 'cat-loafing-2.gif', 'cat-loafing-3.gif', 'cat-loafing-4.gif', 'cat-loafing-5.gif'] },
    { id: 'waiting', group: 'feedback', label: '等你授权', icon: '🔔', description: '操作需要你确认；“抱歉”反馈也共享此组表情。', aliases: ['sorry'], defaultFiles: ['cat-waiting.gif'] },
    { id: 'needsinput', group: 'feedback', label: '等你回复', icon: '❓', description: '任务需要补充信息；“疑惑”反馈也共享此组表情。', aliases: ['puzzled'], defaultFiles: ['cat-needsinput.gif'] },
    { id: 'happy', group: 'feedback', label: '完成庆祝', icon: '🎉', description: '任务完成或收到夸奖；“开心、兴奋”反馈共享此组表情。', aliases: ['loved', 'excited'], defaultFiles: ['cat-happy.gif'] },
    { id: 'greet', group: 'feedback', label: '新会话', icon: '👋', description: '新任务开始时的上线招呼。', defaultFiles: ['cat-greet.gif'] },
    { id: 'error', group: 'feedback', label: '出错了', icon: '⚠️', description: '网络、API 或任务执行遇到错误。', defaultFiles: ['cat-error.gif'] },
    { id: 'sad', group: 'feedback', label: '难过', icon: '💧', description: '识别到负面情绪时的短暂反馈。', defaultFiles: ['cat-sad.gif'] },
    { id: 'ambient-awake', group: 'rest', label: '闲时活动', icon: '☕', description: '没有任务时，醒着发呆、摸鱼或溜达的轮换片段。', defaultFiles: ['cat-loafing.gif', 'cat-loafing-2.gif', 'cat-loafing-3.gif', 'cat-loafing-4.gif', 'cat-loafing-5.gif', 'cat-idle.gif', 'cat-thinking-2.gif', 'cat-roam.gif'] },
    { id: 'ambient-sleep', group: 'rest', label: '睡觉休息', icon: '💤', description: '没有任务时进入睡眠阶段播放。', defaultFiles: ['cat-sleeping.gif', 'cat-sleeping-2.gif'] },
    { id: 'xiaban', group: 'rest', label: '下班彩蛋', icon: '🍚', description: '午间和傍晚设定时段内播放。', defaultFiles: ['cat-xiaban.gif'] },
  ].map((slot) => Object.freeze({ ...slot, aliases: Object.freeze(slot.aliases || []), defaultFiles: Object.freeze(slot.defaultFiles.slice()) })));

  const SLOT_IDS = Object.freeze(SLOTS.map((slot) => slot.id));
  const SLOT_BY_ID = Object.freeze(Object.fromEntries(SLOTS.map((slot) => [slot.id, slot])));
  const STATE_TO_SLOT = Object.freeze(SLOTS.reduce((out, slot) => {
    if (!slot.id.startsWith('ambient-') && slot.id !== 'xiaban') out[slot.id] = slot.id;
    for (const alias of slot.aliases) out[alias] = slot.id;
    return out;
  }, { sleeping: 'ambient-sleep' }));

  function slotForState(state) { return STATE_TO_SLOT[state] || 'idle'; }
  function builtinAsset(file) {
    return Object.freeze({
      id: `builtin:${file}`,
      kind: 'builtin',
      name: file,
      url: `../assets/cat/${file}`,
    });
  }
  function defaultSlot(slot) {
    return {
      id: slot.id,
      mode: 'default',
      usingDefaults: true,
      active: slot.defaultFiles.map(builtinAsset),
      custom: [],
    };
  }
  function defaultCatalog() {
    return {
      version: 1,
      slots: Object.fromEntries(SLOTS.map((slot) => [slot.id, defaultSlot(slot)])),
    };
  }
  function safeAsset(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'custom' ? 'custom' : value.kind === 'builtin' ? 'builtin' : null;
    if (!kind || typeof value.id !== 'string' || typeof value.url !== 'string') return null;
    if (kind === 'custom' && !/^workmeow-asset:\/\/asset\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.gif\?v=[^#]+$/i.test(value.url)) return null;
    if (kind === 'builtin' && !/^\.\.\/assets\/cat\/cat-[a-z0-9-]+\.gif$/.test(value.url)) return null;
    return {
      id: value.id,
      kind,
      name: typeof value.name === 'string' && value.name ? value.name : value.id,
      url: value.url,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
      meta: value.meta && typeof value.meta === 'object' ? value.meta : null,
    };
  }
  function normalizeCatalog(value) {
    const fallback = defaultCatalog();
    if (!value || typeof value !== 'object' || !value.slots || typeof value.slots !== 'object') return fallback;
    for (const slot of SLOTS) {
      const source = value.slots[slot.id];
      if (!source || typeof source !== 'object') continue;
      const active = Array.isArray(source.active) ? source.active.map(safeAsset).filter(Boolean) : [];
      const custom = Array.isArray(source.custom) ? source.custom.map(safeAsset).filter((asset) => asset && asset.kind === 'custom') : [];
      if (!active.length) continue;
      fallback.slots[slot.id] = {
        id: slot.id,
        mode: ['append', 'replace'].includes(source.mode) ? source.mode : 'default',
        usingDefaults: source.usingDefaults !== false,
        active,
        custom,
      };
    }
    return fallback;
  }

  return { SLOT_GROUPS, SLOTS, SLOT_IDS, SLOT_BY_ID, STATE_TO_SLOT, slotForState, defaultCatalog, normalizeCatalog };
});
