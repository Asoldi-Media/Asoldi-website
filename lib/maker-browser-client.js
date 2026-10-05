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

export function canThisPageFetchLocalMaker(hostname = '') {
  const host = String(hostname || (typeof window !== 'undefined' ? window.location.hostname : '')).trim();
  return asoldiPageIsOnThisComputer(host);
}

export function makerBrowserUnreachableMessage() {
  return `Website Creator svarer ikke på ${LOCAL_MAKER_ORIGIN}. Start Docker Maker på denne PC-en (make dev-up i website-maker). Ikke bruk localhost:3000 — på Windows treffer det WSL, ikke Maker.`;
}

export function makerPublicPageCannotFetchMessage() {
  return 'Open Website Creator in a new tab. This asoldi.com page cannot fetch the Maker on this computer.';
}

export async function pingLocalMaker({ timeoutMs = 15000 } = {}) {
  if (!canThisPageFetchLocalMaker()) return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 15000))
    : null;
  try {
    const response = await fetch(makerHealthUrl(), {
      method: 'GET',
      mode: 'cors',
      targetAddressSpace: 'loopback',
      ...(controller ? { signal: controller.signal } : {}),
    });
    // Any HTTP answer means Docker Maker is listening. Next can take >8s
    // to compile /api/health while a run tab is polling.
    if (!response.ok) return response.status > 0;
    const data = await response.json().catch(() => ({}));
    return data?.ok === true || response.status < 500;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForLocalMaker({ attempts = 4, timeoutMs = 15000 } = {}) {
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

export async function fetchLocalMakerJson(pathname, { method = 'GET', body, timeoutMs } = {}) {
  if (!canThisPageFetchLocalMaker()) {
    throw new Error(makerPublicPageCannotFetchMessage());
  }
  let response;
  const limit = Number(timeoutMs);
  const controller = typeof AbortController === 'function' && Number.isFinite(limit) && limit > 0
    ? new AbortController()
    : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(500, limit)) : null;
  try {
    response = await fetch(makerApiUrl(pathname), {
      method,
      mode: 'cors',
      targetAddressSpace: 'loopback',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    throw new Error(makerBrowserUnreachableMessage());
  } finally {
    if (timer) clearTimeout(timer);
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
