// Delivery check: signing and stages. Every client signed through its path (2xx), holds one active
// site plan with the plan's tier and exactly one hub site (no duplicate from a second path); its stage
// went through gathering to workshop_held, each stage transition recorded once; and it reached the
// preview: its preview job is done with the run ready up to maps-embed-sync (a preview job does not
// count as development, so the delivery stage itself stays at workshop_held or gate).
// With every switch off: signed, and nothing more is checked here.
import { clientById, hubSites, result } from './lib.mjs';

export const id = 'delivery.stages';
export const PREVIEW_STEP = 'maps-embed-sync';
const REQUIRED_STAGES = ['gathering', 'workshop_held'];

export async function check(ctx) {
  const findings = [];
  const value = {};
  const on = ctx.timeline?.switches === 'on';
  const sites = hubSites(ctx.dataDir);
  for (const spec of ctx.plan.clients) {
    const client = clientById(ctx.dataDir, spec.id);
    const sign = ctx.timeline?.clients?.[spec.id]?.sign || {};
    const row = { path: spec.signing, signStatus: sign.status || 0 };
    value[spec.id] = row;
    if (!client) {
      findings.push(`${spec.id}: the client is gone`);
      continue;
    }
    if (!sign.ok) findings.push(`${spec.id}: signing through ${spec.signing} answered ${sign.status}`);
    if (client.progression?.contractSigned !== true) findings.push(`${spec.id}: not marked signed`);
    const plan = client.sitePlan && typeof client.sitePlan === 'object' ? client.sitePlan : null;
    const own = sites.filter((site) => site?.planSource?.salesClientId === spec.id || (client.hubSite?.id && site?.id === client.hubSite.id));
    row.tierId = plan?.tierId || '';
    row.sites = own.length;
    row.stage = client.delivery?.stage || '';
    row.history = (client.delivery?.history || []).map((entry) => `${entry.from || '-'}>${entry.to}`);
    if (!on) continue;
    if (plan?.status !== 'active') findings.push(`${spec.id}: no active site plan`);
    else if (plan.tierId !== spec.tier) findings.push(`${spec.id}: site plan tier ${plan.tierId}, expected ${spec.tier}`);
    if (own.length !== 1) findings.push(`${spec.id}: ${own.length} hub sites, expected 1`);
    const transitions = row.history;
    const repeated = transitions.filter((entry, index) => transitions.indexOf(entry) !== index);
    if (repeated.length) findings.push(`${spec.id}: stage transitions recorded twice: ${[...new Set(repeated)].join(', ')}`);
    const reached = new Set((client.delivery?.history || []).map((entry) => entry.to));
    for (const stage of REQUIRED_STAGES) if (!reached.has(stage)) findings.push(`${spec.id}: the stage never reached ${stage} (${transitions.join(', ') || 'no history'})`);
    const previewJob = (ctx.timeline?.jobs?.[spec.id]?.jobs || []).find((job) => job.status === 'done');
    row.previewStep = previewJob?.result?.latestReadyStep || '';
    if (row.previewStep !== PREVIEW_STEP) findings.push(`${spec.id}: the preview was not reached (preview job ${previewJob ? `done at ${row.previewStep || 'no step'}` : 'not done'})`);
  }
  return result(id, on ? ['signing', 'delivery.loop'] : [], findings, value);
}
