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
      * { box-sizing: border-box; font-family: Inter, system-ui, sans-serif; }
      .btn[hidden] { display: none !important; }
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
        overflow: visible;
        white-space: nowrap;
        box-shadow: 0 8px 28px rgba(0,0,0,.28);
        transition: min-width .25s ease, background .2s ease, color .2s ease, border-color .2s ease, opacity .2s ease, box-shadow .2s ease;
      }
      .btn::before {
        content: "";
        position: absolute;
        inset: -4px;
        border-radius: inherit;
        pointer-events: none;
        opacity: 0;
        z-index: -1;
        padding: 2.5px;
        background: conic-gradient(from 0deg, #FF5B00 0 12%, #ffb087 16%, #111 40%, #fff 70%, #FF5B00 100%);
        box-shadow: 0 0 18px rgba(255,91,0,.55);
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
        animation: asoldi-orbit 1.05s linear infinite;
      }
      @keyframes asoldi-orbit { to { transform: rotate(360deg); } }
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
      .mark { width: 18px; height: 18px; flex: 0 0 18px; }
      .check-icon { display: none; }
      .btn[data-status="signed"] .idle-icon { display: none; }
      .btn[data-status="signed"] .check-icon { display: block; }
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        max-width: none;
        max-height: none;
        margin: 0;
        border: 0;
        padding: 24px 16px;
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
        display: flex;
        flex-direction: column;
        width: min(1020px, 100%);
        max-height: min(92dvh, 92vh, 920px);
        min-height: 0;
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
      .close {
        width: 36px; height: 36px; border: 0; border-radius: 8px;
        background: #F3F4F6; color: #111; cursor: pointer; font-size: 20px; line-height: 1;
      }
      .scroller {
        min-height: 0;
        flex: 1 1 auto;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-y;
      }
      .paper {
        margin: 24px auto;
        max-width: 680px;
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
      .foot {
        flex: 0 0 auto;
        max-height: 50%;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        touch-action: pan-y;
        padding: 16px 20px 18px;
        border-top: 1px solid #E5E1D8;
        background: rgba(255,255,255,.95);
      }
      .alts { display: grid; gap: 8px; margin-bottom: 12px; }
      .alt { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid #E5E7EB; border-radius: 12px; cursor: pointer; font-size: 14px; }
      .alt input { margin-top: 3px; }
      .fields { display: grid; gap: 8px; margin-bottom: 10px; }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      label.field { display: grid; gap: 4px; font-size: 12px; color: #6B7280; }
      input[type="text"], input[type="email"], input[type="password"] {
        width: 100%; height: 40px; padding: 0 12px; border: 1px solid #E5E7EB; border-radius: 10px;
        font-size: 14px; color: #111827; background: #fff;
      }
      input[readonly] { background: #F9FAFB; color: #4B5563; }
      .accept { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #111827; margin: 8px 0 12px; }
      .go {
        width: 100%; height: 46px; border: 0; border-radius: 12px;
        background: #FF5B00; color: #fff; font-size: 14px; font-weight: 650; cursor: pointer;
      }
      .go.wait { background: #E5E7EB; color: #9CA3AF; }
      .hint, .err { margin: 8px 0 0; text-align: center; font-size: 12px; }
      .hint { color: #9CA3AF; }
      .err { color: #DC2626; }
      .read-note, .account-note {
        margin: 0 0 10px;
        padding: 11px 12px;
        border-radius: 10px;
        font-size: 13px;
        line-height: 1.45;
        font-weight: 650;
      }
      .read-note {
        background: #FFF4E8;
        border: 1px solid #FFB27A;
        color: #9A3412;
      }
      .read-note.warn {
        background: #FF5B00;
        color: #fff;
        border-color: #C2410C;
        animation: asoldi-warn .7s ease 2;
      }
      .account-note {
        background: #111;
        color: #fff;
        border: 1px solid #111;
        font-weight: 500;
      }
      .account-note strong { color: #FFB27A; }
      @keyframes asoldi-warn {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.02); }
      }
      @media (max-width: 640px) {
        .paper { padding: 28px 20px; }
        .offer-contract-parties, .offer-contract-sign, .pair { grid-template-columns: 1fr; }
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
          <button class="close" type="button" aria-label="Lukk">\u00d7</button>
        </div>
        <div class="scroller">
          <div class="paper"></div>
        </div>
        <div class="foot"></div>
      </div>
    </dialog>
  `;

  const btn = shadow.querySelector('.btn');
  const overlay = shadow.querySelector('.overlay');
  const scroller = shadow.querySelector('.scroller');
  const paper = shadow.querySelector('.paper');
  const foot = shadow.querySelector('.foot');
  let state = { status: 'idle', name: '', email: '', contractHtml: '', alternatives: [], acceptedAt: '' };
  let atBottom = false;
  let chosen = null;
  let busy = false;
  let docking = false;
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
  }

  function isModalOpen() {
    return overlay.classList.contains('open') || overlay.open === true;
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

  function lockPageScroll() {
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
    const page = scroller.clientHeight || 400;
    const delta = event.key === 'ArrowDown' ? 40
      : event.key === 'ArrowUp' ? -40
        : event.key === 'PageDown' || event.key === ' ' ? page
          : event.key === 'PageUp' ? -page
            : event.key === 'Home' ? -scroller.scrollHeight
              : scroller.scrollHeight;
    applyDelta(scroller, delta);
  }

  function finishClose() {
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
  }

  function dockIntoButton() {
    if (docking) return;
    const panel = shadow.querySelector('.panel');
    if (!panel) {
      finishClose();
      return;
    }
    docking = true;
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
    if (fromContractLink && state.status === 'ready') {
      dockIntoButton();
      return;
    }
    finishClose();
  }

  function syncBottom() {
    const reached = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 28;
    atBottom = reached || scroller.scrollHeight <= scroller.clientHeight + 8;
    refreshSubmit();
  }

  function blockReason() {
    const password = String(shadow.querySelector('[name="password"]')?.value || '');
    const needsChoice = Array.isArray(state.alternatives) && state.alternatives.length >= 2;
    if (!atBottom) return 'scroll';
    if (needsChoice && chosen !== 0 && chosen !== 1) return 'choice';
    if (password.length < 8) return 'password';
    return '';
  }

  function refreshSubmit() {
    const submit = shadow.querySelector('.go');
    if (!submit) return;
    submit.classList.toggle('wait', Boolean(blockReason()) || busy);
    const readNote = shadow.querySelector('.read-note');
    if (readNote) {
      readNote.hidden = atBottom;
      if (atBottom) readNote.classList.remove('warn');
    }
  }

  function renderFooter() {
    const alts = Array.isArray(state.alternatives) && state.alternatives.length >= 2 ? state.alternatives : [];
    const nameLocked = Boolean(state.name);
    foot.innerHTML = `
      <p class="read-note">Scroll gjennom hele kontrakten f\u00f8r du trykker Signer. Hvis du ikke har lest ferdig, m\u00e5 du lese resten f\u00f8rst.</p>
      <p class="account-note">For \u00e5 signere m\u00e5 du lage en Asoldi-konto. Passordet du skriver inn blir innloggingen din p\u00e5 asoldi.com.</p>
      ${alts.length ? `<div class="alts">${alts.map((alt) => `
        <label class="alt">
          <input type="radio" name="chosen" value="${alt.index === 1 ? 1 : 0}">
          <span><strong>${escapeHtml(alt.label || '')}</strong>${alt.name ? ` — ${escapeHtml(alt.name)}` : ''}${alt.price ? `<br><small>${escapeHtml(alt.price)}</small>` : ''}</span>
        </label>`).join('')}</div>` : ''}
      <div class="fields">
        <label class="field">Navn
          <input name="name" type="text" value="${escapeAttr(state.name)}" ${nameLocked ? 'readonly' : ''} autocomplete="name">
        </label>
        <div class="pair">
          <label class="field">E-post
            <input name="email" type="email" value="${escapeAttr(state.email)}" readonly autocomplete="email">
          </label>
          <label class="field">Nytt Asoldi-passord
            <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Minst 8 tegn">
          </label>
        </div>
      </div>
      <button class="go wait" type="button">Signer</button>
      <p class="hint">Dette l\u00e5ser deg ikke fast til et samarbeid med oss, men gj\u00f8r det lettere \u00e5 starte arbeidsforholdet.</p>
      <p class="err" hidden></p>
    `;
    foot.querySelectorAll('[name="chosen"]').forEach((input) => {
      input.addEventListener('change', () => {
        chosen = Number(input.value) === 1 ? 1 : 0;
        refreshSubmit();
      });
    });
    foot.querySelector('[name="password"]')?.addEventListener('input', refreshSubmit);
    foot.querySelector('.go')?.addEventListener('click', () => {
      const reason = blockReason();
      const err = shadow.querySelector('.err');
      const readNote = shadow.querySelector('.read-note');
      if (reason) {
        const message = reason === 'scroll'
          ? 'Du m\u00e5 lese hele kontrakten f\u00f8r du kan signere. Scroll ned til bunnen f\u00f8rst.'
          : reason === 'choice'
            ? 'Velg Tilbud 1 eller Tilbud 2 f\u00f8r du signerer.'
            : 'Passordet m\u00e5 v\u00e6re minst 8 tegn. Det blir innloggingen din p\u00e5 asoldi.com.';
        if (err) {
          err.hidden = false;
          err.textContent = message;
        }
        if (reason === 'scroll' && readNote) {
          readNote.hidden = false;
          readNote.classList.add('warn');
          scroller.scrollBy({ top: Math.min(280, Math.max(120, scroller.clientHeight * 0.45)), behavior: 'smooth' });
        }
        return;
      }
      if (err) { err.hidden = true; err.textContent = ''; }
      if (readNote) readNote.classList.remove('warn');
      void submitAccept();
    });
    refreshSubmit();
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
    renderFooter();
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
      setStatus(state.status);
    } catch {
      setStatus('idle');
    }
  }

  async function submitAccept() {
    const submit = shadow.querySelector('.go');
    const err = shadow.querySelector('.err');
    if (!submit || submit.disabled || busy) return;
    busy = true;
    refreshSubmit();
    if (err) { err.hidden = true; err.textContent = ''; }
    try {
      const body = {
        password: String(shadow.querySelector('[name="password"]')?.value || ''),
        name: String(shadow.querySelector('[name="name"]')?.value || ''),
        accepted: true,
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
      closeModal();
    } catch (error) {
      if (err) {
        err.hidden = false;
        err.textContent = error instanceof Error ? error.message : 'Kunne ikke signere.';
      }
    } finally {
      busy = false;
      refreshSubmit();
    }
  }

  btn.addEventListener('click', () => {
    if (state.status === 'ready') openModal();
  });
  shadow.querySelector('.close').addEventListener('click', closeModal);
  overlay.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeModal();
  });
  overlay.addEventListener('close', () => {
    overlay.classList.remove('open');
    overlay.classList.remove('docking');
    unlockPageScroll();
    btn.hidden = false;
    if (fromContractLink && state.status === 'ready') btn.dataset.call = '1';
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal();
  });
  overlay.addEventListener('wheel', trapWheel, { passive: false });
  overlay.addEventListener('touchstart', trapTouchStart, { passive: true });
  overlay.addEventListener('touchmove', trapTouch, { passive: false });
  scroller.addEventListener('scroll', syncBottom, { passive: true });
  window.addEventListener('resize', () => { if (isModalOpen()) syncBottom(); });
  void load().then(() => {
    if (fromContractLink && state.status === 'ready') openModal();
  });
})();
