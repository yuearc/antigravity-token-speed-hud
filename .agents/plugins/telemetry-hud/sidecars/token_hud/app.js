(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    currentConvId: '',
    etag: '',
    ctxLimit: 1000000,
    lastData: null,
    view: 'turns', // 'turns' | 'flat'
    expandedTurns: new Set(),
    userToggledTurns: false,
    seenTurnKeys: new Set(),
    seenChainStepKeys: new Set(),
    seenFlatStepKeys: new Set(),
    chartSlots: [],
    hoveredStep: null,
    selectedStep: null,
    barAnimMap: new Map(), // step -> { hRatio, alpha }
    clickRipple: null, // { step, start }
    chartRaf: 0,
  };

  function getLockedConvId() {
    return (params.get('conversationId') || window.sidecar?.conversationId || '').trim();
  }

  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(() => {
    syncTheme();
    if (state.lastData) scheduleChartFrame();
    else drawEmptyChart();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  function fmtTok(n) {
    if (!Number.isFinite(n)) return '--';
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  function fmtInt(n) {
    return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '--';
  }

  function fmtClock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  /* NumberFlow-style interruptible numeric tweening */
  const numTweens = new Map();

  function resetTweens() {
    for (const entry of numTweens.values()) {
      if (entry.raf) cancelAnimationFrame(entry.raf);
    }
    numTweens.clear();
  }

  function tweenNumber(el, target, fmt) {
    if (!el) return;
    if (!Number.isFinite(target)) {
      const prev = numTweens.get(el);
      if (prev && prev.raf) cancelAnimationFrame(prev.raf);
      numTweens.delete(el);
      el.textContent = '--';
      return;
    }
    const prev = numTweens.get(el);
    if (prev && prev.raf) cancelAnimationFrame(prev.raf);
    const from = prev ? prev.current : target;
    if (reducedMotion() || prev == null || Math.abs(target - from) < 1e-4) {
      numTweens.set(el, { current: target, raf: 0 });
      el.textContent = fmt(target);
      return;
    }
    const start = performance.now();
    const dur = 320;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = from + (target - from) * eased;
      const done = t >= 1;
      numTweens.set(el, { current: done ? target : cur, raf: done ? 0 : requestAnimationFrame(tick) });
      el.textContent = fmt(done ? target : cur);
    };
    numTweens.set(el, { current: from, raf: requestAnimationFrame(tick) });
  }

  function applyEnterAnimation(el, staggerIdx) {
    if (!el || reducedMotion()) return;
    el.style.setProperty('--stagger-i', String(Math.min(staggerIdx, 5)));
    el.classList.add('is-entering');
    el.addEventListener(
      'animationend',
      () => {
        el.classList.remove('is-entering');
        el.style.removeProperty('--stagger-i');
      },
      { once: true }
    );
  }

  /* Canvas Trend Chart with on-demand rAF animator */
  function drawEmptyChart() {
    const canvas = $('trend-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 480;
    const cssH = 114;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    state.chartSlots = [];

    const cs = getComputedStyle(document.documentElement);
    const colBorder = cs.getPropertyValue('--hud-border').trim() || 'rgba(128,128,128,0.2)';
    const colMuted = cs.getPropertyValue('--hud-muted').trim() || '#666';
    const monoFont = cs.getPropertyValue('--hud-mono').trim() || 'monospace';

    ctx.strokeStyle = colBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(20, cssH / 2);
    ctx.lineTo(cssW - 20, cssH / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = colMuted;
    ctx.font = `11px ${monoFont}`;
    ctx.textAlign = 'center';
    ctx.fillText('暂无步级速率数据', cssW / 2, cssH / 2 - 8);
  }

  function syncChartTargets(steps) {
    const activeIds = new Set();
    const isReduced = reducedMotion();
    for (const s of steps) {
      activeIds.add(s.step);
      if (!state.barAnimMap.has(s.step)) {
        state.barAnimMap.set(s.step, {
          hRatio: isReduced ? 1 : 0,
          alpha: s.is_wait ? 0.35 : 0.78,
        });
      }
    }
    for (const key of state.barAnimMap.keys()) {
      if (!activeIds.has(key)) state.barAnimMap.delete(key);
    }
    scheduleChartFrame();
  }

  function scheduleChartFrame() {
    if (state.chartRaf) return;
    state.chartRaf = requestAnimationFrame(renderChartFrame);
  }

  function fillRoundedBar(ctx, x, y, w, h, r) {
    if (h <= 0 || w <= 0) return;
    const radius = Math.min(r, w / 2, h);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [radius, radius, 0, 0]);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  function renderChartFrame(now) {
    state.chartRaf = 0;
    const steps = state.lastData?.steps || [];
    if (!steps.length) {
      drawEmptyChart();
      return;
    }

    const canvas = $('trend-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 480;
    const cssH = 114;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    state.chartSlots = [];

    const cs = getComputedStyle(document.documentElement);
    const colPrimary = cs.getPropertyValue('--hud-primary').trim() || '#007acc';
    const colSuccess = cs.getPropertyValue('--hud-success').trim() || '#2e8540';
    const colMuted = cs.getPropertyValue('--hud-muted').trim() || '#666';
    const colBorder = cs.getPropertyValue('--hud-border').trim() || 'rgba(128,128,128,0.2)';
    const colCard = cs.getPropertyValue('--hud-card').trim() || '#ffffff';
    const monoFont = cs.getPropertyValue('--hud-mono').trim() || 'monospace';

    const padL = 32;
    const padR = 34;
    const padT = 12;
    const padB = 16;
    const w = Math.max(10, cssW - padL - padR);
    const h = cssH - padT - padB;
    const maxTps = Math.max(10, ...steps.map((s) => s.tps || 0)) * 1.1;

    /* Faint dashed horizontal gridlines */
    ctx.save();
    ctx.strokeStyle = colBorder;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 3]);
    for (let g = 0; g <= 2; g++) {
      const y = Math.round(padT + (h * g) / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = colMuted;
    ctx.font = `10px ${monoFont}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(maxTps)), padL - 5, padT + 8);
    ctx.fillText('0', padL - 5, padT + h);
    ctx.textAlign = 'left';
    ctx.fillText('100%', padL + w + 5, padT + 8);
    ctx.fillText('0%', padL + w + 5, padT + h);

    const slot = w / steps.length;
    const barW = Math.max(4, Math.min(28, slot * 0.58));
    const hasFocus = state.hoveredStep != null || state.selectedStep != null;
    const isReduced = reducedMotion();
    let needsMoreFrames = false;

    steps.forEach((s, i) => {
      const slotX = padL + i * slot;
      const centerX = slotX + slot / 2;
      const isHovered = state.hoveredStep === s.step;
      const isSelected = state.selectedStep === s.step;

      state.chartSlots.push({
        x0: slotX,
        x1: slotX + slot,
        y0: padT,
        y1: padT + h,
        centerX,
        step: s,
      });

      const anim = state.barAnimMap.get(s.step) || { hRatio: 1, alpha: 0.78 };
      const targetAlpha =
        isHovered || isSelected
          ? 1
          : hasFocus
            ? s.is_wait
              ? 0.25
              : 0.45
            : s.is_wait
              ? 0.35
              : 0.78;

      if (isReduced) {
        anim.hRatio = 1;
        anim.alpha = targetAlpha;
      } else {
        if (Math.abs(1 - anim.hRatio) > 0.005) {
          anim.hRatio += (1 - anim.hRatio) * 0.22;
          needsMoreFrames = true;
        } else {
          anim.hRatio = 1;
        }
        if (Math.abs(targetAlpha - anim.alpha) > 0.01) {
          anim.alpha += (targetAlpha - anim.alpha) * 0.25;
          needsMoreFrames = true;
        } else {
          anim.alpha = targetAlpha;
        }
      }
      state.barAnimMap.set(s.step, anim);

      if (isHovered || isSelected) {
        ctx.save();
        ctx.fillStyle = colPrimary;
        ctx.globalAlpha = isSelected ? 0.09 : 0.05;
        ctx.fillRect(slotX, padT, slot, h);

        /* Subtle vertical crosshair hairline */
        ctx.strokeStyle = colPrimary;
        ctx.lineWidth = 1;
        ctx.globalAlpha = isSelected ? 0.32 : 0.2;
        const hx = Math.round(centerX) + 0.5;
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + h);
        ctx.stroke();
        ctx.restore();
      }

      const fullBh = s.tps != null ? Math.max(3, ((s.tps || 0) / maxTps) * h) : 2;
      const bh = Math.max(1.5, fullBh * anim.hRatio);
      const x = slotX + (slot - barW) / 2;
      const y = padT + h - bh;

      ctx.save();
      ctx.fillStyle = colPrimary;
      ctx.globalAlpha = anim.alpha;
      fillRoundedBar(ctx, x, y, barW, bh, 2.5);
      ctx.restore();

      if (isSelected) {
        ctx.save();
        ctx.fillStyle = colPrimary;
        ctx.beginPath();
        ctx.arc(centerX, Math.max(padT + 2.5, y - 4), 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    });

    /* Subtle cache area fill under polyline */
    if (steps.length > 1) {
      ctx.save();
      ctx.fillStyle = colSuccess;
      ctx.globalAlpha = 0.06;
      ctx.beginPath();
      steps.forEach((s, i) => {
        const x = padL + i * slot + slot / 2;
        const y = padT + h - ((s.cache_pct || 0) / 100) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(padL + (steps.length - 1) * slot + slot / 2, padT + h);
      ctx.lineTo(padL + slot / 2, padT + h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* Cache trend polyline */
    ctx.save();
    ctx.strokeStyle = colSuccess;
    ctx.lineWidth = 1.65;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    steps.forEach((s, i) => {
      const x = padL + i * slot + slot / 2;
      const y = padT + h - ((s.cache_pct || 0) / 100) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    /* Highlighted point on cache line for hovered/selected step */
    steps.forEach((s, i) => {
      if (state.hoveredStep !== s.step && state.selectedStep !== s.step) return;
      const x = padL + i * slot + slot / 2;
      const y = padT + h - ((s.cache_pct || 0) / 100) * h;
      ctx.save();
      ctx.fillStyle = colSuccess;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colCard;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    });

    /* Click ripple ring */
    if (state.clickRipple && !isReduced) {
      const p = (now - state.clickRipple.start) / 360;
      if (p < 1) {
        const idx = steps.findIndex((s) => s.step === state.clickRipple.step);
        if (idx >= 0) {
          const s = steps[idx];
          const cx = padL + idx * slot + slot / 2;
          const bh = s.tps != null ? Math.max(3, ((s.tps || 0) / maxTps) * h) : 2;
          const cy = padT + h - bh / 2;
          const ease = 1 - Math.pow(1 - p, 3);
          ctx.save();
          ctx.strokeStyle = colPrimary;
          ctx.lineWidth = 1.4;
          ctx.globalAlpha = 0.55 * (1 - p);
          ctx.beginPath();
          ctx.arc(cx, cy, 2 + ease * 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        needsMoreFrames = true;
      } else {
        state.clickRipple = null;
      }
    } else {
      state.clickRipple = null;
    }

    if (needsMoreFrames) {
      state.chartRaf = requestAnimationFrame(renderChartFrame);
    }
  }

  function showTooltip(slotInfo, clientX, clientY) {
    const tip = $('chart-tooltip');
    const wrap = tip.parentElement;
    const rect = wrap.getBoundingClientRect();
    const s = slotInfo.step;
    const tLabel = s.turnIndex != null ? `T${s.turnIndex} · 链第 ${s.chainIndex || 1} 步` : 'Step';
    const tpsStr = s.tps != null ? `${s.tps.toFixed(1)} tok/s` : '终态/无独立耗时';
    tip.innerHTML = `
      <div class="tt-head">
        <span class="primary mono">${esc(tLabel)} (#${s.step})</span>
        <span class="mono">${esc(tpsStr)}</span>
      </div>
      ${s.userPreview ? `<div class="tt-user">${esc(s.userPreview)}</div>` : ''}
      <div class="tt-meta mono">Out ${fmtInt(s.out_tok)} · Cache ${s.cache_pct}% · ${esc(s.tools || '')}</div>
      <div class="tt-meta primary">点击定位到对应对话步骤 ↘</div>
    `;
    tip.classList.add('is-visible');

    const tipW = tip.offsetWidth || 220;
    const tipH = tip.offsetHeight || 72;
    let left = clientX - rect.left + 12;
    if (left + tipW > rect.width - 8) left = Math.max(8, clientX - rect.left - tipW - 12);
    let top = clientY - rect.top - tipH - 10;
    if (top < 4) top = clientY - rect.top + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTooltip() {
    $('chart-tooltip').classList.remove('is-visible');
  }

  function jumpToStep(stepObj) {
    if (!stepObj) return;
    state.selectedStep = stepObj.step;

    const turns = state.lastData?.turns || [];
    if (turns.length && stepObj.turnIndex != null) {
      setView('turns');
      state.userToggledTurns = true;
      state.expandedTurns.add(stepObj.turnIndex);

      const turnEl = document.querySelector(`[data-turn-key="${CSS.escape(String(stepObj.turnIndex))}"]`);
      if (turnEl) {
        turnEl.classList.add('is-open');
        const toggleBtn = turnEl.querySelector('[data-turn-toggle]');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
      } else {
        renderTurns(turns);
      }

      document.querySelectorAll('.chain-step.selected').forEach((node) => {
        if (node.dataset.stepId !== String(stepObj.step)) node.classList.remove('selected');
      });

      scheduleChartFrame();
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-step-id="${CSS.escape(String(stepObj.step))}"]`);
        if (el) {
          el.classList.add('selected');
          el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
          el.classList.remove('jump-highlight');
          void el.offsetWidth;
          el.classList.add('jump-highlight');
        }
      });
      return;
    }

    setView('flat');
    renderFlatSteps(state.lastData?.steps || []);
    scheduleChartFrame();
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-flat-step="${CSS.escape(String(stepObj.step))}"]`);
      if (row) {
        row.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
        row.classList.remove('jump-highlight');
        void row.offsetWidth;
        row.classList.add('jump-highlight');
      }
    });
  }

  function toolCategory(name) {
    const n = String(name || '').toLowerCase();
    if (/write|edit|replace|delete/.test(n)) return 'write';
    if (/run_command|exec|shell|task/.test(n)) return 'exec';
    if (/web|url|browser/.test(n)) return 'web';
    return 'read';
  }

  function buildChainStepInnerHtml(s) {
    const isErr = s.tool_status === 'ERROR';
    const cls = isErr ? 'error' : s.is_final_reply ? 'final' : s.is_wait ? 'wait' : '';
    const kindLabel = isErr ? '执行异常' : s.is_final_reply ? '最终回复' : s.is_wait ? '等待确认' : '链式工具步';
    const durText = s.dur_sec != null ? `${s.dur_sec.toFixed(1)}s` : '--';
    const tpsCls = s.tps == null ? 'is-empty' : s.tps >= 100 ? 'fast' : '';
    const tpsText = s.tps != null ? `${s.tps.toFixed(1)} tok/s` : '--';
    const toolsHtml = s.tool_details?.length
      ? `<div class="tool-chips">${s.tool_details
          .map(
            (td, idx) => `
            <div class="tool-row">
              <span class="tool-name mono" data-cat="${toolCategory(td.name)}">${esc(td.name)}</span>
              <span class="tool-target" title="${esc(td.target)}">${esc(td.target)}</span>
              ${
                idx === s.tool_details.length - 1 && s.tool_status
                  ? `<span class="tool-status mono ${s.tool_status === 'ERROR' ? 'err' : 'ok'}">${esc(s.tool_status)}</span>`
                  : ''
              }
            </div>`
          )
          .join('')}</div>`
      : s.reply_summary
        ? `<div class="step-thinking is-reply"><span class="step-thinking-label">回复摘要</span>${esc(s.reply_summary)}</div>`
        : '';

    return `
      <div class="step-head">
        <div class="step-id">
          <span class="step-order">第 ${s.chainIndex} 步</span>
          <span class="step-num mono">#${s.step}</span>
          <span class="kind-pill ${cls}">${kindLabel}</span>
        </div>
        <span class="step-time mono">${fmtClock(s.created_at)}</span>
      </div>
      ${s.thinking_summary ? `<div class="step-thinking"><span class="step-thinking-label">思考</span>${esc(s.thinking_summary)}</div>` : ''}
      ${toolsHtml}
      <div class="step-metrics mono">
        <div class="step-metrics-group">
          <span class="muted">In ${fmtInt(s.in_tok)}</span>
          <span class="cache-pill">Cache ${fmtInt(s.cache_tok)} <span class="cache-pct-tag">${s.cache_pct}%</span></span>
          <span>Out <strong>${fmtInt(s.out_tok)}</strong></span>
        </div>
        <div class="step-metrics-group">
          <span class="muted">${durText}</span>
          <span class="tps-pill ${tpsCls}">${s.tps != null ? `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1.5L3.5 9h4.2l-1.2 5.5 6-7.5H8.3l1.2-5.5z"/></svg>` : ''}${tpsText}</span>
        </div>
      </div>
    `;
  }

  function stepSignature(s) {
    return JSON.stringify([
      s.step,
      s.chainIndex,
      s.in_tok,
      s.cache_tok,
      s.out_tok,
      s.cache_pct,
      s.dur_sec,
      s.tps,
      s.tool_status,
      s.is_wait,
      s.is_final_reply,
      s.thinking_summary,
      s.reply_summary,
      s.tool_details,
    ]);
  }

  function turnHeaderSignature(turn) {
    return `${turn.turnIndex}|${turn.stepCount}|${turn.totalIn}|${turn.totalCache}|${turn.totalOut}|${turn.cachePct}|${turn.avgTps}|${turn.userPreview}`;
  }

  function createTurnElement(turn, isOpen) {
    const item = document.createElement('div');
    item.className = `turn-item${isOpen ? ' is-open' : ''}`;
    item.dataset.turnKey = String(turn.turnIndex);
    const speedText = turn.avgTps != null ? `${turn.avgTps.toFixed(1)} tok/s` : '--';

    item.innerHTML = `
      <button type="button" class="turn-header" data-turn-toggle="${turn.turnIndex}" aria-expanded="${isOpen}">
        <div class="turn-top">
          <div class="turn-title">
            <span class="turn-badge">T${turn.turnIndex}</span>
            <span class="turn-utterance" title="${esc(turn.userText)}">${esc(turn.userPreview)}</span>
          </div>
          <span class="turn-chevron">
            <svg class="turn-chevron-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 4l4 4-4 4"/>
            </svg>
            <span class="turn-step-count"><span class="mono">${turn.stepCount}</span> 步</span>
          </span>
        </div>
        <div class="turn-meta mono">
          <span class="tm-clock">${fmtClock(turn.created_at)}</span>
          <span class="tm-in">In ${fmtTok(turn.totalIn)}</span>
          <span class="tm-cache success">Cache ${fmtTok(turn.totalCache)} (${turn.cachePct}%)</span>
          <span class="tm-out">Out <strong>${fmtTok(turn.totalOut)}</strong></span>
          <span class="tm-speed primary">${speedText}</span>
        </div>
      </button>
      <div class="turn-body">
        <div class="turn-body-inner">
          <div class="turn-body-content">
            <div class="user-quote"><span class="user-quote-tag">提问</span><span class="user-quote-text">${esc(turn.userText)}</span></div>
            <div class="chain-list"></div>
          </div>
        </div>
      </div>
    `;
    item._headerSig = turnHeaderSignature(turn);
    return item;
  }

  function updateTurnHeaderInPlace(item, turn, isOpen) {
    item.classList.toggle('is-open', isOpen);
    const btn = item.querySelector('[data-turn-toggle]');
    if (btn) btn.setAttribute('aria-expanded', String(isOpen));

    const sig = turnHeaderSignature(turn);
    if (item._headerSig === sig) return;
    item._headerSig = sig;

    const utt = item.querySelector('.turn-utterance');
    if (utt) {
      utt.textContent = turn.userPreview;
      utt.title = turn.userText;
    }
    const cnt = item.querySelector('.turn-step-count');
    if (cnt) cnt.innerHTML = `<span class="mono">${turn.stepCount}</span> 步`;
    const tmClock = item.querySelector('.tm-clock');
    if (tmClock) tmClock.textContent = fmtClock(turn.created_at);
    const tmIn = item.querySelector('.tm-in');
    if (tmIn) tmIn.textContent = `In ${fmtTok(turn.totalIn)}`;
    const tmCache = item.querySelector('.tm-cache');
    if (tmCache) tmCache.textContent = `Cache ${fmtTok(turn.totalCache)} (${turn.cachePct}%)`;
    const tmOut = item.querySelector('.tm-out');
    if (tmOut) tmOut.innerHTML = `Out <strong>${fmtTok(turn.totalOut)}</strong>`;
    const tmSpeed = item.querySelector('.tm-speed');
    if (tmSpeed) tmSpeed.textContent = turn.avgTps != null ? `${turn.avgTps.toFixed(1)} tok/s` : '--';

    const quote = item.querySelector('.user-quote-text');
    if (quote && quote.textContent !== turn.userText) quote.textContent = turn.userText;
  }

  function getEmptyChainNotice(isLatestTurn, turnState, isActive) {
    if (!isLatestTurn) {
      return { cls: 'is-cancelled', text: '已取消 / 未产生模型响应' };
    }
    if (turnState === 'cancelled') {
      return { cls: 'is-cancelled', text: '已取消本次回答' };
    }
    if (turnState === 'error') {
      return { cls: 'is-error', text: '执行异常终止' };
    }
    if (turnState === 'stale' || !isActive) {
      return { cls: 'is-cancelled', text: '已停止生成或已取消' };
    }
    return { cls: '', text: '等待模型响应…' };
  }

  function reconcileChainSteps(chainList, steps, turnCtx = {}) {
    const { isLatestTurn = false, turnState = 'idle', isActive = false } = turnCtx;

    if (!steps.length) {
      const notice = getEmptyChainNotice(isLatestTurn, turnState, isActive);
      chainList.classList.add('is-empty');
      chainList.innerHTML = `<div class="empty-chain ${notice.cls}">${esc(notice.text)}</div>`;
      return;
    }

    chainList.classList.remove('is-empty');
    const existingPlaceholder = chainList.querySelector('.empty-chain:not(.chain-tail)');
    if (existingPlaceholder) existingPlaceholder.remove();

    const existing = new Map();
    for (const child of chainList.children) {
      if (child.dataset && child.dataset.stepId != null) {
        existing.set(Number(child.dataset.stepId), child);
      }
    }

    const activeStepIds = new Set();
    let newIdx = 0;

    steps.forEach((s, idx) => {
      activeStepIds.add(s.step);
      let el = existing.get(s.step);
      const isErr = s.tool_status === 'ERROR';
      const cls = isErr ? 'has-error' : s.is_final_reply ? 'final' : s.is_wait ? 'wait' : '';
      const selectedCls = state.selectedStep === s.step ? 'selected' : '';
      const sig = stepSignature(s);

      if (!el) {
        el = document.createElement('div');
        el.dataset.stepId = String(s.step);
        el.className = `chain-step ${cls} ${selectedCls}`.trim();
        el.innerHTML = buildChainStepInnerHtml(s);
        el._sig = sig;
        if (!state.seenChainStepKeys.has(s.step)) {
          state.seenChainStepKeys.add(s.step);
          applyEnterAnimation(el, newIdx++);
        }
      } else {
        el.classList.toggle('has-error', isErr);
        el.classList.toggle('final', Boolean(!isErr && s.is_final_reply));
        el.classList.toggle('wait', Boolean(!isErr && s.is_wait && !s.is_final_reply));
        el.classList.toggle('selected', state.selectedStep === s.step);
        if (el._sig !== sig) {
          el.innerHTML = buildChainStepInnerHtml(s);
          el._sig = sig;
        }
      }

      const expectedAt = chainList.children[idx] || null;
      if (el !== expectedAt) {
        chainList.insertBefore(el, expectedAt);
      }
    });

    for (const [stepId, el] of existing.entries()) {
      if (!activeStepIds.has(stepId)) el.remove();
    }

    const lastStep = steps[steps.length - 1];
    const showTailStop =
      isLatestTurn &&
      lastStep &&
      !lastStep.is_final_reply &&
      (turnState === 'cancelled' || turnState === 'error' || turnState === 'stale');

    let tailEl = chainList.querySelector('.chain-tail');
    if (showTailStop) {
      const tailCls = turnState === 'error' ? 'is-error' : 'is-cancelled';
      const tailText =
        turnState === 'error'
          ? '执行异常中断（未生成最终回复）'
          : turnState === 'stale'
          ? '响应长时间未更新或已取消'
          : '已取消后续生成';
      if (!tailEl) {
        tailEl = document.createElement('div');
        chainList.appendChild(tailEl);
      }
      tailEl.className = `empty-chain chain-tail ${tailCls}`;
      tailEl.textContent = tailText;
    } else if (tailEl) {
      tailEl.remove();
    }
  }

  function renderTurns(turns, liveCtx = {}) {
    const container = $('turns-container');
    if (!turns.length) {
      renderEmptyTurnsNotice('暂无对话记录', '等待当前会话产生首个模型响应。');
      return;
    }

    const emptyEl = container.querySelector('.empty-state');
    if (emptyEl) emptyEl.remove();

    const latestTurn = turns[turns.length - 1];
    if (!state.userToggledTurns && latestTurn) {
      state.expandedTurns.clear();
      state.expandedTurns.add(latestTurn.turnIndex);
    }

    const existing = new Map();
    for (const child of container.children) {
      if (child.dataset && child.dataset.turnKey != null) {
        existing.set(Number(child.dataset.turnKey), child);
      }
    }

    const ordered = [...turns].reverse();
    const activeTurnKeys = new Set();
    let newIdx = 0;

    ordered.forEach((turn, idx) => {
      activeTurnKeys.add(turn.turnIndex);
      const isOpen = state.expandedTurns.has(turn.turnIndex);
      let item = existing.get(turn.turnIndex);

      if (!item) {
        item = createTurnElement(turn, isOpen);
        if (!state.seenTurnKeys.has(turn.turnIndex)) {
          state.seenTurnKeys.add(turn.turnIndex);
          applyEnterAnimation(item, newIdx++);
        }
      } else {
        updateTurnHeaderInPlace(item, turn, isOpen);
      }

      const chainList = item.querySelector('.chain-list');
      if (chainList) {
        reconcileChainSteps(chainList, turn.steps || [], {
          isLatestTurn: Boolean(latestTurn && turn.turnIndex === latestTurn.turnIndex),
          turnState: liveCtx.turnState || 'idle',
          isActive: Boolean(liveCtx.active),
        });
      }

      const expectedAt = container.children[idx] || null;
      if (item !== expectedAt) {
        container.insertBefore(item, expectedAt);
      }
    });

    for (const [key, item] of existing.entries()) {
      if (!activeTurnKeys.has(key)) item.remove();
    }
  }

  function renderFlatSteps(steps) {
    const tbody = $('steps-body');
    if (!steps.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">暂无步级记录</td></tr>';
      return;
    }

    const placeholder = tbody.querySelector('.empty-cell');
    if (placeholder) placeholder.closest('tr')?.remove();

    const existing = new Map();
    for (const row of tbody.children) {
      if (row.dataset && row.dataset.flatStep != null) {
        existing.set(Number(row.dataset.flatStep), row);
      }
    }

    const ordered = [...steps].reverse();
    const activeKeys = new Set();
    let newIdx = 0;

    ordered.forEach((row, idx) => {
      activeKeys.add(row.step);
      const tpsStr = row.tps != null ? `${row.tps.toFixed(1)}${row.is_wait ? '*' : ''}` : '--';
      const durStr = row.dur_sec != null ? `${row.dur_sec.toFixed(1)}s` : '--';
      const desc = row.thinking_summary ? `${row.tools} · ${row.thinking_summary}` : row.tools;
      const turnTag = row.turnIndex != null ? `<span class="primary">T${row.turnIndex}</span> ` : '';
      const isLatest = state.selectedStep === row.step || (state.selectedStep == null && idx === 0);
      const sig = `${row.step}|${row.in_tok}|${row.cache_tok}|${row.out_tok}|${row.cache_pct}|${durStr}|${tpsStr}|${desc}|${row.userPreview}`;

      let tr = existing.get(row.step);
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.flatStep = String(row.step);
        tr.innerHTML = `
          <td class="tool-cell" title="${esc(row.userPreview || '')}">${turnTag}${esc(row.userPreview || '--')}</td>
          <td class="muted">#${row.step}</td>
          <td class="tool-cell" title="${esc(desc)}">${esc(desc)}</td>
          <td class="num muted">${fmtInt(row.in_tok)}</td>
          <td class="num success">${fmtInt(row.cache_tok)} (${row.cache_pct}%)</td>
          <td class="num">${fmtInt(row.out_tok)}</td>
          <td class="num muted">${durStr}</td>
          <td class="num primary">${tpsStr}</td>
        `;
        tr._sig = sig;
        if (!state.seenFlatStepKeys.has(row.step)) {
          state.seenFlatStepKeys.add(row.step);
          applyEnterAnimation(tr, newIdx++);
        }
      } else if (tr._sig !== sig) {
        tr.innerHTML = `
          <td class="tool-cell" title="${esc(row.userPreview || '')}">${turnTag}${esc(row.userPreview || '--')}</td>
          <td class="muted">#${row.step}</td>
          <td class="tool-cell" title="${esc(desc)}">${esc(desc)}</td>
          <td class="num muted">${fmtInt(row.in_tok)}</td>
          <td class="num success">${fmtInt(row.cache_tok)} (${row.cache_pct}%)</td>
          <td class="num">${fmtInt(row.out_tok)}</td>
          <td class="num muted">${durStr}</td>
          <td class="num primary">${tpsStr}</td>
        `;
        tr._sig = sig;
      }

      tr.classList.toggle('latest', isLatest);

      const expectedAt = tbody.children[idx] || null;
      if (tr !== expectedAt) {
        tbody.insertBefore(tr, expectedAt);
      }
    });

    for (const [stepId, tr] of existing.entries()) {
      if (!activeKeys.has(stepId)) tr.remove();
    }
  }

  function renderEmptyTurnsNotice(title, desc) {
    const container = $('turns-container');
    const existing = container.querySelector('.empty-state');
    if (existing && existing.dataset.title === title && existing.dataset.desc === desc) return;
    container.innerHTML = `
      <div class="empty-state" data-title="${esc(title)}" data-desc="${esc(desc)}">
        <svg class="empty-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 7.5v5l3 1.5"/>
        </svg>
        <div class="empty-title">${esc(title)}</div>
        <div class="empty-desc">${esc(desc)}</div>
      </div>
    `;
  }

  function updateContextCard(summary) {
    const s = summary || {};
    const ctxPct = Math.min(100, ((s.ctxUsed || 0) / state.ctxLimit) * 100);
    const ctxBar = $('kpi-ctx-bar');
    const compactBtn = $('compact-btn');
    const compactLabel = $('compact-label');

    tweenNumber($('kpi-ctx-pct'), ctxPct, (v) => `${v.toFixed(1)}%`);
    ctxBar.style.width = `${ctxPct.toFixed(1)}%`;
    ctxBar.classList.toggle('high', ctxPct >= 85);
    ctxBar.classList.toggle('warning', ctxPct >= 65 && ctxPct < 85);
    ctxBar.classList.toggle('normal', ctxPct < 65);
    $('kpi-ctx-sub').textContent = `${fmtTok(s.ctxUsed)} / ${fmtTok(state.ctxLimit)}`;

    if (!compactBtn.disabled && !compactBtn.classList.contains('done')) {
      const urgent = ctxPct >= 65;
      compactBtn.classList.toggle('urgent', urgent);
      compactLabel.textContent = ctxPct >= 75 ? '建议压缩' : '压缩上下文';
    }
  }

  function renderEmptyState(reason, convId) {
    resetTweens();
    state.lastData = null;
    state.etag = '';
    state.currentConvId = convId || '';
    state.seenTurnKeys.clear();
    state.seenChainStepKeys.clear();
    state.seenFlatStepKeys.clear();
    state.barAnimMap.clear();
    state.hoveredStep = null;
    state.selectedStep = null;

    $('live-dot').classList.remove('active');
    const badge = $('live-badge');
    badge.classList.remove('active', 'error', 'cancelled', 'wait');
    badge.textContent = 'WAITING';

    const convTag = $('conv-id-tag');
    if (convId) {
      convTag.textContent = `#${convId.slice(0, 8)}`;
      convTag.classList.remove('hidden');
    } else {
      convTag.classList.add('hidden');
      convTag.textContent = '';
    }

    $('hud-state').classList.remove('active', 'error', 'cancelled', 'wait');
    $('hud-state').textContent = '○ IDLE';

    const msgMap = {
      no_conversation: [
        '未绑定当前对话',
        '当前面板已锁定单会话模式，请在 Antigravity 对话侧边栏中打开或发送首条消息。',
      ],
      no_transcript: [
        `等待会话 ${convId ? convId.slice(0, 8) : ''} 初始化`,
        '已锁定当前会话，发送消息并触发首个 PLANNER_RESPONSE 后将自动展示实时遥测。',
      ],
      unreadable: [
        '暂时无法读取会话轨迹',
        '本地 transcript.jsonl 正在写入或暂不可读，将在下一次轮询时自动恢复。',
      ],
    };
    const [title, desc] = msgMap[reason] || msgMap.no_conversation;
    $('conv-snippet').textContent = convId ? `${convId.slice(0, 8)} · ${title}` : title;

    $('kpi-speed').textContent = '--';
    $('kpi-speed-sub').textContent = 'avg -- · peak --';
    $('kpi-cache-pct').textContent = '--%';
    $('kpi-cache-bar').style.width = '0%';
    $('kpi-cache-sub').textContent = '-- / --';
    $('kpi-steps').textContent = '0 turns · 0 steps';
    $('kpi-out').textContent = '--';
    $('kpi-in').textContent = 'in -- · cache --';
    $('kpi-ctx-pct').textContent = '--%';
    const ctxBar = $('kpi-ctx-bar');
    ctxBar.style.width = '0%';
    ctxBar.classList.remove('high', 'warning');
    ctxBar.classList.add('normal');
    $('kpi-ctx-sub').textContent = `-- / ${fmtTok(state.ctxLimit)}`;
    $('compact-btn').classList.remove('urgent');
    if (!$('compact-btn').disabled && !$('compact-btn').classList.contains('done')) {
      $('compact-label').textContent = '压缩上下文';
    }

    $('chart-meta').textContent = '0 个 Planner Step';
    $('hud-in').textContent = '--';
    $('hud-cache').textContent = '--';
    $('hud-out').textContent = '--';
    $('hud-speed-val').textContent = '-- tok/s';
    $('hud-saved').textContent = '--%';

    drawEmptyChart();
    renderEmptyTurnsNotice(title, desc);
    $('steps-body').innerHTML = `<tr><td colspan="8" class="empty-cell">${esc(title)}</td></tr>`;
  }

  function renderMetrics(data) {
    if (data.conversationId && state.currentConvId !== data.conversationId) {
      resetTweens();
      state.currentConvId = data.conversationId;
      state.seenTurnKeys.clear();
      state.seenChainStepKeys.clear();
      state.seenFlatStepKeys.clear();
      state.barAnimMap.clear();
      state.expandedTurns.clear();
      state.userToggledTurns = false;
      state.selectedStep = null;
      state.hoveredStep = null;
    }

    state.lastData = data;
    const s = data.summary || {};
    const steps = data.steps || [];
    const turns = data.turns || [];

    const isActive = Boolean(data.active);
    const turnState = data.turnState || (isActive ? 'streaming' : 'idle');
    $('live-dot').classList.toggle('active', isActive);
    const badge = $('live-badge');
    badge.classList.toggle('active', turnState === 'streaming');
    badge.classList.toggle('cancelled', turnState === 'cancelled');
    badge.classList.toggle('wait', turnState === 'waiting_user');
    badge.classList.toggle('error', turnState === 'error');
    badge.textContent =
      turnState === 'streaming'
        ? 'STREAMING'
        : turnState === 'cancelled'
        ? 'CANCELLED'
        : turnState === 'error'
        ? 'ERROR'
        : turnState === 'waiting_user'
        ? 'WAIT INPUT'
        : 'IDLE';

    const convTag = $('conv-id-tag');
    if (data.conversationId) {
      convTag.textContent = `#${data.conversationId.slice(0, 8)}`;
      convTag.classList.remove('hidden');
    }

    const hudState = $('hud-state');
    hudState.classList.toggle('active', turnState === 'streaming');
    hudState.classList.toggle('cancelled', turnState === 'cancelled');
    hudState.classList.toggle('wait', turnState === 'waiting_user');
    hudState.classList.toggle('error', turnState === 'error');
    hudState.textContent =
      turnState === 'streaming'
        ? '● LIVE'
        : turnState === 'cancelled'
        ? '○ CANCELLED'
        : turnState === 'error'
        ? '! ERROR'
        : turnState === 'waiting_user'
        ? '◌ WAIT'
        : '○ IDLE';
    $('conv-snippet').textContent = data.snippet
      ? `${data.conversationId.slice(0, 8)} · ${data.snippet}`
      : `会话 ${data.conversationId || '--'}`;

    tweenNumber($('kpi-speed'), s.latestTps != null ? s.latestTps : NaN, (v) => v.toFixed(1));
    $('kpi-speed-sub').textContent = `avg ${(s.avgTps || 0).toFixed(1)} · peak ${(s.peakTps || 0).toFixed(1)}`;

    const cachePct = s.overallCachePct || 0;
    tweenNumber($('kpi-cache-pct'), cachePct, (v) => `${v.toFixed(1)}%`);
    $('kpi-cache-bar').style.width = `${cachePct.toFixed(1)}%`;
    $('kpi-cache-sub').textContent = `${fmtTok(s.totalCache)} / ${fmtTok(s.promptSum)} tok`;

    $('kpi-steps').textContent = `${s.turnCount || turns.length || 0} turns · ${s.stepCount || 0} steps`;
    tweenNumber($('kpi-out'), s.totalOut, fmtTok);
    $('kpi-in').textContent = `in ${fmtTok(s.totalIn)} · cache ${fmtTok(s.totalCache)}`;

    updateContextCard(s);

    $('chart-meta').textContent = `最近 ${steps.length} 个 Planner Step`;

    $('hud-in').textContent = fmtTok(s.totalIn);
    $('hud-cache').textContent = `${fmtTok(s.totalCache)} (${cachePct.toFixed(1)}%)`;
    $('hud-out').textContent = fmtTok(s.totalOut);
    tweenNumber(
      $('hud-speed-val'),
      s.latestTps ?? s.avgTps ?? 0,
      (v) => `${v.toFixed(1)} tok/s`
    );
    tweenNumber($('hud-saved'), s.estSavedPct || 0, (v) => `${v.toFixed(1)}%`);

    renderTurns(turns, { active: isActive, turnState });
    renderFlatSteps(steps);
    syncChartTargets(steps);
  }

  function setView(view) {
    state.view = view;
    const isTurns = view === 'turns';
    $('view-turns').classList.toggle('active', isTurns);
    $('view-turns').setAttribute('aria-selected', String(isTurns));
    $('view-flat').classList.toggle('active', !isTurns);
    $('view-flat').setAttribute('aria-selected', String(!isTurns));
    $('turns-container').classList.toggle('hidden', !isTurns);
    $('flat-container').classList.toggle('hidden', isTurns);
    $('expand-all-btn').classList.toggle('hidden', !isTurns);
    $('collapse-all-btn').classList.toggle('hidden', !isTurns);
  }

  function hitTestChart(clientX, clientY) {
    const canvas = $('trend-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return state.chartSlots.find((slot) => x >= slot.x0 && x <= slot.x1 && y >= slot.y0 - 4 && y <= slot.y1 + 6) || null;
  }

  const canvas = $('trend-canvas');
  canvas.addEventListener('mousemove', (e) => {
    const hit = hitTestChart(e.clientX, e.clientY);
    if (hit) {
      canvas.style.cursor = 'pointer';
      if (state.hoveredStep !== hit.step.step) {
        state.hoveredStep = hit.step.step;
        scheduleChartFrame();
      }
      showTooltip(hit, e.clientX, e.clientY);
    } else {
      canvas.style.cursor = 'default';
      if (state.hoveredStep !== null) {
        state.hoveredStep = null;
        scheduleChartFrame();
      }
      hideTooltip();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    canvas.style.cursor = 'default';
    if (state.hoveredStep !== null) {
      state.hoveredStep = null;
      scheduleChartFrame();
    }
    hideTooltip();
  });

  canvas.addEventListener('click', (e) => {
    const hit = hitTestChart(e.clientX, e.clientY);
    if (hit) {
      state.clickRipple = { step: hit.step.step, start: performance.now() };
      jumpToStep(hit.step);
    }
  });

  async function poll() {
    try {
      const targetConv = getLockedConvId();
      const q = new URLSearchParams();
      if (targetConv) q.set('conversationId', targetConv);
      if (state.etag) q.set('etag', state.etag);
      const data = await getJson(`/api/metrics?${q.toString()}`);
      if (data.empty) {
        renderEmptyState(data.reason, data.conversationId || targetConv);
      } else if (!data.unchanged) {
        state.etag = data.etag || '';
        renderMetrics(data);
      }
    } catch {
      const badge = $('live-badge');
      badge.classList.remove('active');
      badge.classList.add('error');
      badge.textContent = 'RECONNECTING';
    }
  }

  let toastTimer = 0;
  function showToast(msg) {
    const el = $('hud-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
  }

  $('ctx-toggle').addEventListener('click', () => {
    state.ctxLimit = state.ctxLimit >= 1000000 ? 200000 : 1000000;
    $('ctx-toggle').textContent = state.ctxLimit >= 1000000 ? '/ 1M' : '/ 200K';
    if (state.lastData) {
      updateContextCard(state.lastData.summary);
    } else {
      $('kpi-ctx-sub').textContent = `-- / ${fmtTok(state.ctxLimit)}`;
    }
  });

  $('compact-btn').addEventListener('click', async () => {
    const btn = $('compact-btn');
    const label = $('compact-label');
    const restore = () => {
      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('done');
        if (state.lastData) updateContextCard(state.lastData.summary);
        else label.textContent = '压缩上下文';
      }, 2200);
    };

    const copyCompactCommand = async () => {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText('/compact');
          return true;
        } catch {
          // Fallback below when Clipboard API is restricted inside iframe
        }
      }
      const ta = document.createElement('textarea');
      ta.value = '/compact';
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        ta.remove();
      }
      return copied;
    };

    btn.disabled = true;
    btn.classList.remove('urgent', 'done');
    label.textContent = '复制中…';

    const ok = await copyCompactCommand();
    if (ok) {
      btn.classList.add('done');
      label.textContent = '已复制 /compact';
      showToast('已复制 /compact，请在聊天输入框 Ctrl+V 回车执行压缩');
    } else {
      label.textContent = '请输 /compact';
      showToast('请在对话输入框输入 /compact 回车执行压缩');
    }
    restore();
  });

  $('view-turns').addEventListener('click', () => setView('turns'));
  $('view-flat').addEventListener('click', () => setView('flat'));

  $('turns-container').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-turn-toggle]');
    if (!btn) return;
    const idx = Number(btn.dataset.turnToggle);
    state.userToggledTurns = true;
    const isOpen = !state.expandedTurns.has(idx);
    if (isOpen) state.expandedTurns.add(idx);
    else state.expandedTurns.delete(idx);

    const turnEl = btn.closest('.turn-item');
    if (turnEl) turnEl.classList.toggle('is-open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
  });

  $('expand-all-btn').addEventListener('click', () => {
    if (!state.lastData) return;
    state.userToggledTurns = true;
    for (const t of state.lastData.turns || []) state.expandedTurns.add(t.turnIndex);
    document.querySelectorAll('#turns-container .turn-item').forEach((item) => {
      item.classList.add('is-open');
      const btn = item.querySelector('[data-turn-toggle]');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    });
  });

  $('collapse-all-btn').addEventListener('click', () => {
    state.userToggledTurns = true;
    state.expandedTurns.clear();
    document.querySelectorAll('#turns-container .turn-item').forEach((item) => {
      item.classList.remove('is-open');
      const btn = item.querySelector('[data-turn-toggle]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  });

  window.addEventListener('resize', () => {
    if (state.lastData) scheduleChartFrame();
    else drawEmptyChart();
  });

  poll();
  setInterval(poll, POLL_MS);
})();
