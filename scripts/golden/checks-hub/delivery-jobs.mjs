// Delivery check: the Maker jobs. Every client got exactly one preview job; a Maker host claimed it
// and it is done with the run ready up to maps-embed-sync. A client whose run was linked before the
// job (ctx.expect.continued: {clientId: runId}) has that same run continued, not a new one; for every
// other client the job created a run and the hub links the client to it.
import { PREVIEW_STEP } from './delivery-stages.mjs';
import { clientById, deliveryJobs, result } from './lib.mjs';

export const id = 'delivery.jobs';

export async function check(ctx) {
  if (ctx.timeline?.switches !== 'on') return result(id, [], [], null, { skipped: 'the delivery loop is off in this run' });
  const findings = [];
  const value = {};
  const jobs = deliveryJobs(ctx.dataDir);
  const continued = ctx.expect?.continued || {};
  for (const spec of ctx.plan.clients) {
    const own = jobs.filter((job) => job.salesClientId === spec.id && job.kind === 'preview');
    const job = own[0] || null;
    const client = clientById(ctx.dataDir, spec.id) || {};
    const row = { jobs: own.length, status: job?.status || '', hostId: job?.hostId || '', attempts: job?.attempts || 0, runId: job?.result?.runId || '', createdRun: job?.result?.createdRun === true, latestReadyStep: job?.result?.latestReadyStep || '', linkedRun: client.makerRun?.runId || '' };
    value[spec.id] = row;
    if (own.length !== 1) findings.push(`${spec.id}: ${own.length} preview jobs, expected 1`);
    if (!job) continue;
    if (job.status !== 'done') findings.push(`${spec.id}: the preview job is ${job.status}${job.error ? ` (${String(job.error).slice(0, 160)})` : ''}${job.blocking ? ` [${job.blocking}]` : ''}`);
    if (!job.hostId) findings.push(`${spec.id}: no Maker host claimed the preview job`);
    if (job.status === 'done' && row.latestReadyStep !== PREVIEW_STEP) findings.push(`${spec.id}: the run is ready up to ${row.latestReadyStep || 'nothing'}, expected ${PREVIEW_STEP}`);
    if (continued[spec.id]) {
      if (row.runId !== continued[spec.id] || row.createdRun) findings.push(`${spec.id}: the linked run ${continued[spec.id]} was not continued (job run ${row.runId || 'none'}, created ${row.createdRun})`);
      if (row.linkedRun !== continued[spec.id]) findings.push(`${spec.id}: the client is linked to ${row.linkedRun || 'nothing'}, not to its run ${continued[spec.id]}`);
    } else if (job.status === 'done') {
      if (!row.createdRun) findings.push(`${spec.id}: the job created no run for a client without one`);
      if (!row.runId || row.linkedRun !== row.runId) findings.push(`${spec.id}: the client is not linked to the run the job created (${row.linkedRun || 'nothing'} vs ${row.runId || 'none'})`);
    }
  }
  return result(id, ['delivery.loop'], findings, value);
}
