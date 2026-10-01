/** Browser → this computer's Maker. asoldi.com's server cannot reach 127.0.0.1. */

import { LOCAL_EDITOR_ORIGIN } from './maker-editor-origin.js';
import { summarizeMakerRunForQueue } from './maker-queue.js';

export const LOCAL_MAKER_ORIGIN = LOCAL_EDITOR_ORIGIN;

export function makerApiUrl(pathname = '') {
  const raw = String(pathname || '').trim() || '/';
  const suffix = raw.startsWith('/') ? raw : `/${raw}`;
  return `${LOCAL_MAKER_ORIGIN}${suffix}`;
}

export function makerBrowserUnreachableMessage() {
  return `Website Maker is unreachable at ${LOCAL_MAKER_ORIGIN}. Start Docker Maker on port 3000.`;
}

export function buildPipelineQueuePostBody({
  runIds = [],
  salesClientIds = [],
  target,
  untilTarget,
} = {}) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(runIds) ? runIds : []) {
    const runId = String(raw || '').trim();
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    ids.push(runId);
  }
  const salesIds = [];
  const seenSales = new Set();
  for (const raw of Array.isArray(salesClientIds) ? salesClientIds : []) {
    const id = String(raw || '').trim();
    if (!id || seenSales.has(id)) continue;
    seenSales.add(id);
    salesIds.push(id);
  }
  const until = String(untilTarget || '').trim();
  const step = String(target || '').trim();
  return {
    runIds: ids,
    salesClientIds: salesIds,
    ...(until ? { untilTarget: until } : step ? { target: step } : {}),
  };
}

export async function fetchLocalMakerJson(pathname, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(makerApiUrl(pathname), {
      method,
      mode: 'cors',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(makerBrowserUnreachableMessage());
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      String(data.error || data.message || `Website Maker error (${response.status}).`)
    );
  }
  return data;
}

export function summarizeFetchedMakerRun(run = {}, runId = '') {
  const id = String(runId || run?.id || '').trim();
  return {
    run,
    ...summarizeMakerRunForQueue({ ...run, id }),
  };
}
