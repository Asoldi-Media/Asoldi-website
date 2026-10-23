/**
 * Maker -> hub callback `run.ai.spend` (POST /api/admin/sales/maker-status-callback, Maker callback
 * token, after the handler's linked-run check). The Maker sends its run's AI spend after each pipeline
 * target: { event: 'run.ai.spend', runId, salesClientId, totalUsd, byTask: { <task>: usd }, calls?, profile?, at }.
 * `at` (the snapshot time) is required: the newest snapshot per run wins, so it orders retries.
 *
 * Stored on the client as makerRun.aiSpend (data/sales.js setSalesMakerRunAiSpend, the key's only writer)
 * and kept per run in <dataDir>/ai/maker-spend.json, so a client's spend survives a new run.
 * GET /api/admin/ai/spend?salesClientId= adds it to the hub ledger.
 */
import { getPersistentDataDir } from '../../data/storage-path.js';
import { hubLlmRegistered } from '../llm-hooks.js';
import { createHubLedger } from './ledger.js';

let fallbackLedger = null;
function ledgerForCallbacks() {
  const facadeLedger = hubLlmRegistered()?.ledger;
  if (facadeLedger?.recordMakerSpend) return facadeLedger;
  if (!fallbackLedger) fallbackLedger = createHubLedger({ dataDir: getPersistentDataDir() });
  return fallbackLedger;
}

function spendFromBody(body = {}) {
  const nested = body?.aiSpend && typeof body.aiSpend === 'object' && !Array.isArray(body.aiSpend) ? body.aiSpend : null;
  const source = nested || body || {};
  return {
    totalUsd: source.totalUsd,
    byTask: source.byTask,
    calls: source.calls,
    profile: source.profile,
    at: source.at,
  };
}

/**
 * @param {{ sales: { setSalesMakerRunAiSpend: Function }, client: object, runId: string, body: object, ledger?: object }} input
 * @returns {{ status: number, body: object }}
 */
export function applyRunAiSpendCallback({ sales, client, runId, body = {}, ledger = null }) {
  const raw = { ...spendFromBody(body), runId: String(runId || '').trim() };
  const result = sales.setSalesMakerRunAiSpend(client.id, raw);
  if (result.reason === 'invalid') {
    return { status: 400, body: { ok: false, event: 'run.ai.spend', message: 'run.ai.spend needs totalUsd or byTask with amounts in USD.' } };
  }
  if (result.reason === 'missing-at') {
    return { status: 400, body: { ok: false, event: 'run.ai.spend', message: 'run.ai.spend needs `at`, the time of the snapshot (ISO 8601).' } };
  }
  if (result.stored) {
    try {
      (ledger || ledgerForCallbacks()).recordMakerSpend(client.id, result.client.makerRun.aiSpend);
    } catch {
      // makerRun.aiSpend is stored; the per-run history is a convenience copy
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      event: 'run.ai.spend',
      stored: result.stored,
      ...(result.stored ? {} : { ignored: true, reason: result.reason }),
      aiSpend: result.stored ? result.client.makerRun.aiSpend : null,
    },
  };
}
