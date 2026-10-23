// WS8.9: the delivery state machine. deriveStage is pure (table of client snapshots, every stage,
// overlay and sub-state), the stored state is normalized and idempotent, email stamps and their
// legacy mirror never diverge, and history is capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-state-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = await import('../lib/delivery-state.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const plan = (extra = {}) => ({ status: 'active', tierId: 'tier-2-seo', services: ['site', 'seo'], billing: 'month', source: 'portal-accept', ...extra });
const base = (extra = {}) => ({ id: 'c', product: 'asoldi', progression: {}, ...extra });
const signedClient = (extra = {}) => base({
  progression: { meetingHeld: true, offerSent: true, contractSigned: true },
  contractSignedAt: '2026-10-01T10:00:00.000Z',
  sitePlan: plan(),
  ...extra,
});
const job = (kind, status, extra = {}) => ({ id: `job-${kind}-${status}`, kind, status, at: '2026-11-10T10:00:00.000Z', ...extra });
const held = { heldAt: '2026-10-10T10:00:00.000Z' };
const preview = (at, hash = 'h1') => ({ previewReady: { at, previewHash: hash, variant: 'first' } });

// [name, client, ctx, expected subset]
const CASES = [
  ['lead: nothing yet', base(), {}, { stage: 'lead' }],
  ['sales meeting held', base({ progression: { meetingHeld: true } }), {}, { stage: 'sales_meeting' }],
  ['offer sent', base({ progression: { meetingHeld: true, offerSent: true } }), {}, { stage: 'offer_sent' }],
  ['signed with an active plan', signedClient(), {}, { stage: 'signed', subState: '' }],
  ['signed before plans existed', signedClient({ sitePlan: undefined }), {}, { stage: 'signed', subState: 'plan-missing' }],
  ['un-signed: plan void and contract unchecked goes back to offer_sent', signedClient({ progression: { meetingHeld: true, offerSent: true, contractSigned: false }, sitePlan: plan({ status: 'void' }), workshop: held }), {}, { stage: 'offer_sent', reason: 'unsigned' }],
  ['un-signed before the offer went out', base({ progression: { meetingHeld: true }, sitePlan: plan({ status: 'void' }) }), {}, { stage: 'sales_meeting' }],
  ['gathering after the pre-workshop email', signedClient({ delivery: { emails: { preWorkshopSentAt: '2026-10-02T10:00:00.000Z' } } }), {}, { stage: 'gathering', subState: '' }],
  ['gathering from a legacy desk stamp', signedClient({ workshop: { deskEmails: { preWorkshopSentAt: '2026-10-02T10:00:00.000Z' } } }), {}, { stage: 'gathering' }],
  ['gathering because the workshop is booked', signedClient({ workshopAction: { dueAt: '2026-10-12T10:00:00.000Z' } }), {}, { stage: 'gathering', subState: 'workshop-booked' }],
  ['workshop held', signedClient({ workshop: held }), {}, { stage: 'workshop_held' }],
  ['gate after the post-workshop email', signedClient({ workshop: held, delivery: { emails: { postWorkshopSentAt: '2026-10-10T12:00:00.000Z' } } }), {}, { stage: 'gate' }],
  ['gate passed by the evaluation', signedClient({ workshop: held, delivery: { gate: { devComplete: true } } }), {}, { stage: 'gate' }],
  ['gate approved by a developer', signedClient({ workshop: held, delivery: { events: { gateApprovedAt: '2026-10-11T10:00:00.000Z' } } }), {}, { stage: 'gate' }],
  ['developing: continue job queued', signedClient({ workshop: held, delivery: { job: job('continue', 'queued') } }), {}, { stage: 'developing', subState: 'queued' }],
  ['developing: continue job running', signedClient({ workshop: held }), { jobs: [job('continue', 'running')] }, { stage: 'developing', subState: 'running' }],
  ['developing: failed and retrying', signedClient({ workshop: held }), { jobs: [job('continue', 'failed', { attempts: 1, maxAttempts: 3, blocking: 'maker-offline' })] }, { stage: 'developing', blocking: 'maker-offline' }],
  ['failed for good falls back to the gate facts', signedClient({ workshop: held, delivery: { emails: { postWorkshopSentAt: '2026-10-10T12:00:00.000Z' } } }), { jobs: [job('continue', 'failed', { attempts: 3, maxAttempts: 3 })] }, { stage: 'gate' }],
  ['dev review, awaiting accept', signedClient({ workshop: held }), { jobs: [job('continue', 'done', { doneAt: '2026-11-11T10:00:00.000Z' })] }, { stage: 'dev_review', subState: 'awaiting-accept' }],
  ['dev review, pushed', signedClient({ workshop: held, makerRun: { runId: 'r', previewPush: { at: '2026-11-11T11:00:00.000Z' } } }), { jobs: [job('continue', 'done', { doneAt: '2026-11-11T10:00:00.000Z' })] }, { stage: 'dev_review', subState: 'pushed' }],
  ['client preview after preview-ready', signedClient({ workshop: held, delivery: { events: preview('2026-11-12T10:00:00.000Z') } }), { jobs: [job('continue', 'done', { doneAt: '2026-11-11T10:00:00.000Z' })] }, { stage: 'client_preview' }],
  ['preview-ready older than the last dev job is dev review again', signedClient({ workshop: held, delivery: { events: preview('2026-11-12T10:00:00.000Z') } }), { jobs: [job('iteration', 'done', { doneAt: '2026-11-14T10:00:00.000Z' })] }, { stage: 'dev_review' }],
  ['client preview without the job queue (push before preview-ready)', signedClient({ workshop: held, makerRun: { runId: 'r', previewPush: { at: '2026-11-11T11:00:00.000Z' } }, delivery: { events: preview('2026-11-12T10:00:00.000Z') } }), {}, { stage: 'client_preview' }],
  ['iterating: iteration job active', signedClient({ workshop: held, delivery: { events: preview('2026-11-12T10:00:00.000Z') } }), { jobs: [job('iteration', 'running')] }, { stage: 'iterating', subState: 'running' }],
  ['iterating: change request job claimed', signedClient({ workshop: held }), { jobs: [job('change_request', 'claimed')] }, { stage: 'iterating' }],
  ['approved: approval on the current preview', signedClient({ workshop: held, delivery: { events: { ...preview('2026-11-12T10:00:00.000Z'), approval: { at: '2026-11-13T10:00:00.000Z', by: 'client', source: 'portal', previewHash: 'h1' } } } }), {}, { stage: 'approved' }],
  ['stale approval: a newer preview went out', signedClient({ workshop: held, delivery: { events: { ...preview('2026-11-15T10:00:00.000Z', 'h2'), approval: { at: '2026-11-13T10:00:00.000Z', previewHash: 'h1' } } } }), {}, { stage: 'client_preview', subState: 'approval-stale' }],
  ['approval without a hash does not count', signedClient({ workshop: held, delivery: { events: { ...preview('2026-11-12T10:00:00.000Z', ''), approval: { at: '2026-11-13T10:00:00.000Z' } } } }), {}, { stage: 'client_preview' }],
  ['publishing: staging publish job', signedClient({ workshop: held }), { jobs: [job('publish', 'running', { target: 'staging' })] }, { stage: 'publishing', subState: 'staging' }],
  ['publishing: production publish job', signedClient({ workshop: held }), { jobs: [job('publish', 'queued', { target: 'production' })] }, { stage: 'publishing', subState: 'production' }],
  ['publishing: staging live, payment connected', signedClient({ workshop: held, delivery: { events: { stagingLiveAt: '2026-11-16T10:00:00.000Z' } } }), {}, { stage: 'publishing', subState: 'staging-live', blocking: '' }],
  ['publishing: staging live, payment missing', signedClient({ workshop: held, delivery: { events: { stagingLiveAt: '2026-11-16T10:00:00.000Z' }, gate: { lines: [{ id: 'payment', status: 'missing' }] } } }), {}, { stage: 'publishing', blocking: 'needs-payment-setup' }],
  ['live: verified production go-live', signedClient({ makerRun: { runId: 'r', goLive: { target: 'production', liveVerifiedAt: '2026-11-18T10:00:00.000Z' } } }), {}, { stage: 'live', subState: '' }],
  ['live: staging go-live is not live', signedClient({ workshop: held, makerRun: { runId: 'r', goLive: { target: 'staging', liveVerifiedAt: '2026-11-18T10:00:00.000Z' } } }), {}, { stage: 'workshop_held' }],
  ['live: identity-proven fallback check', signedClient({ delivery: { events: { liveVerifiedAt: '2026-11-18T10:00:00.000Z' } } }), {}, { stage: 'live' }],
  ['live: legacy progression flag', signedClient({ progression: { contractSigned: true, live: true }, hubSite: { createdAt: '2026-11-19T10:00:00.000Z' } }), {}, { stage: 'live', subState: 'legacy' }],
  ['maintenance: monthly plan live for more than 7 days', signedClient({ makerRun: { runId: 'r', goLive: { target: 'production', liveVerifiedAt: iso(NOW - 8 * DAY) } } }), {}, { stage: 'maintenance' }],
  ['maintenance: legacy live site created months ago', signedClient({ progression: { contractSigned: true, live: true }, hubSite: { createdAt: '2026-06-01T10:00:00.000Z' } }), {}, { stage: 'maintenance', subState: 'legacy' }],
  ['maintenance: site-live email more than 7 days ago', signedClient({ delivery: { events: { liveVerifiedAt: iso(NOW - DAY) }, emails: { siteLiveSentAt: iso(NOW - 9 * DAY) } } }), {}, { stage: 'maintenance' }],
  ['one-time plan stays live until the handover is done', signedClient({ sitePlan: plan({ billing: 'once' }), delivery: { events: { liveVerifiedAt: iso(NOW - 30 * DAY) } } }), {}, { stage: 'live' }],
  ['handed over: one-time plan, checklist complete', signedClient({ sitePlan: plan({ billing: 'once' }), delivery: { events: { liveVerifiedAt: iso(NOW - 30 * DAY), handover: { completedAt: iso(NOW - DAY) } } } }), {}, { stage: 'handed_over' }],
  ['overlay paused on top of developing', signedClient({ workshop: held, delivery: { events: { pausedAt: '2026-11-15T10:00:00.000Z' } } }), { jobs: [job('continue', 'running')] }, { stage: 'developing', overlay: 'paused' }],
  ['overlay cancelled on top of maintenance', signedClient({ makerRun: { runId: 'r', goLive: { target: 'production', liveVerifiedAt: iso(NOW - 20 * DAY) } }, delivery: { events: { cancelled: { at: iso(NOW - DAY), source: 'stripe' } } } }), {}, { stage: 'maintenance', overlay: 'cancelled' }],
  ['overlay cancelled from an ended plan', signedClient({ sitePlan: plan({ status: 'ended' }) }), {}, { stage: 'signed', overlay: 'cancelled' }],
  ['cancelled wins over paused', signedClient({ delivery: { events: { pausedAt: iso(NOW - 2 * DAY), cancelled: { at: iso(NOW - DAY) } } } }), {}, { overlay: 'cancelled' }],
  ['SSU clients have no delivery stage', base({ product: 'ssu', progression: { contractSigned: true } }), {}, { stage: null, reason: 'not-a-website-product' }],
  ['a done preview job does not count as development', signedClient({ workshop: held }), { jobs: [job('preview', 'done', { doneAt: '2026-11-11T10:00:00.000Z' })] }, { stage: 'workshop_held' }],
];

test(`deriveStage: ${CASES.length} client snapshots cover every stage, overlay and sub-state`, () => {
  assert.ok(CASES.length >= 35);
  const seenStages = new Set();
  const seenOverlays = new Set();
  for (const [name, client, ctx, expected] of CASES) {
    const derived = state.deriveStage(client, { now: NOW, ...ctx });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(derived[key], value, `${name}: ${key}`);
    if (derived.stage) seenStages.add(derived.stage);
    if (derived.overlay) seenOverlays.add(derived.overlay);
  }
  assert.deepEqual([...vocab.STAGES].filter((stage) => !seenStages.has(stage)), [], 'every stage is covered');
  assert.deepEqual([...vocab.STAGE_OVERLAYS].filter((overlay) => !seenOverlays.has(overlay)), [], 'every overlay is covered');
});

test('deriveStage does no I/O and does not touch its input', () => {
  const source = readFileSync(join(root, 'lib', 'delivery-state.js'), 'utf8');
  assert.doesNotMatch(source, /from 'node:|from "node:|require\(|process\.env|fetch\(/);
  const client = signedClient({ workshop: held, delivery: { emails: { postWorkshopSentAt: '2026-10-10T12:00:00.000Z' } } });
  const before = JSON.stringify(client);
  state.deriveStage(client, { now: NOW });
  assert.equal(JSON.stringify(client), before);
});

test('normalizeDelivery: idempotent, keeps later keys, drops unknown job kinds and codes', () => {
  const raw = {
    stage: 'gate', overlay: 'nope', future: { x: 1 },
    events: { approval: { at: '2026-11-13T10:00:00.000Z', quote: 'x'.repeat(600) }, laterEvent: 'kept' },
    emails: { preWorkshopSentAt: 'not a date', postWorkshopSentAt: '2026-10-10T12:00:00.000Z', backfilled: ['postWorkshopSentAt', 'bogus'] },
    job: { id: 'j', kind: 'continue', status: 'running', blocking: 'not-a-code', warnings: ['dev-skipped', 'nonsense'] },
    history: [{ from: 'signed', to: 'gathering', at: '2026-10-02T10:00:00.000Z' }, { to: 'nowhere' }],
  };
  const once = state.normalizeDelivery(raw);
  assert.deepEqual(state.normalizeDelivery(once), once);
  assert.equal(once.overlay, '');
  assert.deepEqual(once.future, { x: 1 });
  assert.equal(once.events.laterEvent, 'kept');
  assert.equal(once.events.approval.quote.length, 400);
  assert.equal(once.emails.preWorkshopSentAt, '');
  assert.deepEqual(once.emails.backfilled, ['postWorkshopSentAt']);
  assert.equal(once.job.blocking, '');
  assert.deepEqual(once.job.warnings, ['dev-skipped']);
  assert.equal(once.history.length, 1);
  assert.equal(state.normalizeDeliveryJob({ id: 'j', kind: 'not-a-kind' }), null);
});

test('mergeDelivery: events and emails merge, gate and job replace', () => {
  const current = state.normalizeDelivery({ events: { gateApprovedAt: '2026-10-11T10:00:00.000Z' }, emails: { preWorkshopSentAt: '2026-10-02T10:00:00.000Z' }, gate: { a: 1, b: 2 }, job: { id: 'j1', kind: 'continue' } });
  const next = state.mergeDelivery(current, { events: { stagingLiveAt: '2026-11-16T10:00:00.000Z' }, emails: { siteLiveSentAt: '2026-11-18T10:00:00.000Z' }, gate: { a: 3 }, job: { id: 'j2', kind: 'publish' } });
  assert.equal(next.events.gateApprovedAt, '2026-10-11T10:00:00.000Z');
  assert.equal(next.events.stagingLiveAt, '2026-11-16T10:00:00.000Z');
  assert.equal(next.emails.preWorkshopSentAt, '2026-10-02T10:00:00.000Z');
  assert.equal(next.emails.siteLiveSentAt, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(next.gate, { a: 3 });
  assert.equal(next.job.id, 'j2');
});

test('planStageWrite: writes once per change, idempotent, history capped at 50', () => {
  const first = state.planStageWrite(signedClient(), { now: NOW, by: 'test' });
  assert.equal(first.changed, true);
  assert.equal(first.delivery.stage, 'signed');
  assert.equal(first.delivery.history.length, 1);
  const again = state.planStageWrite(signedClient({ delivery: first.delivery }), { now: NOW + 1000, by: 'test' });
  assert.equal(again.changed, false);
  let delivery = first.delivery;
  for (let i = 0; i < 60; i += 1) {
    const flip = i % 2 === 0 ? { workshopAction: { dueAt: '2026-10-12T10:00:00.000Z' } } : {};
    const result = state.planStageWrite(signedClient({ ...flip, delivery }), { now: NOW + i, by: 'loop' });
    assert.equal(result.changed, true);
    delivery = result.delivery;
  }
  assert.equal(delivery.history.length, 50);
  assert.equal(state.planStageWrite(base({ product: 'ssu' }), { now: NOW }).changed, false);
});

test('email stamps: delivery.emails and the legacy desk mirror get the same value', () => {
  const patch = state.deliveryEmailStampPatch({}, 'preWorkshopSentAt', '2026-10-02T10:00:00.000Z');
  assert.deepEqual(patch, { emails: { preWorkshopSentAt: '2026-10-02T10:00:00.000Z' }, deskEmails: { preWorkshopSentAt: '2026-10-02T10:00:00.000Z' } });
  const reminder = state.deliveryEmailStampPatch({ delivery: { emails: { dataReminders: ['2026-10-05T10:00:00.000Z'] } } }, 'dataReminders', '2026-10-09T10:00:00.000Z');
  assert.deepEqual(reminder.deskEmails, { data2SentAt: '2026-10-09T10:00:00.000Z' });
  assert.throws(() => state.deliveryEmailStampPatch({}, 'nope', '2026-10-02T10:00:00.000Z'));
  assert.throws(() => state.deliveryEmailStampPatch({}, 'siteLiveSentAt', 'not a time'));
});

test('data layer: stage sync is idempotent, stamps never diverge, generic updates cannot write delivery', async () => {
  writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
    { ...signedClient(), id: 'c1', businessName: 'Stage AS', status: 'active' },
    { id: 'ssu1', product: 'ssu', businessName: 'Ssu AS', status: 'active', progression: { contractSigned: true } },
  ], null, 2));
  const sales = await import('../data/sales.js');
  sales.noteSalesStoreReplaced();
  const first = sales.syncSalesDeliveryStage('c1', { by: 'test', now: NOW });
  assert.equal(first.changed, true);
  assert.equal(first.client.delivery.stage, 'signed');
  assert.equal(sales.syncSalesDeliveryStage('c1', { by: 'test', now: NOW }).changed, false, 'second sync writes nothing');
  const ssu = sales.syncSalesDeliveryStage('ssu1', { by: 'test', now: NOW });
  assert.equal(ssu.changed, false);
  assert.equal(ssu.client.delivery, undefined, 'SSU clients get no delivery object');

  const stamped = sales.stampDeliveryEmail('c1', 'preWorkshopSentAt', '2026-10-02T10:00:00.000Z', { by: 'test' });
  assert.equal(stamped.delivery.emails.preWorkshopSentAt, stamped.workshop.deskEmails.preWorkshopSentAt);
  const r1 = sales.stampDeliveryEmail('c1', 'dataReminders', '2026-10-05T10:00:00.000Z');
  const r2 = sales.stampDeliveryEmail('c1', 'dataReminders', '2026-10-09T10:00:00.000Z');
  assert.deepEqual(r2.delivery.emails.dataReminders, ['2026-10-05T10:00:00.000Z', '2026-10-09T10:00:00.000Z']);
  assert.equal(r1.workshop.deskEmails.data1SentAt, '2026-10-05T10:00:00.000Z');
  assert.equal(r2.workshop.deskEmails.data2SentAt, '2026-10-09T10:00:00.000Z');
  const stamps = state.deliveryEmailStamps(r2);
  assert.equal(stamps.preWorkshopSentAt, r2.workshop.deskEmails.preWorkshopSentAt);
  assert.equal(sales.syncSalesDeliveryStage('c1', { by: 'test', now: NOW }).client.delivery.stage, 'gathering');

  const blocked = sales.updateSalesClient('c1', { delivery: { stage: 'live' }, notes: 'n' });
  assert.equal(blocked.delivery.stage, 'gathering', 'a generic update cannot set the stage');
  const patched = sales.patchSalesClientsById([{ id: 'c1', patch: { delivery: { stage: 'live' }, sitePlan: null } }]);
  assert.equal(patched.updated, 1);
  const after = sales.getSalesClientById('c1');
  assert.equal(after.delivery.stage, 'gathering');
  assert.equal(after.sitePlan.tierId, 'tier-2-seo');

  const dirty = sales.setSalesDelivery('c1', { dirtyAt: '2026-11-20T12:00:00.000Z' }, { by: 'test', reason: 'materials' });
  assert.equal(dirty.delivery.dirtyAt, '2026-11-20T12:00:00.000Z');
  assert.equal(dirty.delivery.emails.preWorkshopSentAt, '2026-10-02T10:00:00.000Z', 'a patch keeps the other facts');
  const auditDir = join(DATA_DIR, 'delivery-audit');
  const lines = readFileSync(join(auditDir, `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.kind === 'stage' && line.to === 'signed'));
  assert.ok(lines.some((line) => line.kind === 'email-stamp'));
  for (const line of lines) assert.equal(Object.hasOwn(line, 'businessName'), false, 'ids only');
});
