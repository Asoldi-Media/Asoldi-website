import { API } from '../Admin/shared';
import { LOCAL_EDITOR_ORIGIN } from '../../../lib/maker-editor-origin.js';
import {
  CLICKABLE_QUEUE_TARGETS,
  GREY_QUEUE_TARGETS,
  isClickableQueueTarget,
  summarizeMakerRunForQueue,
} from '../../../lib/maker-queue.js';
import {
  buildPipelineQueuePostBody,
  fetchLocalMakerJson,
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
  return fetchLocalMakerJson('/api/pipeline-queue', { method: 'POST', body });
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
  const run = await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(id)}?poll=1`);
  return {
    run,
    ...summarizeMakerRunForQueue({ ...run, id }),
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
  const run = await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(id)}?poll=1`);
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
