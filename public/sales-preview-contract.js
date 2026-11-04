(function salesPreviewContractWidget() {
  const script = document.currentScript
    || document.querySelector('script[src*="sales-preview-contract.js"][data-sales-client-id]');
  const clientId = String(script?.getAttribute('data-sales-client-id') || '').trim();
  if (!clientId || document.querySelector('[data-asoldi-preview-contract]')) return;

  const api = `/api/public/sales-preview/${encodeURIComponent(clientId)}/contract`;
  const host = document.createElement('div');
  host.setAttribute('data-asoldi-preview-contract', '');
  host.setAttribute('data-lenis-prevent', '');
  host.setAttribute('data-lenis-prevent-wheel', '');
  (document.body || document.documentElement).appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      .btn[hidden], .scroll-cue[hidden] { display: none !important; }
      .btn {
        position: fixed;
        left: 50%;
        bottom: 24px;
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 52px;
        min-width: 52px;
        padding: 0 16px;
        border: 1.5px solid #fff;
        border-radius: 999px;
        background: #111;
        color: #fff;
        cursor: pointer;
        transform: translateX(-50%);
        isolation: isolate;
        overflow: hidden;
        white-space: nowrap;
        box-shadow: 0 8px 28px rgba(0,0,0,.28);
        transition: min-width .25s ease, background .2s ease, color .2s ease, border-color .2s ease, opacity .2s ease, box-shadow .2s ease;
      }
      @property --asoldi-orbit {
        syntax: "<angle>";
        inherits: false;
        initial-value: 0deg;
      }
      .btn::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        opacity: 0;
        z-index: 0;
        padding: 2px;
        background: conic-gradient(from var(--asoldi-orbit), #FF5B00 0 14%, #ffb087 22%, transparent 38% 68%, #fff 84%, #FF5B00 100%);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask-composite: exclude;
      }
      .btn[data-call="1"] {
        border-color: transparent;
        box-shadow: 0 0 0 1px rgba(255,91,0,.4), 0 8px 28px rgba(255,91,0,.32);
      }
      .btn[data-call="1"]::before {
        opacity: 1;
        animation: asoldi-orbit 1.4s linear infinite;
      }
      @keyframes asoldi-orbit { to { --asoldi-orbit: 360deg; } }
      .btn[data-status="idle"] {
        background: #9CA3AF;
        border-color: #D1D5DB;
        color: #F9FAFB;
        cursor: default;
        opacity: .72;
      }
      .btn[data-status="ready"] {
        min-width: 188px;
        background: #fff;
        color: #111;
        border-color: #111;
      }
      .btn-label {
        position: relative;
        z-index: 1;
        max-width: 0;
        margin-left: 0;
        opacity: 0;
        font-size: 13px;
        font-weight: 650;
        letter-spacing: .02em;
        transition: max-width .25s ease, opacity .2s ease, margin .25s ease;
      }
      .btn[data-status="ready"] .btn-label {
        max-width: 160px;
        margin-left: 8px;
        opacity: 1;
      }
      .mark { position: relative; z-index: 1; width: 18px; height: 18px; flex: 0 0 18px; }
      .check-icon { display: none; }
      .btn[data-status="signed"] .idle-icon { display: none; }
      .btn[data-status="signed"] .check-icon { display: block; }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        align-items: stretch;
        justify-content: center;
        width: 100%;
        height: 100%;
        max-width: none;
        max-height: none;
        margin: 0;
        border: 0;
        padding: 10px;
        background: rgba(0,0,0,.5);
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
      }
      .overlay.open, .overlay[open] { display: flex; }
      dialog.overlay:modal {
        width: 100vw;
        height: 100dvh;
        max-width: none;
        max-height: none;
        margin: 0;
      }
      .overlay::backdrop { background: rgba(0,0,0,.45); }
      .overlay.docking {
        background: rgba(0,0,0,0);
        transition: background .45s ease;
      }
      .overlay.docking::backdrop { background: rgba(0,0,0,0); }
      .panel {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: none;
        height: auto;
        max-height: none;
        min-height: 0;
        align-self: stretch;
        overflow: hidden;
        overscroll-behavior: contain;
        border-radius: 16px;
        background: #EFECE4;
        box-shadow: 0 24px 80px rgba(0,0,0,.35);
        touch-action: auto;
        will-change: transform, opacity;
      }
      .panel.docking {
        pointer-events: none;
        transition: transform .55s cubic-bezier(.22,.7,.2,1), opacity .4s ease;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 18px;
        border-bottom: 1px solid #E5E1D8;
        background: #fff;
      }
      .head h2 { margin: 0; font-size: 15px; font-weight: 650; color: #111827; }
      .head-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .pdf {
        height: 36px; padding: 0 12px; border: 1px solid #E5E7EB; border-radius: 8px;
        background: #fff; color: #111; font-size: 12px; font-weight: 650; text-decoration: none;
        display: inline-flex; align-items: center; white-space: nowrap;
      }
      .close {
        width: 36px; height: 36px; border: 0; border-radius: 8px;
        background: #F3F4F6; color: #111; cursor: pointer; font-size: 20px; line-height: 1;
      }
      .scroller {
        min-height: 50%;
        flex: 1 1 auto;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-y;
      }
      .paper {
        margin: 20px auto;
        max-width: 760px;
        background: #fff;
        padding: 40px 48px;
        box-shadow: 0 1px 2px rgba(17,24,39,.06);
        color: #1F2937;
        font-size: 14px;
        line-height: 1.7;
      }
      .paper h1 { margin: 12px 0 0; font-family: Georgia, serif; font-size: 2rem; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; color: #111827; }
      .paper h2 { margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #E8E4DC; font-size: 12px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase; color: #111827; }
      .paper p { margin: 10px 0; }
      .paper ul, .paper ol { margin: 8px 0 12px; padding-left: 20px; }
      .offer-contract-masthead { margin-bottom: 40px; padding-bottom: 32px; border-bottom: 1px solid #E8E4DC; text-align: center; }
      .offer-contract-kicker { font-size: 11px; font-weight: 500; letter-spacing: .18em; text-transform: uppercase; color: #6B7280; }
      .offer-contract-sub { margin-top: 8px; font-size: 14px; color: #6B7280; }
      .offer-contract-date { margin-top: 12px; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #9CA3AF; }
      .offer-contract-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-bottom: 32px; }
      .offer-contract-parties h2 { margin-top: 0; }
      .paper dl { margin: 0; }
      .paper dl div { display: grid; grid-template-columns: 7.5rem 1fr; gap: 12px; margin: 6px 0; }
      .paper dt { font-size: 12px; color: #6B7280; }
      .paper dd { margin: 0; color: #111827; }
      .offer-contract-sign { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 24px; }
      .offer-contract-sign h2 { margin-top: 0; }
      .offer-contract-sign-line { min-height: 56px; border-bottom: 1px solid #222; display: flex; align-items: flex-end; }
      .offer-contract-stamp { height: 52px; width: auto; max-width: 100%; object-fit: contain; }
      .offer-contract-sign-note { margin-top: 12px; color: #4B5563; font-size: 14px; line-height: 1.55; }
      .foot {
        position: relative;
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 12px 20px max(16px, env(safe-area-inset-bottom));
        border-top: 1px solid #E5E1D8;
        background: rgba(255,255,255,.96);
      }
      .cta, .hint {
        width: 100%;
        max-width: 760px;
      }
      .cta {
        height: 48px;
        border: 0;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 650;
        cursor: pointer;
        transition: background .2s ease, color .2s ease;
      }
      .scroll-cue {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        margin: 0 0 8px;
        padding: 0;
        border: 0;
        background: none;
        color: #6B7280;
        font-size: 11px;
        font-weight: 650;
        letter-spacing: .12em;
        text-transform: uppercase;
        pointer-events: none;
        animation: asoldi-scroll-cue 1.8s ease-in-out infinite;
      }
      .scroll-cue svg { display: block; }
      @keyframes asoldi-scroll-cue {
        0%, 100% { opacity: .35; transform: translateY(0); }
        50% { opacity: .95; transform: translateY(6px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .scroll-cue { animation: none; opacity: .7; }
      }
      .cta[data-ready="0"] {
        background: #D1D5DB;
        color: #6B7280;
      }
      .cta[data-ready="1"] {
        background: #111827;
        color: #fff;
      }
      .hint {
        display: none;
        margin: 0 0 8px;
        padding: 10px 14px;
        border-radius: 10px;
        background: #111827;
        color: #fff;
        font-size: 13px;
        line-height: 1.45;
        text-align: center;
      }
      .hint.show { display: block; }
      .auth {
        position: fixed;
        inset: 0;
        z-index: 1;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, .52);
        backdrop-filter: blur(10px);
        overflow: auto;
        overscroll-behavior: contain;
        touch-action: auto;
      }
      .auth.open { display: flex; }
      .auth-card {
        position: relative;
        width: 100%;
        max-width: 420px;
        max-height: min(92vh, 780px);
        overflow: auto;
        overscroll-behavior: contain;
        margin: auto;
        padding: 32px 32px 28px;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 24px 80px rgba(15, 23, 42, .28);
      }
      .auth-close {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #6B7280;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }
      .auth-close:hover { background: #F3F4F6; color: #111827; }
      .auth-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 18px;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -.02em;
        color: #111827;
      }
      .auth-mark {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #FF5B00;
      }
      .auth-card h2 {
        margin: 0;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: -.03em;
        color: #111827;
      }
      .lede {
        margin: 10px 0 22px;
        font-size: 14px;
        line-height: 1.55;
        color: #6B7280;
      }
      .auth-form { margin: 0; }
      .field { margin: 0 0 14px; }
      .field-label {
        display: block;
        margin: 0 0 6px;
        font-size: 14px;
        font-weight: 550;
        color: #111827;
      }
      .field input[type="text"],
      .field input[type="email"],
      .field input[type="password"] {
        width: 100%;
        height: 44px;
        padding: 0 14px;
        border: 1px solid #E5E7EB;
        border-radius: 8px;
        font-size: 14px;
        color: #111827;
        background: #fff;
      }
      .field input:focus {
        outline: none;
        border-color: #FF5B00;
        box-shadow: 0 0 0 3px rgba(255,91,0,.14);
      }
      .field input::placeholder { color: #9CA3AF; }
      .pass-wrap { position: relative; }
      .pass-wrap input { padding-right: 44px; }
      .eye {
        position: absolute;
        right: 4px;
        top: 50%;
        width: 36px;
        height: 36px;
        transform: translateY(-50%);
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #9CA3AF;
        cursor: pointer;
      }
      .eye:hover { color: #111827; }
      .alts { display: grid; gap: 8px; margin: 4px 0 14px; }
      .alt { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid #E5E7EB; border-radius: 12px; cursor: pointer; font-size: 14px; }
      .alt input { margin-top: 3px; accent-color: #FF5B00; }
      .accept { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #374151; margin: 0; }
      .accept + .accept { margin-top: 10px; }
      .accept input { margin-top: 3px; flex: 0 0 auto; accent-color: #FF5B00; }
      .accept a { color: #FF5B00; font-weight: 650; }
      .accepts { margin: 4px 0 16px; }
      .auth-go {
        width: 100%;
        height: 44px;
        border: 0;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 650;
        transition: background .15s ease, color .15s ease;
      }
      .auth-go.wait {
        background: #E5E7EB;
        color: #9CA3AF;
        cursor: pointer;
      }
      .auth-go.ready {
        background: #FF5B00;
        color: #fff;
        cursor: pointer;
      }
      .auth-go.ready:hover { background: #E55200; }
      .auth-err {
        margin: 10px 0 0;
        font-size: 13px;
        color: #DC2626;
      }
      .auth-switch {
        margin: 20px 0 0;
        text-align: center;
        font-size: 14px;
        color: #6B7280;
      }
      .auth-switch button {
        border: 0;
        padding: 0;
        background: none;
        color: #111827;
        font-weight: 650;
        text-decoration: underline;
        cursor: pointer;
      }
      @media (max-width: 640px) {
        .paper { padding: 28px 20px; }
        .offer-contract-parties, .offer-contract-sign { grid-template-columns: 1fr; }
        .auth { padding: 12px; }
        .auth-card { padding: 28px 20px 22px; }
      }
    </style>
    <button class="btn" type="button" data-status="idle" aria-label="Kontrakt">
      <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path class="idle-icon" d="M7 4h10a1 1 0 0 1 1 1v15l-6-3-6 3V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.7"/>
        <path class="check-icon" d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="btn-label">Signer kontrakt</span>
    </button>
    <dialog class="overlay" aria-modal="true" aria-labelledby="asoldi-contract-title">
      <div class="panel" role="document">
        <div class="head">
          <h2 id="asoldi-contract-title">Kontrakt</h2>
          <div class="head-actions">
            <a class="pdf" href="${api}.pdf?download=1" target="_blank" rel="noopener">Last ned PDF</a>
            <button class="close" type="button" aria-label="Lukk">\u00d7</button>
          </div>
        </div>
        <div class="scroller">
          <div class="paper"></div>
        </div>
        <div class="foot">
          <div class="scroll-cue" hidden aria-hidden="true">
            <span>Bla ned</span>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <p class="hint" role="status" aria-live="polite">Du m\u00e5 lese hele kontrakten f\u00f8r du kan g\u00e5 videre. Scroll ned til bunnen.</p>
          <button class="cta" type="button" data-ready="0">Signer og lag Asoldi-bruker</button>
        </div>
      </div>
      <div class="auth" hidden>
        <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="asoldi-auth-title"></div>
      </div>
    </dialog>
  `;

  const btn = shadow.querySelector('.btn');
  const overlay = shadow.querySelector('.overlay');
  const scroller = shadow.querySelector('.scroller');
  const paper = shadow.querySelector('.paper');
  const foot = shadow.querySelector('.foot');
  const hint = shadow.querySelector('.hint');
  const cta = shadow.querySelector('.cta');
  const scrollCue = shadow.querySelector('.scroll-cue');
  const auth = shadow.querySelector('.auth');
  const authCard = shadow.querySelector('.auth-card');
  let state = { status: 'idle', name: '', email: '', contractHtml: '', alternatives: [], acceptedAt: '' };
  let atBottom = false;
  let chosen = null;
  let busy = false;
  let docking = false;
  let authMode = 'signup';
  let draftName = '';
  let draftEmail = '';
  let hintTimer = 0;
  const frozenStyles = [];

  function wantsContractOpen() {
    try {
      const params = new URLSearchParams(location.search || '');
      if (params.get('kontrakt') === '1' || params.get('contract') === '1') return true;
      return /\/kontrakt(?:\/index\.html?)?$/i.test(String(location.pathname || '').replace(/\/+$/, ''));
    } catch {
      return false;
    }
  }
  const fromContractLink = wantsContractOpen();

  function setStatus(status) {
    state.status = status;
    btn.dataset.status = status;
    btn.setAttribute('aria-label', status === 'signed' ? 'Kontrakt signert' : status === 'ready' ? 'Signer kontrakt' : 'Kontrakt');
    if (status === 'ready') btn.dataset.call = '1';
    else delete btn.dataset.call;
  }

  function isModalOpen() {
    return overlay.classList.contains('open') || overlay.open === true;
  }

  function isAuthOpen() {
    return auth.classList.contains('open');
  }

  function eventInside(root, event) {
    if (!root || !event) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.length) return path.includes(root);
    return root.contains(event.target);
  }

  function wheelDeltaY(event) {
    if (event.deltaMode === 1) return event.deltaY * 16;
    if (event.deltaMode === 2) return event.deltaY * (scroller.clientHeight || 800);
    return event.deltaY;
  }

  function applyDelta(el, delta) {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const next = Math.min(max, Math.max(0, el.scrollTop + delta));
    const moved = next !== el.scrollTop;
    el.scrollTop = next;
    if (el === scroller) syncBottom();
    return moved;
  }

  function pauseSmoothScroll() {
    try { window.lenis?.stop?.(); } catch {}
    try { window.Lenis?.instances?.forEach?.((item) => item.stop?.()); } catch {}
  }

  function resumeSmoothScroll() {
    try { window.lenis?.start?.(); } catch {}
  }

  function coverPreviewChrome(on) {
    const cover = !!on;
    try {
      window.parent.postMessage({ type: 'asoldi-preview-contract', cover }, location.origin);
    } catch {}
    try {
      if (window.parent && window.parent !== window) {
        const doc = window.parent.document;
        if (doc.getElementById('asoldi-preview-chrome')) {
          doc.documentElement.classList.toggle('asoldi-contract-cover', cover);
        }
      }
    } catch {}
  }

  function lockPageScroll() {
    coverPreviewChrome(true);
    if (frozenStyles.length) return;
    [document.documentElement, document.body].forEach((node) => {
      if (!node) return;
      frozenStyles.push({ node, overflow: node.style.overflow, overscrollBehavior: node.style.overscrollBehavior });
      node.style.overflow = 'hidden';
      node.style.overscrollBehavior = 'none';
    });
    document.documentElement.setAttribute('data-asoldi-contract-open', '');
    pauseSmoothScroll();
    window.addEventListener('wheel', trapWheel, { capture: true, passive: false });
    window.addEventListener('touchstart', trapTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', trapTouch, { capture: true, passive: false });
    window.addEventListener('keydown', trapKeys, true);
  }

  function unlockPageScroll() {
    frozenStyles.splice(0).forEach((item) => {
      item.node.style.overflow = item.overflow;
      item.node.style.overscrollBehavior = item.overscrollBehavior;
    });
    document.documentElement.removeAttribute('data-asoldi-contract-open');
    coverPreviewChrome(false);
    window.removeEventListener('wheel', trapWheel, { capture: true });
    window.removeEventListener('touchstart', trapTouchStart, { capture: true });
    window.removeEventListener('touchmove', trapTouch, { capture: true });
    window.removeEventListener('keydown', trapKeys, true);
    resumeSmoothScroll();
  }

  function trapWheel(event) {
    if (!isModalOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    if (isAuthOpen()) {
      applyDelta(authCard, wheelDeltaY(event));
      return;
    }
    applyDelta(scroller, wheelDeltaY(event));
  }

  let touchY = 0;
  function trapTouchStart(event) {
    touchY = event.touches?.[0]?.clientY || 0;
  }
  function trapTouch(event) {
    if (!isModalOpen()) return;
    const y = event.touches?.[0]?.clientY || 0;
    const delta = touchY - y;
    touchY = y;
    if (isAuthOpen()) {
      if (eventInside(authCard, event)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (eventInside(scroller, event) || eventInside(foot, event)) return;
    event.preventDefault();
    event.stopPropagation();
    applyDelta(scroller, delta);
  }

  function trapKeys(event) {
    if (!isModalOpen()) return;
    const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '];
    if (!keys.includes(event.key)) return;
    const tag = String(event.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
    event.preventDefault();
    event.stopPropagation();
    const target = isAuthOpen() ? authCard : scroller;
    const page = target.clientHeight || 400;
    const delta = event.key === 'ArrowDown' ? 40
      : event.key === 'ArrowUp' ? -40
        : event.key === 'PageDown' || event.key === ' ' ? page
          : event.key === 'PageUp' ? -page
            : event.key === 'Home' ? -target.scrollHeight
              : target.scrollHeight;
    applyDelta(target, delta);
  }

  function finishClose() {
    closeAuth();
    overlay.classList.remove('docking');
    const panel = shadow.querySelector('.panel');
    if (panel) {
      panel.classList.remove('docking');
      panel.style.transform = '';
      panel.style.opacity = '';
      panel.style.transformOrigin = '';
    }
    if (typeof overlay.close === 'function' && overlay.open) {
      overlay.close();
      return;
    }
    overlay.classList.remove('open');
    overlay.removeAttribute('open');
    unlockPageScroll();
    btn.hidden = false;
    if (state.status === 'ready') btn.dataset.call = '1';
  }

  function dockIntoButton() {
    if (docking) return;
    const panel = shadow.querySelector('.panel');
    if (!panel) {
      finishClose();
      return;
    }
    docking = true;
    closeAuth();
    btn.hidden = false;
    btn.dataset.call = '1';
    const panelRect = panel.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const dx = (btnRect.left + btnRect.width / 2) - (panelRect.left + panelRect.width / 2);
    const dy = (btnRect.top + btnRect.height / 2) - (panelRect.top + panelRect.height / 2);
    const sx = Math.max(0.04, btnRect.width / Math.max(1, panelRect.width));
    const sy = Math.max(0.04, btnRect.height / Math.max(1, panelRect.height));
    overlay.classList.add('docking');
    panel.classList.add('docking');
    panel.style.transformOrigin = 'center center';
    requestAnimationFrame(() => {
      panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      panel.style.opacity = '0';
    });
    window.setTimeout(() => {
      docking = false;
      finishClose();
    }, 560);
  }

  function closeModal() {
    if (!isModalOpen() || docking) return;
    if (isAuthOpen()) {
      closeAuth();
      return;
    }
    if (fromContractLink && state.status === 'ready') {
      dockIntoButton();
      return;
    }
    finishClose();
  }

  function hideHint() {
    hint.classList.remove('show');
    if (hintTimer) window.clearTimeout(hintTimer);
    hintTimer = 0;
  }

  function showReadHint() {
    hint.classList.add('show');
    if (hintTimer) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(hideHint, 3400);
  }

  function syncBottom() {
    const reached = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 28;
    atBottom = reached || scroller.scrollHeight <= scroller.clientHeight + 8;
    cta.dataset.ready = atBottom ? '1' : '0';
    if (atBottom) hideHint();
    if (scrollCue) {
      const scrolled = scroller.scrollTop > 8;
      scrollCue.hidden = !isModalOpen() || isAuthOpen() || atBottom || scrolled;
    }
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function authBlockReason() {
    const name = String(authCard.querySelector('[name="name"]')?.value || '').trim();
    const email = String(authCard.querySelector('[name="email"]')?.value || '').trim();
    const password = String(authCard.querySelector('[name="password"]')?.value || '');
    const password2 = String(authCard.querySelector('[name="password2"]')?.value || '');
    const needsChoice = Array.isArray(state.alternatives) && state.alternatives.length >= 2;
    if (authMode === 'signup' && !name) return 'name';
    if (!validEmail(email)) return 'email';
    if (password.length < 8) return 'password';
    if (authMode === 'signup' && password !== password2) return 'repeat';
    if (needsChoice && chosen !== 0 && chosen !== 1) return 'choice';
    if (!authCard.querySelector('[name="terms"]')?.checked) return 'terms';
    if (!authCard.querySelector('[name="binding"]')?.checked) return 'binding';
    return '';
  }

  function authMessage(reason) {
    return reason === 'name' ? 'Skriv inn navnet ditt.'
      : reason === 'email' ? 'Skriv inn en gyldig e-post.'
        : reason === 'password' ? 'Passordet m\u00e5 v\u00e6re minst 8 tegn.'
          : reason === 'repeat' ? 'Passordene m\u00e5 v\u00e6re like.'
            : reason === 'choice' ? 'Velg Tilbud 1 eller Tilbud 2 f\u00f8r du signerer.'
              : reason === 'terms' ? 'Du m\u00e5 godta vilk\u00e5r og betingelser f\u00f8r du signerer.'
                : reason === 'binding' ? 'Du m\u00e5 godkjenne 6 m\u00e5neders bindingstid f\u00f8r du signerer.'
                  : '';
  }

  function refreshAuthSubmit() {
    const submit = authCard.querySelector('.auth-go');
    if (!submit) return;
    const blocked = Boolean(authBlockReason()) || busy;
    submit.classList.toggle('wait', blocked);
    submit.classList.toggle('ready', !blocked);
  }

  function bindEye(button, input) {
    if (!button || !input) return;
    button.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  function renderAuth() {
    const signup = authMode === 'signup';
    const alts = Array.isArray(state.alternatives) && state.alternatives.length >= 2 ? state.alternatives : [];
    const eye = `<button class="eye" type="button" tabindex="-1" aria-label="Vis passord">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>`;
    authCard.innerHTML = `
      <button class="auth-close" type="button" aria-label="Lukk">\u00d7</button>
      <div class="auth-brand"><span class="auth-mark"></span>Asoldi</div>
      <h2 id="asoldi-auth-title">${signup ? 'Opprett konto' : 'Logg inn'}</h2>
      <p class="lede">Med denne brukeren f\u00e5r du tilgang til Asoldi-terminalen, fremdriftsdata, forh\u00e5ndsvisninger og hele systemet v\u00e5rt. Du signerer ogs\u00e5 kontrakten, s\u00e5 vi kan starte samarbeidet.</p>
      <form class="auth-form" autocomplete="off" novalidate data-lpignore="true" data-1p-ignore="true" data-form-type="other">
        ${signup ? `<label class="field">
          <span class="field-label">Navn</span>
          <input name="name" type="text" value="${escapeAttr(draftName)}" autocomplete="off" autocapitalize="words" spellcheck="false" data-lpignore="true" data-1p-ignore="true" placeholder="Fullt navn">
        </label>` : ''}
        <label class="field">
          <span class="field-label">E-post</span>
          <input name="email" type="email" value="${escapeAttr(draftEmail)}" autocomplete="off" autocapitalize="none" spellcheck="false" data-lpignore="true" data-1p-ignore="true" placeholder="navn@bedrift.no">
        </label>
        <label class="field">
          <span class="field-label">Passord</span>
          <span class="pass-wrap">
            <input name="password" type="password" minlength="8" autocomplete="off" data-lpignore="true" data-1p-ignore="true" placeholder="Minst 8 tegn">
            ${eye}
          </span>
        </label>
        ${signup ? `<label class="field">
          <span class="field-label">Gjenta passord</span>
          <span class="pass-wrap">
            <input name="password2" type="password" minlength="8" autocomplete="off" data-lpignore="true" data-1p-ignore="true" placeholder="Gjenta passordet">
            ${eye}
          </span>
        </label>` : ''}
        ${alts.length ? `<div class="alts">${alts.map((alt) => `
          <label class="alt">
            <input type="radio" name="chosen" value="${alt.index === 1 ? 1 : 0}" ${chosen === (alt.index === 1 ? 1 : 0) ? 'checked' : ''}>
            <span><strong>${escapeHtml(alt.label || '')}</strong>${alt.name ? ` \u2014 ${escapeHtml(alt.name)}` : ''}${alt.price ? `<br><small>${escapeHtml(alt.price)}</small>` : ''}</span>
          </label>`).join('')}</div>` : ''}
        <div class="accepts">
          <label class="accept">
            <input name="terms" type="checkbox">
            <span>Jeg godtar <a href="https://asoldi.com/vilkar" target="_blank" rel="noopener">vilk\u00e5r og betingelser</a>.</span>
          </label>
          <label class="accept">
            <input name="binding" type="checkbox">
            <span>Jeg anerkjenner at avtalen har bindingstid p\u00e5 6 m\u00e5neder.</span>
          </label>
        </div>
        <button class="auth-go wait" type="submit">Signer</button>
        <p class="auth-err" hidden></p>
      </form>
      <p class="auth-switch">${signup
        ? 'Har du allerede en konto? <button type="button" data-switch="login">Logg inn</button>'
        : 'Har du ikke konto? <button type="button" data-switch="signup">Opprett konto</button>'}</p>
    `;
    authCard.querySelector('.auth-close')?.addEventListener('click', closeAuth);
    authCard.querySelector('[data-switch]')?.addEventListener('click', () => {
      rememberDraft();
      authMode = signup ? 'login' : 'signup';
      renderAuth();
    });
    const form = authCard.querySelector('.auth-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = authBlockReason();
      const err = authCard.querySelector('.auth-err');
      if (reason) {
        if (err) {
          err.hidden = false;
          err.textContent = authMessage(reason);
        }
        return;
      }
      if (err) { err.hidden = true; err.textContent = ''; }
      void submitAccept();
    });
    form?.addEventListener('input', () => {
      rememberDraft();
      refreshAuthSubmit();
    });
    form?.addEventListener('change', refreshAuthSubmit);
    authCard.querySelectorAll('[name="chosen"]').forEach((input) => {
      input.addEventListener('change', () => {
        chosen = Number(input.value) === 1 ? 1 : 0;
        refreshAuthSubmit();
      });
    });
    const wraps = authCard.querySelectorAll('.pass-wrap');
    wraps.forEach((wrap) => bindEye(wrap.querySelector('.eye'), wrap.querySelector('input')));
    refreshAuthSubmit();
  }

  function rememberDraft() {
    const nameInput = authCard.querySelector('[name="name"]');
    const emailInput = authCard.querySelector('[name="email"]');
    if (nameInput) draftName = String(nameInput.value || '');
    if (emailInput) draftEmail = String(emailInput.value || '');
  }

  function openAuth() {
    if (!atBottom) {
      showReadHint();
      return;
    }
    renderAuth();
    auth.hidden = false;
    auth.classList.add('open');
    const focusName = authCard.querySelector('[name="name"]');
    const focusEmail = authCard.querySelector('[name="email"]');
    (focusName || focusEmail)?.focus?.();
  }

  function closeAuth() {
    rememberDraft();
    auth.classList.remove('open');
    auth.hidden = true;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function openModal() {
    if (state.status !== 'ready') return;
    delete btn.dataset.call;
    paper.innerHTML = state.contractHtml || '<p>Kontraktteksten kommer n\u00e5r tilbudet er sendt.</p>';
    chosen = null;
    atBottom = false;
    cta.dataset.ready = '0';
    hideHint();
    closeAuth();
    overlay.classList.add('open');
    if (typeof overlay.showModal === 'function') {
      try {
        if (!overlay.open) overlay.showModal();
      } catch {
        overlay.setAttribute('open', '');
      }
    } else {
      overlay.setAttribute('open', '');
    }
    btn.hidden = true;
    lockPageScroll();
    scroller.scrollTop = 0;
    requestAnimationFrame(() => {
      syncBottom();
      requestAnimationFrame(syncBottom);
    });
  }

  async function load() {
    try {
      const response = await fetch(api, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      state = {
        status: data.status === 'signed' || data.status === 'ready' ? data.status : 'idle',
        name: String(data.name || ''),
        email: String(data.email || ''),
        contractHtml: String(data.contractHtml || ''),
        alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
        acceptedAt: String(data.acceptedAt || ''),
      };
      if (!draftName) draftName = state.name;
      if (!draftEmail) draftEmail = state.email;
      setStatus(state.status);
    } catch {
      setStatus('idle');
    }
  }

  async function submitAccept() {
    const submit = authCard.querySelector('.auth-go');
    const err = authCard.querySelector('.auth-err');
    if (!submit || busy) return;
    busy = true;
    refreshAuthSubmit();
    if (err) { err.hidden = true; err.textContent = ''; }
    try {
      const body = {
        mode: authMode,
        password: String(authCard.querySelector('[name="password"]')?.value || ''),
        name: authMode === 'signup' ? String(authCard.querySelector('[name="name"]')?.value || draftName || '') : '',
        email: String(authCard.querySelector('[name="email"]')?.value || ''),
        accepted: true,
        termsAccepted: Boolean(authCard.querySelector('[name="terms"]')?.checked),
        bindingAccepted: Boolean(authCard.querySelector('[name="binding"]')?.checked),
        language: navigator.language || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        platform: navigator.platform || '',
        screen: { width: window.screen?.width || 0, height: window.screen?.height || 0 },
      };
      if (chosen === 0 || chosen === 1) body.chosenOfferIndex = chosen;
      const response = await fetch(`${api}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke signere.');
      state.status = 'signed';
      setStatus('signed');
      closeAuth();
      closeModal();
    } catch (error) {
      if (err) {
        err.hidden = false;
        err.textContent = error instanceof Error ? error.message : 'Kunne ikke signere.';
      }
    } finally {
      busy = false;
      refreshAuthSubmit();
    }
  }

  btn.addEventListener('click', () => {
    if (state.status === 'ready') openModal();
  });
  cta.addEventListener('click', () => {
    if (state.status !== 'ready') return;
    openAuth();
  });
  shadow.querySelector('.close').addEventListener('click', closeModal);
  overlay.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (isAuthOpen()) closeAuth();
    else closeModal();
  });
  overlay.addEventListener('close', () => {
    overlay.classList.remove('open');
    overlay.classList.remove('docking');
    closeAuth();
    unlockPageScroll();
    btn.hidden = false;
    if (state.status === 'ready') btn.dataset.call = '1';
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal();
  });
  auth.addEventListener('click', (event) => {
    if (event.target === auth) closeAuth();
  });
  overlay.addEventListener('wheel', trapWheel, { passive: false });
  overlay.addEventListener('touchstart', trapTouchStart, { passive: true });
  overlay.addEventListener('touchmove', trapTouch, { passive: false });
  scroller.addEventListener('scroll', syncBottom, { passive: true });
  window.addEventListener('resize', () => { if (isModalOpen()) syncBottom(); });
  if (typeof ResizeObserver === 'function') {
    const resizeSync = new ResizeObserver(() => { if (isModalOpen()) syncBottom(); });
    resizeSync.observe(scroller);
    resizeSync.observe(paper);
  }
  void load().then(() => {
    if (fromContractLink && state.status === 'ready') openModal();
  });
})();
