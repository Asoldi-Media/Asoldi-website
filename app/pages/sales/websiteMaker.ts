import { useEffect, useState } from 'react';
import { editorMakerOrigin, LOCAL_EDITOR_ORIGIN, makerOriginsMatch } from '../../../lib/maker-editor-origin.js';

export const MAKER_BASE_URL_STORAGE_KEY = 'asoldi.sales.websiteMakerBaseUrl.v1';
export const LAN_MAKER_URL = 'http://192.168.68.92:3000';
export const PUBLIC_SALES_URL = 'https://asoldi.com';
export const LOCAL_MAKER_URL = LOCAL_EDITOR_ORIGIN;

export function normalizeHttpBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw);
  const looksLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw);
  const withProtocol = hasProtocol ? raw : `${looksLocal ? 'http' : 'https'}://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export function healStaleLocalMakerBase(value = '') {
  const normalized = normalizeHttpBaseUrl(value);
  if (!normalized) return '';
  return normalized.replace(
    /^(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)):(?:4000|3001|5173)(?=$)/i,
    '$1:3000'
  );
}

export function isPrivateMakerHost(value = '') {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[0-1])\./i.test(
    String(value || '')
  );
}

export function clientHasPublicPreviewSnapshot(client: { websiteImport?: { importRoot?: string; publicUrl?: string; importedAt?: string } | null } | null | undefined) {
  return Boolean(
    String(client?.websiteImport?.importRoot || '').trim() ||
      String(client?.websiteImport?.publicUrl || '').trim() ||
      String(client?.websiteImport?.importedAt || '').trim()
  );
}

export function tunnelPopupMakerOrigin(fieldUrl = '') {
  const origin = normalizeHttpBaseUrl(fieldUrl);
  if (!origin) return LOCAL_MAKER_URL;
  return isPrivateMakerHost(origin) ? origin : LOCAL_MAKER_URL;
}

export function openMakerTunnelPopup(makerBase: string): Promise<string> {
  const tunnelHost = tunnelPopupMakerOrigin(makerBase);
  const popupUrl = new URL('/local-tunnel', tunnelHost);
  popupUrl.searchParams.set('returnOrigin', window.location.origin);
  popupUrl.searchParams.set('targetUrl', LOCAL_MAKER_URL);
  popupUrl.searchParams.set('forceRestart', '0');
  const popup = window.open(popupUrl.toString(), 'asoldi-maker-local-tunnel', 'width=620,height=740');
  if (!popup) {
    return Promise.reject(new Error('Popup blocked. Allow popups and try again.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeoutId);
      window.clearInterval(closeWatcherId);
    };
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler();
    };
    const timeoutId = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Timed out waiting for tunnel setup. Start Website Maker on this computer (${LOCAL_MAKER_URL}) or on the office Docker host (${LAN_MAKER_URL}), then try again.`
          )
        )
      );
    }, 300_000);
    const closeWatcherId = window.setInterval(() => {
      if (!popup.closed) return;
      finish(() => reject(new Error('Tunnel popup was closed before completion.')));
    }, 450);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== tunnelHost) return;
      const payload = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null;
      if (!payload) return;
      if (payload.type === 'asoldi-maker-tunnel-error') {
        finish(() => reject(new Error(String(payload.message || 'Failed starting local tunnel.'))));
        return;
      }
      if (payload.type === 'asoldi-maker-tunnel-ready') {
        const next = normalizeHttpBaseUrl(String(payload.tunnelUrl || ''));
        if (!next) {
          finish(() => reject(new Error('Local tunnel returned an invalid URL.')));
          return;
        }
        finish(() => resolve(next));
      }
    };
    window.addEventListener('message', onMessage);
  });
}

export function getPublicPreviewHref(clientId = '') {
  const id = String(clientId || '').trim();
  if (!id) return '';
  return `${PUBLIC_SALES_URL}/sales-preview/${encodeURIComponent(id)}/`;
}

export function getPublicClientPreviewUrl(client: { id?: string; websiteImport?: { publicUrl?: string } | null }) {
  const id = String(client?.id || '').trim();
  const stored = String(client.websiteImport?.publicUrl || '').trim();
  if (id && stored.includes(id)) return stored.endsWith('/') ? stored : `${stored}/`;
  return getPublicPreviewHref(id);
}

export function buildMakerRunUrl(
  baseUrl = '',
  runId = '',
  mode: 'dashboard' | 'preview' | 'intake' = 'dashboard',
  previewStep = '',
) {
  const base = healStaleLocalMakerBase(baseUrl) || normalizeHttpBaseUrl(baseUrl);
  const id = String(runId || '').trim();
  if (!base || !id) return '';
  if (mode === 'preview') {
    const step = String(previewStep || '').trim();
    if (!step) return '';
    if (step === 'custom') return `${base}/preview/${encodeURIComponent(id)}/custom/view?route=/`;
    return `${base}/preview/${encodeURIComponent(id)}/step/${encodeURIComponent(step)}/view?route=/`;
  }
  if (mode === 'intake') return `${base}/run-v2?draftRunId=${encodeURIComponent(id)}`;
  return `${base}/run/${encodeURIComponent(id)}`;
}

export function extractMakerRunIdFromUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://asoldi.local');
    const draftId = String(url.searchParams.get('draftRunId') || '').trim();
    if (draftId) return draftId;
    const path = String(url.pathname || '');
    const preview = path.match(
      /^\/preview\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i,
    );
    if (preview) return preview[1];
    const runPage = path.match(
      /^\/run\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i,
    );
    if (runPage) return runPage[1];
  } catch {
    return '';
  }
  return '';
}

export function storedMakerUrlBelongsToRun(storedUrl = '', runId = '') {
  const id = String(runId || '').trim().toLowerCase();
  const extracted = extractMakerRunIdFromUrl(storedUrl).toLowerCase();
  return Boolean(id && extracted && extracted === id);
}

export function remapMakerUrlToBase(baseUrl = '', absoluteUrl = '') {
  const base = normalizeHttpBaseUrl(baseUrl);
  const raw = String(absoluteUrl || '').trim();
  if (!base || !raw) return '';
  try {
    const source = new URL(raw);
    if (source.protocol !== 'http:' && source.protocol !== 'https:') return '';
    const suffix = `${source.pathname || ''}${source.search || ''}${source.hash || ''}`;
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return `${base}${normalizedSuffix}`;
  } catch {
    return '';
  }
}

export function normalizeMakerDashboardDraftUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const rewrite = (url: URL) => {
    if (url.pathname !== '/run-v2') return false;
    if (!url.searchParams.get('draftRunId')) return false;
    url.searchParams.delete('__chunk_retry');
    return true;
  };

  try {
    const parsed = new URL(raw);
    if (!rewrite(parsed)) return raw;
    return parsed.toString();
  } catch {
    try {
      const relative = new URL(raw, 'https://asoldi.local');
      if (!rewrite(relative)) return raw;
      return `${relative.pathname}${relative.search}${relative.hash}`;
    } catch {
      return raw;
    }
  }
}

export function resolveOpenInMakerUrl({
  baseUrl = '',
  runId = '',
  storedDashboardUrl = '',
  intakeStatus = '',
  latestReadyStep = '',
}: {
  baseUrl?: string;
  runId?: string;
  storedDashboardUrl?: string;
  intakeStatus?: string;
  latestReadyStep?: string;
}) {
  const id = String(runId || '').trim();
  const base = healStaleLocalMakerBase(baseUrl) || LAN_MAKER_URL;
  if (!id) return '';
  const storedRaw = String(storedDashboardUrl || '').trim();
  const stored = storedMakerUrlBelongsToRun(storedRaw, id) ? storedRaw : '';
  const status = String(intakeStatus || '').trim().toLowerCase();
  const storedLooksLikeIntake = /\/run-v2(?:\?|$)/i.test(stored) && /[?&]draftRunId=/i.test(stored);
  const storedLooksLikeRun = /\/run\/[^/?#]+/i.test(stored) && !storedLooksLikeIntake;
  const hasReadyStep = Boolean(String(latestReadyStep || '').trim());
  if (status === 'configured' || hasReadyStep || storedLooksLikeRun) {
    if (storedLooksLikeRun) {
      const remapped = remapMakerUrlToBase(base, stored);
      if (remapped) return normalizeMakerDashboardDraftUrl(remapped);
    }
    return buildMakerRunUrl(base, id, 'dashboard');
  }
  if (status === 'pending' || storedLooksLikeIntake) {
    return buildMakerRunUrl(base, id, 'intake');
  }
  if (stored) {
    const remapped = remapMakerUrlToBase(base, stored);
    if (remapped) return normalizeMakerDashboardDraftUrl(remapped);
  }
  return buildMakerRunUrl(base, id, 'dashboard');
}

export function resolveMakerPreviewUrl({
  baseUrl = '',
  runId = '',
  storedPreviewUrl = '',
  latestReadyStep = '',
  customSiteExists = false,
}: {
  baseUrl?: string;
  runId?: string;
  storedPreviewUrl?: string;
  latestReadyStep?: string;
  customSiteExists?: boolean;
}) {
  const makerRunId = String(runId || '').trim();
  const base = healStaleLocalMakerBase(baseUrl) || normalizeHttpBaseUrl(baseUrl);
  if (!base || !makerRunId) return '';
  const step = String(latestReadyStep || '').trim();
  if (customSiteExists || step === 'custom') {
    return `${base}/preview/${encodeURIComponent(makerRunId)}/custom/view?route=/`;
  }
  if (step) return buildMakerRunUrl(base, makerRunId, 'preview', step);
  const stored = String(storedPreviewUrl || '').trim();
  if (storedMakerUrlBelongsToRun(stored, makerRunId) && !/\/step\/3(?:\/|$)/i.test(stored)) {
    return remapMakerUrlToBase(base, stored) || '';
  }
  return '';
}

export function openMakerCreatePopup(makerBase = LOCAL_EDITOR_ORIGIN): Window | null {
  const origin = normalizeHttpBaseUrl(makerBase) || LOCAL_EDITOR_ORIGIN;
  const popupUrl = new URL('/sales-create-run', origin);
  try {
    popupUrl.searchParams.set('returnOrigin', window.location.origin);
  } catch {
    // Open Maker anyway; the create page can still announce without a return origin.
  }
  // Same as preview: a normal tab. A sized popup is blocked on asoldi.com.
  return window.open(popupUrl.toString(), '_blank');
}

export async function createRunViaMakerPopup(
  makerBase: string,
  requestBody: Record<string, unknown>,
  existingPopup?: Window | null
): Promise<{ runId: string; handoff: Record<string, unknown> }> {
  const makerOrigin = normalizeHttpBaseUrl(makerBase);
  if (!makerOrigin) {
    throw new Error('Website Maker URL is invalid.');
  }
  const popupUrl = new URL('/sales-create-run', makerOrigin);
  popupUrl.searchParams.set('returnOrigin', window.location.origin);
  try {
    const encoded = encodeURIComponent(JSON.stringify(requestBody || {}));
    if (encoded.length < 50000) popupUrl.hash = `p=${encoded}`;
  } catch {
    // Fall back to postMessage if the payload cannot be hashed.
  }
  const popup = existingPopup && !existingPopup.closed ? existingPopup : openMakerCreatePopup();
  if (!popup) {
    throw new Error('Popup blocked. Allow popups for this site and try Create run again.');
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeoutId);
      window.clearInterval(closeWatcherId);
    };
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler();
    };
    const timeoutId = window.setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Timed out creating the run at ${makerOrigin}. Website Maker was still compiling that page. Wait a moment and try again.`
          )
        )
      );
    }, 180_000);
    const closeWatcherId = window.setInterval(() => {
      if (!popup.closed) return;
      finish(() => reject(new Error('The Website Maker popup was closed before the run was created.')));
    }, 450);

    const onMessage = (event: MessageEvent) => {
      if (!makerOriginsMatch(event.origin, makerOrigin)) return;
      const payload = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null;
      if (!payload) return;
      if (payload.type === 'asoldi-sales-create-run-listening') {
        popup.postMessage({ type: 'asoldi-sales-create-run', requestBody }, makerOrigin);
        return;
      }
      if (payload.type === 'asoldi-sales-create-run-error') {
        finish(() => reject(new Error(String(payload.message || 'Failed creating website run.'))));
        return;
      }
      if (payload.type === 'asoldi-sales-create-run-ready') {
        const runId = String(payload.runId || '').trim();
        if (!runId) {
          finish(() => reject(new Error('Website Maker did not return a runId.')));
          return;
        }
        const handoff =
          payload.handoff && typeof payload.handoff === 'object'
            ? (payload.handoff as Record<string, unknown>)
            : {};
        finish(() => resolve({ runId, handoff }));
      }
    };

    window.addEventListener('message', onMessage);
    try {
      popup.location.href = popupUrl.toString();
    } catch {
      finish(() => reject(new Error('Could not open Website Maker. Allow popups for this site and try Create run again.')));
    }
  });
}

export function useWebsiteMakerBaseUrl() {
  const [websiteMakerBaseUrl, setWebsiteMakerBaseUrl] = useState(LOCAL_EDITOR_ORIGIN);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(MAKER_BASE_URL_STORAGE_KEY);
      if (!stored) return;
      const normalized = editorMakerOrigin(healStaleLocalMakerBase(stored) || stored);
      if (normalized) setWebsiteMakerBaseUrl(normalized);
    } catch {
      // Ignore storage access issues.
    }
  }, []);

  useEffect(() => {
    const normalized = editorMakerOrigin(websiteMakerBaseUrl);
    if (!normalized) return;
    if (normalized !== websiteMakerBaseUrl) {
      setWebsiteMakerBaseUrl(normalized);
      return;
    }
    try {
      window.localStorage.setItem(MAKER_BASE_URL_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage access issues.
    }
  }, [websiteMakerBaseUrl]);

  return { websiteMakerBaseUrl, setWebsiteMakerBaseUrl };
}
