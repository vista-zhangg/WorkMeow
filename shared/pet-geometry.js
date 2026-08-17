'use strict';

// Pure geometry shared by the renderer and regression tests. Keeping the
// decisions here makes the edge cases (top/left/corners) testable without an
// Electron desktop.
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PetGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function normalizeRect(rect) {
    const x = Number(rect && rect.x) || 0;
    const y = Number(rect && rect.y) || 0;
    const width = Math.max(0, Number(rect && rect.width) || 0);
    const height = Math.max(0, Number(rect && rect.height) || 0);
    return { x, y, width, height, right: x + width, bottom: y + height };
  }

  function chooseRestingLayout({
    workArea,
    windowRect,
    petRect,
    current,
    threshold = 168,
    inferVerticalFrameClamp = true,
    inferHorizontalFrameClamp = true,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const pet = {
      x: wr.x + pr.x,
      y: wr.y + pr.y,
      width: pr.width,
      height: pr.height,
    };
    pet.right = pet.x + pet.width;
    pet.bottom = pet.y + pet.height;

    const prior = current || { vertical: 'above', horizontal: 'center' };
    // "below" is exclusively a top-edge accommodation. Do not keep it as a
    // sticky historical state after the pet has returned to the desktop: all
    // bubbles/status chips belong above the pet everywhere else.
    let vertical = 'above';
    let horizontal = ['left', 'right'].includes(prior.horizontal) ? prior.horizontal : 'center';

    // The second half of each test catches the old failure mode: the transparent
    // window has already been clamped to the work-area edge, while the visible
    // pet is still stranded well inside that window.
    if (pet.y - wa.y <= threshold
      || (inferVerticalFrameClamp && wr.y <= wa.y + 3 && pr.y > 18)) vertical = 'below';

    if (pet.x - wa.x <= threshold
      || (inferHorizontalFrameClamp && wr.x <= wa.x + 3 && pr.x > 18)) horizontal = 'left';
    else if (wa.right - pet.right <= threshold
      || (inferHorizontalFrameClamp && wr.right >= wa.right - 3 && wr.width - pr.right > 18)) horizontal = 'right';
    else if (pet.x - wa.x > threshold * 2 && wa.right - pet.right > threshold * 2) horizontal = 'center';

    return { vertical, horizontal };
  }

  function choosePopupLayout({
    workArea,
    windowRect,
    petRect,
    current,
    popupHeight = 140,
    inferVerticalFrameClamp = true,
    inferHorizontalFrameClamp = true,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const petTop = wr.y + pr.y;
    const above = Math.max(0, petTop - wa.y);
    const need = Math.max(80, Number(popupHeight) || 0);
    const resting = chooseRestingLayout({
      workArea: wa,
      windowRect: wr,
      petRect: pr,
      current,
      inferVerticalFrameClamp,
      inferHorizontalFrameClamp,
    });

    // 单一规则：只有桌宠本体上方放不下完整卡片时才向下翻；除此之外
    // 一律向上。不要把下方剩余空间、历史方向或当前透明窗口高度掺进来。
    const vertical = above < need ? 'below' : 'above';
    return { vertical, horizontal: resting.horizontal };
  }

  function chooseDragVerticalLayout({
    current,
    workArea,
    targetWindowY,
    petScreenY,
    abovePetOffset,
    boundarySlack = 2,
  }) {
    const wa = normalizeRect(workArea);
    const vertical = current === 'below' ? 'below' : 'above';
    const edgeY = wa.y + Math.max(0, Number(boundarySlack) || 0);
    if (vertical === 'above') {
      return Number(targetWindowY) <= edgeY ? 'below' : 'above';
    }
    const normalWindowY = Number(petScreenY) - Math.max(0, Number(abovePetOffset) || 0);
    return normalWindowY >= edgeY ? 'above' : 'below';
  }

  const ARCS = {
    // A real 180-degree fan. The previous 156-degree arcs compressed eight
    // 46px controls until they overlapped into a heart-shaped cluster.
    above: { start: 180, end: 360 },
    below: { start: 0, end: 180 },
    right: { start: -90, end: 90 },
    left: { start: 90, end: 270 },
  };

  function arcPoints(direction, count, center, radius) {
    const arc = ARCS[direction];
    const points = [];
    for (let i = 0; i < count; i++) {
      const ratio = count === 1 ? 0.5 : i / (count - 1);
      const angle = (arc.start + (arc.end - arc.start) * ratio) * Math.PI / 180;
      points.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      });
    }
    return points;
  }

  function radialLayout({ count, center, safeRect, preferred = [], radius = 106, itemRadius = 23, avoidRect = null, gap = 8 }) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return { direction: 'above', radius, points: [] };
    const safe = normalizeRect(safeRect);
    const avoid = normalizeRect(avoidRect);
    const avoidGap = Math.max(0, Number(gap) || 0);
    const directions = [...new Set([...preferred, 'above', 'below', 'right', 'left'])]
      .filter((direction) => ARCS[direction]);
    const radii = [...new Set([radius, 100, 94, 88, 80, 72].map((r) => Math.max(48, Number(r) || 0)))];
    let best = null;

    for (const direction of directions) {
      for (const candidateRadius of radii) {
        const adjustedCenter = { x: center.x, y: center.y };
        // Anchor the fan outside the pet body. The old layout rotated around
        // the cat's centre, so its end buttons could be clamped back onto the
        // cat at a screen corner.
        if (avoid.width > 0 && avoid.height > 0) {
          if (direction === 'above') adjustedCenter.y = Math.min(adjustedCenter.y, avoid.y - itemRadius - avoidGap);
          if (direction === 'below') adjustedCenter.y = Math.max(adjustedCenter.y, avoid.bottom + itemRadius + avoidGap);
          if (direction === 'left') adjustedCenter.x = Math.min(adjustedCenter.x, avoid.x - itemRadius - avoidGap);
          if (direction === 'right') adjustedCenter.x = Math.max(adjustedCenter.x, avoid.right + itemRadius + avoidGap);
        }
        // At a left/right edge a full semicircle needs its two end buttons to
        // fit vertically. Move only the fan's centre line, never the pet or
        // the fan's inward-facing x anchor.
        if (direction === 'left' || direction === 'right') {
          adjustedCenter.y = clamp(
            adjustedCenter.y,
            safe.y + itemRadius + candidateRadius,
            safe.bottom - itemRadius - candidateRadius,
          );
        }
        const raw = arcPoints(direction, n, adjustedCenter, candidateRadius);
        let overflow = 0;
        for (const point of raw) {
          overflow += Math.max(0, safe.x + itemRadius - point.x);
          overflow += Math.max(0, point.x - (safe.right - itemRadius));
          overflow += Math.max(0, safe.y + itemRadius - point.y);
          overflow += Math.max(0, point.y - (safe.bottom - itemRadius));
          if (avoid.width > 0 && avoid.height > 0
            && point.x >= avoid.x - itemRadius - avoidGap
            && point.x <= avoid.right + itemRadius + avoidGap
            && point.y >= avoid.y - itemRadius - avoidGap
            && point.y <= avoid.bottom + itemRadius + avoidGap) {
            overflow += 100000;
          }
        }
        const candidate = { direction, radius: candidateRadius, center: adjustedCenter, raw, overflow };
        if (!best || candidate.overflow < best.overflow) best = candidate;
        if (overflow === 0) {
          return { direction, radius: candidateRadius, center: adjustedCenter, points: raw };
        }
      }
    }

    const points = (best ? best.raw : []).map((point) => ({
      x: clamp(point.x, safe.x + itemRadius, safe.right - itemRadius),
      y: clamp(point.y, safe.y + itemRadius, safe.bottom - itemRadius),
    }));
    return {
      direction: best ? best.direction : directions[0],
      radius: best ? best.radius : radius,
      center: best ? best.center : center,
      points,
    };
  }

  // Compact L-shaped cluster of buttons in one diagonal quadrant around the
  // pet. Picks the quadrant with the most available room so the buttons sit
  // close to the pet without covering it or spilling off-screen.
  function cornerMenuLayout({ center, petRect, safeRect, itemRadius = 26, gap = 8, preferred = [] }) {
    const safe = normalizeRect(safeRect);
    const pet = normalizeRect(petRect);
    const cx = pet.x + pet.width / 2;
    const cy = pet.y + pet.height / 2;
    const halfW = pet.width / 2;
    const halfH = pet.height / 2;
    const offset = itemRadius * 0.85; // shift the two arm buttons toward the corner

    // Distance from each pet edge to the safe-rect boundary — the room
    // available for a button cluster on that side.
    const roomTop = Math.max(0, pet.y - safe.y);
    const roomBottom = Math.max(0, safe.bottom - pet.bottom);
    const roomLeft = Math.max(0, pet.x - safe.x);
    const roomRight = Math.max(0, safe.right - pet.right);

    const quadrants = [
      { dir: 'top-right',    sx:  1, sy: -1, score: roomTop * roomRight },
      { dir: 'top-left',     sx: -1, sy: -1, score: roomTop * roomLeft },
      { dir: 'bottom-right', sx:  1, sy:  1, score: roomBottom * roomRight },
      { dir: 'bottom-left',  sx: -1, sy:  1, score: roomBottom * roomLeft },
    ];

    // Honour an explicit preference (from edge layout) by boosting its score.
    const prefIndex = new Map(preferred.map((d, i) => [d, preferred.length - i]));
    const edgeBoost = (q) => {
      const vertKey = q.sy < 0 ? 'above' : 'below';
      const horzKey = q.sx > 0 ? 'right' : 'left';
      return (prefIndex.get(vertKey) || 0) * 1e6 + (prefIndex.get(horzKey) || 0) * 1e6;
    };
    quadrants.forEach((q) => { q.score += edgeBoost(q); });
    quadrants.sort((a, b) => b.score - a.score);
    const chosen = quadrants[0];

    const outerX = cx + chosen.sx * (halfW + itemRadius + gap);
    const outerY = cy + chosen.sy * (halfH + itemRadius + gap);

    // Three buttons form an L: top-arm, corner, side-arm.
    const raw = [
      { x: cx + chosen.sx * offset, y: outerY },
      { x: outerX, y: outerY },
      { x: outerX, y: cy + chosen.sy * offset },
    ];

    const points = raw.map((p) => ({
      x: clamp(p.x, safe.x + itemRadius, safe.right - itemRadius),
      y: clamp(p.y, safe.y + itemRadius, safe.bottom - itemRadius),
    }));

    return { direction: chosen.dir, points };
  }

  return { chooseRestingLayout, choosePopupLayout, chooseDragVerticalLayout, radialLayout, cornerMenuLayout };
});
