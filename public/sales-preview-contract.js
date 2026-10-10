(function salesPreviewContractWidget() {
  const script = document.currentScript
    || document.querySelector('script[src*="sales-preview-contract.js"][data-sales-client-id]');
  const clientId = String(script?.getAttribute('data-sales-client-id') || '').trim();
  if (!clientId || document.querySelector('[data-asoldi-preview-contract]')) return;

  const api = `/api/public/sales-preview/${encodeURIComponent(clientId)}/contract`;
  const host = document.createElement('div');
  host.setAttribute('data-asoldi-preview-contract', '');
  document.documentElement.appendChild(host);
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
        overflow: hidden;
        white-space: nowrap;
        box-shadow: 0 8px 28px rgba(0,0,0,.28);
        transition: min-width .25s ease, background .2s ease, color .2s ease, border-color .2s ease, opacity .2s ease;
      }
      .btn[data-status="idle"] {
        background: #9CA3AF;
        border-color: #D1D5DB;
        color: #F9FAFB;
        cursor: default;
        opacity: .72;
      }
      .btn[data-status="ready"]:hover,
      .btn[data-status="ready"]:focus-visible {
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
      .btn[data-status="ready"]:hover .btn-label,
      .btn[data-status="ready"]:focus-visible .btn-label {
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
        padding: 24px 16px;
        background: rgba(0,0,0,.5);
      }
      .overlay.open { display: flex; }
      .panel {
        display: flex;
        flex-direction: column;
        width: min(720px, 100%);
        max-height: min(92vh, 920px);
        overflow: hidden;
        border-radius: 16px;
        background: #EFECE4;
        box-shadow: 0 24px 80px rgba(0,0,0,.35);
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
      .scroller { min-height: 0; flex: 1; overflow-y: auto; }
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
      .foot { flex: 0 0 auto; padding: 16px 20px 18px; border-top: 1px solid #E5E1D8; background: rgba(255,255,255,.95); }
      .alts { display: grid; gap: 8px; margin-bottom: 12px; }
      .alt { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid #E5E7EB; border-radius: 12px; cursor: pointer; font-size: 14px; }
      .alt input { margin-top: 3px; }
      .fields { display: grid; gap: 8px; margin-bottom: 10px; }
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
      .go:disabled { background: #E5E7EB; color: #9CA3AF; cursor: not-allowed; }
      .hint, .err { margin: 8px 0 0; text-align: center; font-size: 12px; }
      .hint { color: #9CA3AF; }
      .err { color: #DC2626; }
      @media (max-width: 640px) {
        .paper { padding: 28px 20px; }
        .offer-contract-parties, .offer-contract-sign { grid-template-columns: 1fr; }
      }
    </style>
    <button class="btn" type="button" data-status="idle" aria-label="Kontrakt">
      <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path class="idle-icon" d="M7 4h10a1 1 0 0 1 1 1v15l-6-3-6 3V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.7"/>
        <path class="check-icon" d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="btn-label">Signer kontrakt</span>
    </button>
    <div class="overlay" hidden>
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="asoldi-contract-title">
        <div class="head">
          <h2 id="asoldi-contract-title">Kontrakt</h2>
          <button class="close" type="button" aria-label="Lukk">\u00d7</button>
        </div>
        <div class="scroller">
          <div class="paper"></div>
        </div>
        <div class="foot"></div>
      </div>
    </div>
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

  function setStatus(status) {
    state.status = status;
    btn.dataset.status = status;
    btn.setAttribute('aria-label', status === 'signed' ? 'Kontrakt signert' : status === 'ready' ? 'Signer kontrakt' : 'Kontrakt');
  }

  function closeModal() {
    overlay.classList.remove('open');
    overlay.hidden = true;
    btn.hidden = false;
  }

  function syncBottom() {
    const reached = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 28;
    atBottom = reached || scroller.scrollHeight <= scroller.clientHeight + 8;
    refreshSubmit();
  }

  function refreshSubmit() {
    const submit = shadow.querySelector('.go');
    const hint = shadow.querySelector('.hint');
    if (!submit) return;
    const password = String(shadow.querySelector('[name="password"]')?.value || '');
    const accepted = Boolean(shadow.querySelector('[name="accepted"]')?.checked);
    const needsChoice = Array.isArray(state.alternatives) && state.alternatives.length >= 2;
    const can = atBottom && accepted && password.length >= 8 && (!needsChoice || chosen === 0 || chosen === 1);
    submit.disabled = !can || busy;
    if (hint) {
      hint.textContent = !atBottom
        ? 'Bla til bunnen av avtalen for \u00e5 akseptere.'
        : needsChoice && chosen !== 0 && chosen !== 1
          ? 'Velg Tilbud 1 eller Tilbud 2 f\u00f8r du aksepterer.'
          : '';
    }
  }

  function renderFooter() {
    const alts = Array.isArray(state.alternatives) && state.alternatives.length >= 2 ? state.alternatives : [];
    const nameLocked = Boolean(state.name);
    foot.innerHTML = `
      ${alts.length ? `<div class="alts">${alts.map((alt) => `
        <label class="alt">
          <input type="radio" name="chosen" value="${alt.index === 1 ? 1 : 0}">
          <span><strong>${escapeHtml(alt.label || '')}</strong>${alt.name ? ` — ${escapeHtml(alt.name)}` : ''}${alt.price ? `<br><small>${escapeHtml(alt.price)}</small>` : ''}</span>
        </label>`).join('')}</div>` : ''}
      <div class="fields">
        <label class="field">Navn
          <input name="name" type="text" value="${escapeAttr(state.name)}" ${nameLocked ? 'readonly' : ''} autocomplete="name">
        </label>
        <label class="field">E-post
          <input name="email" type="email" value="${escapeAttr(state.email)}" readonly autocomplete="email">
        </label>
        <label class="field">Passord
          <input name="password" type="password" minlength="8" autocomplete="new-password">
        </label>
      </div>
      <label class="accept">
        <input name="accepted" type="checkbox">
        <span>Jeg aksepterer denne kontrakten</span>
      </label>
      <button class="go" type="button" disabled>Fortsett</button>
      <p class="hint"></p>
      <p class="err" hidden></p>
    `;
    foot.querySelectorAll('[name="chosen"]').forEach((input) => {
      input.addEventListener('change', () => {
        chosen = Number(input.value) === 1 ? 1 : 0;
        refreshSubmit();
      });
    });
    foot.querySelector('[name="password"]')?.addEventListener('input', refreshSubmit);
    foot.querySelector('[name="accepted"]')?.addEventListener('change', refreshSubmit);
    foot.querySelector('.go')?.addEventListener('click', () => { void submitAccept(); });
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
    paper.innerHTML = state.contractHtml || '<p>Kontraktteksten kommer når tilbudet er sendt.</p>';
    chosen = null;
    renderFooter();
    overlay.hidden = false;
    overlay.classList.add('open');
    btn.hidden = true;
    scroller.scrollTop = 0;
    requestAnimationFrame(syncBottom);
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
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModal();
  });
  scroller.addEventListener('scroll', syncBottom, { passive: true });
  window.addEventListener('resize', syncBottom);
  void load();
})();
