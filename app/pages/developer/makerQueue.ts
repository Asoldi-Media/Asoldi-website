import { API } from '../Admin/shared';
import {
  CLICKABLE_QUEUE_TARGETS,
  GREY_QUEUE_TARGETS,
  isClickableQueueTarget,
} from '../../../lib/maker-queue.js';

export { CLICKABLE_QUEUE_TARGETS, GREY_QUEUE_TARGETS, isClickableQueueTarget };

export type MakerQueueAuthHeaders = Record<string, string>;

export type EnqueueMakerQueueInput = {
  websiteMakerBaseUrl: string;
  salesClientIds?: string[];
  runIds?: string[];
  target: string;
  authHeaders: MakerQueueAuthHeaders;
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
    websiteMakerBaseUrl: String(input.websiteMakerBaseUrl || '').trim(),
    businessName: String(input.businessName || '').trim(),
  });
}

async function parseMakerProxy(response: Response) {
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
  websiteMakerBaseUrl,
  salesClientIds = [],
  runIds = [],
  target,
  authHeaders,
}: EnqueueMakerQueueInput) {
  const response = await fetch(`${API}/admin/development/maker-queue`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ websiteMakerBaseUrl, salesClientIds, runIds, target }),
  });
  return parseMakerProxy(response);
}

export async function fetchMakerQueue(websiteMakerBaseUrl: string, authHeaders: MakerQueueAuthHeaders) {
  const url = new URL(`${API}/admin/development/maker-queue`, window.location.origin);
  url.searchParams.set('websiteMakerBaseUrl', websiteMakerBaseUrl);
  const response = await fetch(`${url.pathname}${url.search}`, { headers: authHeaders });
  return parseMakerProxy(response);
}

export async function cancelMakerQueueItem(
  websiteMakerBaseUrl: string,
  itemId: string,
  authHeaders: MakerQueueAuthHeaders
) {
  const url = new URL(`${API}/admin/development/maker-queue`, window.location.origin);
  url.searchParams.set('websiteMakerBaseUrl', websiteMakerBaseUrl);
  url.searchParams.set('itemId', itemId);
  const response = await fetch(`${url.pathname}${url.search}`, { method: 'DELETE', headers: authHeaders });
  return parseMakerProxy(response);
}

export async function fetchMakerRunStatus(
  websiteMakerBaseUrl: string,
  runId: string,
  authHeaders: MakerQueueAuthHeaders
) {
  const url = new URL(
    `${API}/admin/development/maker-run/${encodeURIComponent(runId)}`,
    window.location.origin
  );
  url.searchParams.set('websiteMakerBaseUrl', websiteMakerBaseUrl);
  const response = await fetch(`${url.pathname}${url.search}`, { headers: authHeaders });
  return parseMakerProxy(response);
}
