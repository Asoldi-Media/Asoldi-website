/** Browser → this computer's Maker. asoldi.com's server cannot reach 127.0.0.1. */

import { LOCAL_EDITOR_ORIGIN } from './maker-editor-origin.js';
import { summarizeMakerRunForQueue } from './maker-queue.js';

export const LOCAL_MAKER_ORIGIN = LOCAL_EDITOR_ORIGIN;

export function makerApiUrl(pathname = '') {
  const raw = String(pathname || '').trim() || '/';
  const suffix = raw.startsWith('/') ? raw : `/${raw}`;
  return `${LOCAL_MAKER_ORIGIN}${suffix}`;
}

export function makerHealthUrl() {
  return makerApiUrl('/api/health');
}

export function asoldiPageIsOnThisComputer(hostname = '') {
  const host = String(hostname || '').trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

export function makerBrowserUnreachableMessage() {
  return `Website Creator svarer ikke på ${LOCAL_MAKER_ORIGIN}. Start Docker Maker på denne PC-en (make dev-up i website-maker). Ikke bruk localhost:3000 — på Windows treffer det WSL, ikke Maker.`;
}

export async function pingLocalMaker({ timeoutMs = 4000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 4000))
    : null;
  try {
    const response = await fetch(makerHealthUrl(), {
      method: 'GET',
      mode: 'cors',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    return data?.ok === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForLocalMaker({ attempts = 3, timeoutMs = 4000 } = {}) {
  const total = Math.max(1, Number(attempts) || 3);
  for (let i = 0; i < total; i += 1) {
    if (await pingLocalMaker({ timeoutMs })) return true;
    if (i < total - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  return false;
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
