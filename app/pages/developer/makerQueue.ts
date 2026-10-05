import { API, developmentAuthHeaders } from '../Admin/shared';
import { LOCAL_EDITOR_ORIGIN } from '../../../lib/maker-editor-origin.js';
import {
  CLICKABLE_QUEUE_TARGETS,
  GREY_QUEUE_TARGETS,
  isClickableQueueTarget,
  summarizeMakerRunForQueue,
} from '../../../lib/maker-queue.js';
import {
  asoldiPageIsOnThisComputer,
  buildPipelineQueuePostBody,
  fetchLocalMakerJson,
  makerBrowserUnreachableMessage,
  waitForLocalMaker,
} from '../../../lib/maker-browser-client.js';

export { CLICKABLE_QUEUE_TARGETS, GREY_QUEUE_TARGETS, isClickableQueueTarget };

export const DEVELOPER_MAKER_ORIGIN = LOCAL_EDITOR_ORIGIN;

export type MakerQueueAuthHeaders = Record<string, string>;

export type EnqueueMakerQueueInput = {
  websiteMakerBaseUrl?: string;
  salesClientIds?: string[];
  runIds?: string[];
  target?: string;
  untilTarget?: string;
  authHeaders?: MakerQueueAuthHeaders;
};

export type LanguageLockOpenInput = {
  runId: string;
  websiteMakerBaseUrl?: string;
  businessName?: string;
};

type LanguageLockOpener = (input: LanguageLockOpenInput) => void;

let languageLockOpener: LanguageLockOpener | null = null;

export function registerLanguageLockOpener(opener: LanguageLockOpener | null) {
  languageLockOpener = opener;
}

export function openLanguageLock(input: LanguageLockOpenInput) {
  const runId = String(input?.runId || '').trim();
  if (!runId) {
    throw new Error('Run ID is required to lock language.');
  }
  if (!languageLockOpener) {
    throw new Error('Language lock popup is not mounted.');
  }
  languageLockOpener({
    runId,
    websiteMakerBaseUrl: DEVELOPER_MAKER_ORIGIN,
    businessName: String(input.businessName || '').trim(),
  });
}

async function parseAsoldiJson(response: Response) {
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(
      String(
        (data as { message?: string; error?: string }).message
          || (data as { message?: string; error?: string }).error
          || `Request failed (${response.status})`
      )
    );
  }
  return data;
}

export async function enqueueMakerQueue({
  salesClientIds = [],
  runIds = [],
  target,
  untilTarget,
}: EnqueueMakerQueueInput) {
  const body = buildPipelineQueuePostBody({
    runIds,
    salesClientIds,
    target,
    untilTarget,
  });
  if (!body.runIds.length) {
    throw new Error('No Website Maker run is linked.');
  }
  if (typeof window !== 'undefined' && !asoldiPageIsOnThisComputer(window.location.hostname)) {
    return enqueueMakerQueueViaTab(body);
  }
  return fetchLocalMakerJson('/api/pipeline-queue', { method: 'POST', body });
}

async function enqueueMakerQueueViaTab(body: ReturnType<typeof buildPipelineQueuePostBody>) {
  const popupUrl = new URL('/asoldi-queue', DEVELOPER_MAKER_ORIGIN);
  popupUrl.searchParams.set('returnOrigin', window.location.origin);
  try {
    const encoded = encodeURIComponent(JSON.stringify(body || {}));
    if (encoded.length < 50000) popupUrl.hash = `p=${encoded}`;
  } catch {
    // postMessage fallback if the payload cannot be hashed.
  }
  const popup = window.open(popupUrl.toString(), '_blank');
  if (!popup) {
    throw new Error('Popup blocked. Allow popups for this site and try again.');
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeoutId);
      handler();
    };
    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error('Timed out talking to Website Creator. Leave the Maker tab open and try again.')));
    }, 180_000);
    const onMessage = (event: MessageEvent) => {
      const payload = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : null;
      if (!payload) return;
      if (payload.type === 'asoldi-queue-listening') {
        popup.postMessage({ type: 'asoldi-queue', body }, event.origin);
        return;
      }
      if (payload.type === 'asoldi-queue-error') {
        finish(() => reject(new Error(String(payload.message || 'Could not queue the Maker step.'))));
        return;
      }
      if (payload.type === 'asoldi-queue-ready') {
        finish(() => resolve(payload.data && typeof payload.data === 'object' ? payload.data : { ok: true }));
      }
    };
    window.addEventListener('message', onMessage);
  });
}

export async function ensureLocalMaker() {
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  if (!asoldiPageIsOnThisComputer(hostname)) {
    return { ok: true, viaTab: true };
  }
  if (await waitForLocalMaker({ attempts: 1, timeoutMs: 2500 })) {
    return { ok: true, alreadyRunning: true };
  }
  const response = await fetch(`${API}/admin/development/maker/ensure`, {
    method: 'POST',
    headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({} as { ok?: boolean; message?: string }));
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.message || makerBrowserUnreachableMessage()));
  }
  if (await waitForLocalMaker({ attempts: 8, timeoutMs: 15000 })) return { ok: true, started: true };
  throw new Error('Website Creator startet, men svarer ikke på http://127.0.0.1:3000 ennå.');
}

export async function fetchMakerQueue(
  _websiteMakerBaseUrl = DEVELOPER_MAKER_ORIGIN,
  _authHeaders?: MakerQueueAuthHeaders
) {
  return fetchLocalMakerJson('/api/pipeline-queue');
}

export async function cancelMakerQueueItem(
  _websiteMakerBaseUrl: string,
  itemId: string,
  _authHeaders?: MakerQueueAuthHeaders
) {
  const id = String(itemId || '').trim();
  if (!id) throw new Error('itemId is required.');
  return fetchLocalMakerJson(`/api/pipeline-queue?itemId=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchMakerRunStatus(
  _websiteMakerBaseUrl: string,
  runId: string,
  _authHeaders?: MakerQueueAuthHeaders
) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('Run ID is required.');
  const run = await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(id)}?poll=1&adopt=0`);
  return {
    run,
    ...summarizeMakerRunForQueue({ ...run, id }),
  };
}

export async function findMakerRunBySalesClientId(
  salesClientId: string,
  businessName = ''
) {
  const id = String(salesClientId || '').trim();
  if (!id) return null;
  const params = new URLSearchParams({ salesClientId: id });
  const name = String(businessName || '').trim();
  if (name) params.set('businessName', name);
  const data = await fetchLocalMakerJson(`/api/runs?${params.toString()}`) as {
    runId?: string;
    steps?: Record<string, unknown>;
    intakeStatus?: string;
    languageConfirmed?: boolean;
    customSiteExists?: boolean;
    progressScore?: number;
  };
  const runId = String(data.runId || '').trim();
  if (!runId) return null;
  return {
    runId,
    steps: data.steps && typeof data.steps === 'object' ? data.steps : {},
    intakeStatus: String(data.intakeStatus || '').trim(),
    languageConfirmed: Boolean(data.languageConfirmed),
    customSiteExists: Boolean(data.customSiteExists),
    progressScore: Number(data.progressScore) || 0,
  };
}

export async function saveMakerRunDomain({
  runId,
  websiteDomain,
  salesClientId,
  authHeaders,
}: {
  runId: string;
  websiteDomain: string;
  salesClientId?: string;
  authHeaders: MakerQueueAuthHeaders;
}) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('Run ID is required.');
  await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(id)}/save-intake`, {
    method: 'POST',
    body: { answers: { websiteDomain: String(websiteDomain || '').trim() } },
  });
  const run = await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(id)}?poll=1&adopt=0`);
  const summary = summarizeMakerRunForQueue({ ...run, id });
  const clientId = String(salesClientId || '').trim();
  if (!clientId) return { ok: true, run, ...summary };
  const response = await fetch(
    `${API}/admin/development/maker-run/${encodeURIComponent(id)}/domain`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        websiteDomain: String(websiteDomain || '').trim(),
        salesClientId: clientId,
        makerSaved: true,
      }),
    }
  );
  const data = await parseAsoldiJson(response) as Record<string, unknown>;
  return { ...summary, ...data, run: data.run || run };
}
