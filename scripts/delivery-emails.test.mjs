// The post-workshop mail (two hours after the workshop) and the Datainnsamling reminders: due times,
// shadow and auto delivery, a restart between scheduling and sending, the ready variant, the manual
// desk kind, the workshop/held route, and the negative controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-emails-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT)/.test(key)) delete process.env[key];
process.env.RESEND_API_KEY = 're_standin_for_tests';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const transport = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === 'https://api.resend.com/emails') {
    transport.push(JSON.parse(String(init.body || '{}')));
    return new Response(JSON.stringify({ id: `stand-in-${transport.length}` }), { status: 200 });
  }
  if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
  throw new Error(`no network in tests: ${url}`);
};
test.after(() => {
  globalThis.fetch = originalFetch;
});

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const hub = await import('../data/hub.js');
const emails = await import('../lib/delivery-emails.js');
const { deliveryEmailStamps } = await import('../lib/delivery-state.js');
const { listOutbox, readOutboxItem } = await import('../lib/safe-mode-outbox.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { applyWorkshopTranscriptToRecord } = await import('../lib/workshop-project-document.js');
const { buildFirefliesMeetingRecord } = await import('../lib/fireflies-webhook.js');
const { register } = await import('../lib/routes/gate-routes.js');

const TIER1 = { status: 'active', tierId: 'tier-1-standard', services: ['site', 'changes', 'blog'], languages: ['nb'], billing: 'month', source: 'backfill' };
const START = '2026-11-03T10:00:00.000Z';
const END = '2026-11-03T11:00:00.000Z';
const DUE = '2026-11-03T13:00:00.000Z';

function save(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
}

function seed(id, extra = {}) {
  sales.createSalesClient({
    id,
    businessName: 'Example Studio AS',
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    product: 'asoldi',
    progression: { contractSigned: true },
    ...extra,
  });
  sales.setSalesSitePlan(id, TIER1, { by: 'test' });
  return sales.getSalesClientById(id);
}

function shadowRecords(id) {
  return listOutbox(DATA_DIR, { limit: 500 }).items.filter((item) => item.channel === emails.SHADOW_CHANNEL && item.to.includes(`${id}@example.com`));
}

function tickInChild(id, now, mode = 'auto') {
  const script = `
    const emails = await import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'delivery-emails.js')).href)});
    const sales = await import(${JSON.stringify(pathToFileURL(join(root, 'data', 'sales.js')).href)});
    globalThis.fetch = async () => { throw new Error('no network'); };
    const result = await emails.runPostWorkshopStep({ mode: ${JSON.stringify(mode)}, now: ${JSON.stringify(now)} }, sales.getSalesClientById(${JSON.stringify(id)}));
    console.log(JSON.stringify(result));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, APP_DATA_DIR: DATA_DIR, DATA_DIR },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('negative control: with the gate off nothing is scheduled, drafted or sent', async () => {
  save({ gate: { enabled: false } });
  const client = seed('off-1');
  assert.deepEqual(emails.schedulePostWorkshop('off-1', { sales, startedAt: START, endedAt: END, now: END }), { scheduled: false, dueAt: '', reason: 'gate-off' });
  // Even a stored due time sends nothing while the gate is off.
  sales.stampDeliveryEmail('off-1', 'postWorkshopDueAt', DUE);
  const result = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T13:30:00.000Z' }, sales.getSalesClientById('off-1'));
  assert.equal(result.wrote, false);
  assert.equal(shadowRecords('off-1').length, 0);
  const reminder = await emails.runDataReminderStep({ mode: 'auto', now: '2026-11-20T13:30:00.000Z' }, sales.getSalesClientById('off-1'));
  assert.equal(reminder.wrote, false);
  assert.equal(client.delivery?.gate ?? null, null);
  // The Prosjektdokument leaves delivery alone with the gate off.
  seed('off-2');
  const applied = await applyWorkshopTranscriptToRecord({
    client: sales.getSalesClientById('off-2'),
    workshopMeeting: { meetingId: 'm-off', transcript: 'Workshop.', dateString: START, duration: 60 },
    force: true,
    generateDocument: async () => ({ goalExplanation: 'Mål', clientDocumentation: 'Dok', todos: [] }),
  });
  assert.ok(applied.workshop.heldAt);
  assert.equal(sales.getSalesClientById('off-2').delivery ?? null, null);
});

test('a 10:00-11:00 workshop makes the mail due at 13:00; 12:59 sends nothing, 13:01 exactly one, also after a restart', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('pw-1');
  const scheduled = emails.schedulePostWorkshop('pw-1', { sales, startedAt: START, endedAt: END, now: END });
  assert.equal(scheduled.dueAt, DUE);
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-1')).postWorkshopDueAt, DUE);
  // Scheduling again keeps the first due time.
  assert.equal(emails.schedulePostWorkshop('pw-1', { sales, endedAt: '2026-11-03T15:00:00.000Z' }).reason, 'already-scheduled');
  const early = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T12:59:00.000Z' }, sales.getSalesClientById('pw-1'));
  assert.equal(early.wrote, false);
  assert.equal(shadowRecords('pw-1').length, 0);
  // A new process (a restart) picks the stored due time up.
  const first = tickInChild('pw-1', '2026-11-03T13:01:00.000Z');
  assert.equal(first.wrote, true);
  assert.equal(first.status, 'shadow');
  assert.equal(shadowRecords('pw-1').length, 1);
  const again = tickInChild('pw-1', '2026-11-03T13:05:00.000Z');
  assert.equal(again.wrote, false);
  assert.equal((await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T14:00:00.000Z' }, sales.getSalesClientById('pw-1'))).wrote, false);
  assert.equal(shadowRecords('pw-1').length, 1, 'exactly one');
  assert.equal(transport.length, 0, 'shadow never reaches the transport');
  const body = readOutboxItem(DATA_DIR, shadowRecords('pw-1')[0].id);
  assert.match(body.text, /Takk for workshopen/);
  assert.match(body.html, />Merke</);
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-1')).postWorkshopSentAt, '', 'shadow stamps nothing');
});

test('auto delivery sends once through the transport and stamps postWorkshopSentAt', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('pw-auto', { ownerId: 'admin:alexander@asoldi.com' });
  emails.schedulePostWorkshop('pw-auto', { sales, startedAt: START, endedAt: END, now: END });
  // Auto is not offered by the settings yet; a settings object shows what it would do.
  const base = settingsStore.getAutomationSettings({ fresh: true });
  const settings = {
    ...base,
    pilotClientIds: ['pw-auto'],
    gate: { enabled: true, mode: 'auto', paused: null },
    emails: { ...base.emails, postWorkshop: { ...base.emails.postWorkshop, enabled: true, mode: 'auto' } },
  };
  const sent = [];
  const ctx = { mode: 'auto', settings, emailDeps: { sendEmail: async (message) => sent.push(message) } };
  assert.equal((await emails.runPostWorkshopStep({ ...ctx, now: '2026-11-03T12:59:00.000Z' }, sales.getSalesClientById('pw-auto'))).wrote, false);
  const result = await emails.runPostWorkshopStep({ ...ctx, now: '2026-11-03T13:01:00.000Z' }, sales.getSalesClientById('pw-auto'));
  assert.equal(result.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'pw-auto@example.com');
  assert.equal(sent[0].replyTo, 'alexander@asoldi.com', 'the rep mailbox the inbox bot reads');
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-auto')).postWorkshopSentAt, '2026-11-03T13:01:00.000Z');
  assert.equal((await emails.runPostWorkshopStep({ ...ctx, now: '2026-11-03T13:30:00.000Z' }, sales.getSalesClientById('pw-auto'))).wrote, false);
  assert.equal(sent.length, 1);
  // A loop that is not auto for the client turns the same mail into a shadow record.
  assert.equal(emails.deliveryEmailMode('postWorkshop', { id: 'pw-auto' }, { settings, loopMode: 'shadow' }), 'shadow');
});

test('with emails.postWorkshop disabled nothing is drafted', async () => {
  save({ gate: { enabled: true, mode: 'shadow' }, emails: { postWorkshop: { enabled: false } } });
  seed('pw-off');
  emails.schedulePostWorkshop('pw-off', { sales, startedAt: START, endedAt: END, now: END });
  const result = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T14:00:00.000Z' }, sales.getSalesClientById('pw-off'));
  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'mode-off');
  assert.equal(shadowRecords('pw-off').length, 0);
  assert.equal(readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'email-shadow' && row.clientId === 'pw-off').length, 0);
  save({ emails: { postWorkshop: { enabled: true } } });
});

// The meeting row the hub stores for a Fireflies recording (what the Prosjektdokument receives).
function storedMeeting(meetingId, startIso, minutes) {
  const record = buildFirefliesMeetingRecord({ meetingId }, { id: meetingId, title: 'Workshop', dateString: startIso, duration: minutes });
  assert.equal(record.startedAt, startIso);
  assert.equal(record.durationMinutes, minutes);
  assert.equal('dateString' in record || 'date' in record || 'duration' in record, false, 'the stored row has no raw Fireflies time fields');
  return { ...record, transcript: 'Workshop.' };
}

async function applyDocument(id, workshopMeeting) {
  const applied = await applyWorkshopTranscriptToRecord({
    client: sales.getSalesClientById(id),
    workshopMeeting,
    force: true,
    generateDocument: async () => ({ goalExplanation: 'Mål', clientDocumentation: 'Dok', todos: [] }),
  });
  sales.setSalesWorkshop(id, applied.workshop);
  return deliveryEmailStamps(sales.getSalesClientById(id)).postWorkshopDueAt;
}

// A UTC day relative to the real clock (the Prosjektdokument schedules against the real clock).
function utcDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// The stored due time for a computed `due`: `due` itself while it is still ahead, else the time of
// the call (a due time that has passed is stored as now).
async function assertDueFrom(stored, due) {
  const before = Date.now();
  const got = await stored();
  if (Date.parse(due) >= before) assert.equal(got, due);
  else assert.ok(Date.parse(got) >= before && Date.parse(got) <= Date.now(), `${got} is the time of the call`);
}

test('the Prosjektdokument schedules the mail from the stored recording of the workshop', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  // Today 10:00-11:00 UTC: the due time 13:00 is at most 11 hours ago, so never stale.
  const today = utcDay();
  const [start, due] = [`${today}T10:00:00.000Z`, `${today}T13:00:00.000Z`];
  // No booked workshop: the recording alone gives the time.
  seed('pw-doc');
  await assertDueFrom(() => applyDocument('pw-doc', storedMeeting('m-doc', start, 60)), due);
  // A booking at 09:00 does not move it: the recording wins over the booked time.
  seed('pw-doc-booked', { workshopAction: { dueAt: `${today}T09:00:00.000Z` } });
  await assertDueFrom(() => applyDocument('pw-doc-booked', storedMeeting('m-doc-2', start, 60)), due);
  // A raw Fireflies answer still works.
  seed('pw-doc-raw');
  await assertDueFrom(() => applyDocument('pw-doc-raw', { meetingId: 'm-doc-3', transcript: 'Workshop.', dateString: start, duration: 60 }), due);
});

test('a workshop recording linked days later schedules no post-workshop mail', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  // A recording from 3 days ago, applied now: no due time, so no thank-you goes out days late.
  seed('pw-stale-doc');
  assert.equal(await applyDocument('pw-stale-doc', storedMeeting('m-stale', `${utcDay(-3)}T10:00:00.000Z`, 60)), '');
  assert.ok(sales.getSalesClientById('pw-stale-doc').workshop.heldAt, 'the workshop is still marked held');
  // The rule at its edge: a due time just within 24 hours is stored, one just past it is not.
  seed('pw-stale-1');
  const late = emails.schedulePostWorkshop('pw-stale-1', { sales, startedAt: START, endedAt: END, now: '2026-11-06T13:00:00.000Z' });
  assert.deepEqual(late, { scheduled: false, dueAt: '', reason: 'stale' });
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-stale-1')).postWorkshopDueAt, '');
  seed('pw-stale-2');
  assert.equal(emails.schedulePostWorkshop('pw-stale-2', { sales, startedAt: START, endedAt: END, now: '2026-11-04T13:01:00.000Z' }).reason, 'stale');
  seed('pw-stale-3');
  const within = emails.schedulePostWorkshop('pw-stale-3', { sales, startedAt: START, endedAt: END, now: '2026-11-04T12:59:00.000Z' });
  assert.equal(within.scheduled, true);
  // The due time 13:00 has passed at 12:59 the next day: it is stored as that moment, not in the past.
  assert.equal(within.dueAt, '2026-11-04T12:59:00.000Z');
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-stale-3')).postWorkshopDueAt, '2026-11-04T12:59:00.000Z');
  // Nothing was recorded for the stale clients by a later tick either.
  for (const id of ['pw-stale-doc', 'pw-stale-1', 'pw-stale-2']) {
    const tick = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-07T10:00:00.000Z' }, sales.getSalesClientById(id));
    assert.equal(tick.wrote, false, id);
    assert.equal(shadowRecords(id).length, 0, id);
  }
});

test('no post-workshop mail or reminder for a backfilled, cancelled, paused or later-stage client', async () => {
  save({ gate: { enabled: true, mode: 'shadow' }, emails: { dataReminder: { enabled: true, mode: 'shadow', afterDays: 4, max: 2 } } });
  // Within the outbox's 30 days of the other records, so no purge removes them.
  const later = '2026-11-20T10:00:00.000Z';
  // A live client the backfill stamped as past the post-workshop mail.
  seed('bf-live', { workshop: { heldAt: '2026-06-01T10:00:00.000Z' }, progression: { contractSigned: true, live: true } });
  sales.stampDeliveryEmails('bf-live', { postWorkshopSentAt: '2026-06-01T12:00:00.000Z' }, { by: 'backfill', backfilled: true });
  assert.deepEqual(await emails.runDataReminderStep({ mode: 'auto', now: later }, sales.getSalesClientById('bf-live')), { wrote: false });
  // Backfilled but still early in delivery: the backfilled stamp is never an anchor either.
  seed('bf-gate', { workshop: { heldAt: '2026-10-01T10:00:00.000Z' } });
  sales.stampDeliveryEmails('bf-gate', { postWorkshopSentAt: '2026-10-01T12:00:00.000Z' }, { by: 'backfill', backfilled: true });
  assert.deepEqual(await emails.runDataReminderStep({ mode: 'auto', now: later }, sales.getSalesClientById('bf-gate')), { wrote: false });
  // A scheduled client that was cancelled, paused or moved on to the preview gets neither mail.
  const cases = {
    'pw-cancelled': { events: { cancelled: { at: '2026-11-03T11:30:00.000Z', source: 'admin', reason: 'test' } } },
    'pw-paused': { events: { pausedAt: '2026-11-03T11:30:00.000Z' } },
    'pw-preview': { events: { previewReady: { at: '2026-11-03T11:30:00.000Z', previewHash: 'h1' } } },
  };
  const expected = { 'pw-cancelled': 'overlay-cancelled', 'pw-paused': 'overlay-paused', 'pw-preview': 'stage-client_preview' };
  for (const [id, delivery] of Object.entries(cases)) {
    seed(id);
    emails.schedulePostWorkshop(id, { sales, startedAt: START, endedAt: END, now: END });
    sales.setSalesDelivery(id, delivery);
    const post = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T13:30:00.000Z' }, sales.getSalesClientById(id));
    assert.equal(post.wrote, false, id);
    assert.equal(post.skipped, expected[id], id);
    const reminder = await emails.runDataReminderStep({ mode: 'auto', now: later }, sales.getSalesClientById(id));
    assert.equal(reminder.wrote, false, id);
    assert.equal(reminder.skipped, expected[id], id);
  }
  for (const id of ['bf-live', 'bf-gate', ...Object.keys(cases)]) assert.equal(shadowRecords(id).length, 0, id);
  // The same flow for a client still in delivery records the reminder (the rule above is the cause).
  seed('pw-active');
  emails.schedulePostWorkshop('pw-active', { sales, startedAt: START, endedAt: END, now: END });
  assert.equal((await emails.runDataReminderStep({ mode: 'auto', now: later }, sales.getSalesClientById('pw-active'))).wrote, true);
  save({ emails: { dataReminder: { enabled: false, mode: 'shadow' } } });
});

test('two sends of the same shadow mail at once record it once', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  const client = seed('race-shadow');
  const message = { to: 'race-shadow@example.com', from: 'Example <post@example.com>', subject: 'Etter workshopen', text: 'Hei', html: '<p>Hei</p>' };
  const send = () => emails.deliverDeliveryEmail({ kindId: 'postWorkshop', client, message, mode: 'shadow', dedupeKey: 'postWorkshop:race-shadow:1', now: DUE, dataDir: DATA_DIR });
  const results = await Promise.all([send(), send(), send()]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['already-recorded', 'already-recorded', 'shadow']);
  assert.equal(shadowRecords('race-shadow').length, 1);
  const mails = await emails.shadowMailsFor('race-shadow', { dataDir: DATA_DIR });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].kind, 'postWorkshop');
  assert.equal(mails[0].item.subject, 'Etter workshopen');
  assert.equal(mails[0].item.text, 'Hei');
});

test('a complete gate gets the ready variant', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('pw-ready', { contactPhone: '+47 00 00 00 00', workshop: { heldAt: END } });
  const getProfile = () => ({
    clientDataBank: {
      brandIdentity: { logos: { normal: 'logo.svg' } },
      generalInfo: { companyPhone: '+47 00 00 00 00', companyEmail: 'post@example.com', companyAddress: 'Example street 1' },
      websiteCreatorQuestions: { businessWhat: 'Example description', websiteDomain: 'example.com' },
      media: { mainHeroImages: ['a.jpg', 'b.jpg', 'c.jpg'] },
      openingHours: { days: [{ day: 'Mandag', opensAt: '09:00', closesAt: '17:00', closed: false }] },
    },
  });
  const built = await emails.buildPostWorkshopMessage(sales.getSalesClientById('pw-ready'), { deps: { getProfile } });
  assert.equal(built.ready, true);
  assert.match(built.message.subject, /vi starter på nettsiden/);
  const missing = await emails.buildPostWorkshopMessage(sales.getSalesClientById('pw-ready'));
  assert.equal(missing.ready, false);
  assert.match(missing.message.subject, /Etter workshopen/);
});

test('data reminders: after afterDays while lines remain, at most max times', async () => {
  save({ gate: { enabled: true, mode: 'shadow' }, emails: { dataReminder: { enabled: true, mode: 'shadow', afterDays: 4, max: 2 } } });
  seed('dr-1');
  emails.schedulePostWorkshop('dr-1', { sales, startedAt: START, endedAt: END, now: END });
  const tick = (now) => emails.runDataReminderStep({ mode: 'auto', now }, sales.getSalesClientById('dr-1'));
  const day = (n, minutes = 0) => new Date(Date.parse(DUE) + n * 86_400_000 + minutes * 60_000).toISOString();
  assert.equal((await tick(day(4, -1))).wrote, false);
  assert.equal((await tick(day(4, 1))).wrote, true);
  assert.equal((await tick(day(5))).wrote, false, 'the next one waits afterDays again');
  assert.equal((await tick(day(8, 2))).wrote, true);
  assert.equal((await tick(day(30))).wrote, false, 'at most max reminders');
  const records = shadowRecords('dr-1');
  assert.equal(records.length, 2);
  assert.ok(records.every((item) => /Påminnelse/.test(item.subject)));
  assert.equal(transport.length, 0);
  // Nothing to ask for: no reminder.
  seed('dr-2', { contactPhone: '+47 00 00 00 00', workshop: { heldAt: END } });
  emails.schedulePostWorkshop('dr-2', { sales, startedAt: START, endedAt: END, now: END });
  const complete = {
    getProfile: () => ({ clientDataBank: {
      brandIdentity: { logos: { normal: 'logo.svg' } },
      generalInfo: { companyPhone: '+47 00 00 00 00', companyEmail: 'post@example.com', companyAddress: 'Example street 1' },
      websiteCreatorQuestions: { businessWhat: 'Example description', websiteDomain: 'example.com' },
      media: { mainHeroImages: ['a.jpg', 'b.jpg', 'c.jpg'] },
      openingHours: { days: [{ day: 'Mandag', opensAt: '09:00', closesAt: '17:00', closed: false }] },
    } }),
  };
  const none = await emails.runDataReminderStep({ mode: 'auto', now: day(5), emailDeps: complete }, sales.getSalesClientById('dr-2'));
  assert.equal(none.skipped, 'nothing-to-ask');
  save({ emails: { dataReminder: { enabled: false, mode: 'shadow' } } });
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  const as = (key, user) => (req, _res, next) => {
    req[key] = user;
    next();
  };
  register(app, {
    developmentAuth: as('developmentUser', { role: 'admin', isAdmin: true, username: 'admin', accountKey: 'admin' }),
    salesAuth: as('salesUser', { isAdmin: true, username: 'alexander@asoldi.com', name: 'Alexander' }),
    sales,
    hub,
  });
  app.post('/api/admin/sales/:id/workshop/desk-email', (req, res) => res.json({ legacy: true, kind: req.body?.kind }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolveListen) => server.once('listening', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('routes: 404 disabled while the gate is off; the desk route is untouched for every other kind', async () => {
  save({ gate: { enabled: false } });
  seed('rt-1');
  await withServer(async (base) => {
    assert.deepEqual((await call(base, 'GET', '/api/admin/delivery/gate')).body.code, 'disabled');
    assert.equal((await call(base, 'GET', '/api/admin/delivery/gate/rt-1')).status, 404);
    assert.equal((await call(base, 'POST', '/api/admin/sales/rt-1/workshop/held', {})).body.code, 'disabled');
    assert.equal((await call(base, 'PUT', '/api/admin/delivery/gate/rt-1/waivers/logo', { option: 'Bruk tekstlogo' })).status, 404);
    assert.deepEqual((await call(base, 'POST', '/api/admin/sales/rt-1/workshop/desk-email', { kind: 'post-workshop' })).body, { legacy: true, kind: 'post-workshop' });
    assert.deepEqual((await call(base, 'POST', '/api/admin/sales/rt-1/workshop/desk-email', { kind: 'data-innsamling-1' })).body, { legacy: true, kind: 'data-innsamling-1' });
  });
  assert.equal(sales.getSalesClientById('rt-1').delivery ?? null, null);
});

test('routes with the gate on: the gate view, waivers, workshop held and the manual post-workshop mail', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('rt-2');
  await withServer(async (base) => {
    const list = await call(base, 'GET', '/api/admin/delivery/gate');
    assert.equal(list.status, 200);
    assert.ok(list.body.clients.some((client) => client.clientId === 'rt-2' && client.mode === 'shadow'));
    const view = await call(base, 'GET', '/api/admin/delivery/gate/rt-2');
    assert.equal(view.status, 200);
    assert.equal(view.body.stale, true);
    assert.ok(view.body.askable.rows.length > 0);
    assert.equal(sales.getSalesClientById('rt-2').delivery?.gate ?? null, null, 'viewing writes nothing');
    const waived = await call(base, 'PUT', '/api/admin/delivery/gate/rt-2/waivers/logo', { option: 'Bruk tekstlogo' });
    assert.equal(waived.status, 200);
    assert.equal(waived.body.gate.lines.find((line) => line.id === 'logo').status, 'waived');
    assert.equal((await call(base, 'PUT', '/api/admin/delivery/gate/rt-2/waivers/logo', { option: 'Something else' })).status, 400);
    const evaluated = await call(base, 'POST', '/api/admin/delivery/gate/rt-2/evaluate', {});
    assert.equal(evaluated.body.gate.waivers.logo.option, 'Bruk tekstlogo');
    // A one-hour workshop that ended an hour ago (the route refuses times in the future, and a due
    // time more than a day old is not stored).
    const endMs = Math.floor((Date.now() - 60 * 60_000) / 60_000) * 60_000;
    const iso = (ms) => new Date(ms).toISOString();
    const [heldStart, heldEnd, heldDue] = [iso(endMs - 60 * 60_000), iso(endMs), iso(endMs + 120 * 60_000)];
    // Workshop times must be ISO times that are not in the future; nothing is written otherwise.
    for (const body of [{ endedAt: 'yesterday' }, { endedAt: '2999-01-01T10:00:00.000Z' }, { startedAt: heldEnd, endedAt: heldStart }, { durationMinutes: -5 }]) {
      const refused = await call(base, 'POST', '/api/admin/sales/rt-2/workshop/held', body);
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
    assert.equal(sales.getSalesClientById('rt-2').workshop?.heldAt ?? '', '', 'a refused request marks nothing held');
    assert.equal(deliveryEmailStamps(sales.getSalesClientById('rt-2')).postWorkshopDueAt, '');
    const held = await call(base, 'POST', '/api/admin/sales/rt-2/workshop/held', { startedAt: heldStart, endedAt: heldEnd });
    assert.equal(held.status, 200);
    assert.equal(held.body.postWorkshopDueAt, heldDue);
    assert.equal(sales.getSalesClientById('rt-2').workshop.heldAt, heldEnd);
    assert.equal(held.body.heldAt, heldEnd, 'the stored heldAt');
    // Held again with another end: the first heldAt stays and is what the route answers.
    const again = await call(base, 'POST', '/api/admin/sales/rt-2/workshop/held', { endedAt: iso(endMs + 30 * 60_000) });
    assert.equal(again.body.heldAt, heldEnd);
    assert.equal(again.body.reason, 'already-scheduled');
    // A workshop that ended three days ago is marked held, but no mail is scheduled any more.
    seed('rt-stale');
    const staleEnd = iso(endMs - 3 * 86_400_000);
    const stale = await call(base, 'POST', '/api/admin/sales/rt-stale/workshop/held', { endedAt: staleEnd });
    assert.equal(stale.status, 200);
    assert.deepEqual([stale.body.heldAt, stale.body.scheduled, stale.body.reason, stale.body.postWorkshopDueAt], [staleEnd, false, 'stale', '']);
    assert.equal(deliveryEmailStamps(sales.getSalesClientById('rt-stale')).postWorkshopDueAt, '');
    // The manual desk kind in shadow (the gate is shadow-only): a shadow record, nothing sent.
    const before = transport.length;
    const desk = (body) => call(base, 'POST', '/api/admin/sales/rt-2/workshop/desk-email', { kind: 'post-workshop', ...body });
    const recorded = await desk({});
    assert.equal(recorded.status, 200);
    assert.deepEqual([recorded.body.sent, recorded.body.shadow, recorded.body.status], [false, true, 'shadow']);
    assert.equal(recorded.body.client, undefined, 'the raw client record is not returned');
    assert.equal(recorded.body.emails.postWorkshopSentAt, '');
    assert.equal(shadowRecords('rt-2').length, 1);
    assert.equal((await emails.shadowMailsFor('rt-2', { dataDir: DATA_DIR }))[0].key, 'postWorkshop:rt-2:manual');
    // A second press records nothing new; force records a fresh draft.
    assert.equal((await desk({})).body.status, 'already-recorded');
    assert.equal(shadowRecords('rt-2').length, 1);
    assert.equal((await desk({ force: true })).body.status, 'shadow');
    assert.equal(shadowRecords('rt-2').length, 2);
    // Off or paused: 409 and nothing is drafted.
    save({ emails: { postWorkshop: { enabled: false } } });
    const off = await desk({});
    assert.deepEqual([off.status, off.body.code], [409, 'off']);
    save({ emails: { postWorkshop: { enabled: true, paused: { reason: 'test pause' } } } });
    const paused = await desk({ force: true });
    assert.deepEqual([paused.status, paused.body.code], [409, 'paused']);
    save({ emails: { postWorkshop: { paused: null } } });
    assert.equal(shadowRecords('rt-2').length, 2);
    assert.equal(transport.length, before, 'in shadow, off or paused the desk kind sends nothing');
    assert.equal(deliveryEmailStamps(sales.getSalesClientById('rt-2')).postWorkshopSentAt, '');
    // Other kinds still go to the existing desk route.
    assert.deepEqual((await call(base, 'POST', '/api/admin/sales/rt-2/workshop/desk-email', { kind: 'data-innsamling-2' })).body, { legacy: true, kind: 'data-innsamling-2' });
  });
  save({ gate: { enabled: false } });
});

test('the manual post-workshop desk mail in auto: two presses send once, a sent mail needs force', async () => {
  const file = join(DATA_DIR, 'automation-settings.json');
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const defaults = settingsStore.defaultAutomationSettings();
  // Written to the settings file directly: the settings route refuses a gate in auto for now.
  writeFileSync(file, JSON.stringify({
    ...defaults,
    pilotClientIds: ['rt-auto'],
    gate: { enabled: true, mode: 'auto', paused: null },
    emails: { ...defaults.emails, postWorkshop: { ...defaults.emails.postWorkshop, enabled: true, mode: 'auto' } },
  }));
  settingsStore.invalidateAutomationSettingsCache();
  try {
    seed('rt-auto');
    seed('rt-not-pilot');
    await withServer(async (base) => {
      const desk = (id, body = {}) => call(base, 'POST', `/api/admin/sales/${id}/workshop/desk-email`, { kind: 'post-workshop', ...body });
      const before = transport.length;
      const both = await Promise.all([desk('rt-auto'), desk('rt-auto')]);
      assert.deepEqual(both.map((result) => result.status).sort(), [200, 409]);
      const ok = both.find((result) => result.status === 200);
      assert.deepEqual([ok.body.sent, ok.body.shadow, ok.body.status], [true, false, 'sent']);
      assert.ok(['busy', 'already-sent'].includes(both.find((result) => result.status === 409).body.code));
      assert.equal(transport.length, before + 1, 'two presses at once send once');
      assert.ok(ok.body.emails.postWorkshopSentAt);
      const third = await desk('rt-auto');
      assert.deepEqual([third.status, third.body.code], [409, 'already-sent']);
      assert.equal(transport.length, before + 1);
      const forced = await desk('rt-auto', { force: true });
      assert.deepEqual([forced.status, forced.body.sent], [200, true]);
      assert.equal(transport.length, before + 2, 'force sends again');
      // A client that is not a pilot is in shadow: a record, no send.
      const other = await desk('rt-not-pilot');
      assert.deepEqual([other.status, other.body.sent, other.body.shadow], [200, false, true]);
      assert.equal(transport.length, before + 2);
      assert.equal(shadowRecords('rt-not-pilot').length, 1);
    });
  } finally {
    if (previous === null) rmSync(file, { force: true });
    else writeFileSync(file, previous);
    settingsStore.invalidateAutomationSettingsCache();
  }
});

test('routes while the gate is paused: views answer, every write answers 409 and writes nothing', async () => {
  save({ gate: { enabled: true, mode: 'shadow', paused: { reason: 'test pause' } } });
  seed('rt-paused');
  const before = JSON.stringify(sales.getSalesClientById('rt-paused'));
  await withServer(async (base) => {
    assert.equal((await call(base, 'GET', '/api/admin/delivery/gate/rt-paused')).status, 200);
    const writes = [
      ['POST', '/api/admin/delivery/gate/rt-paused/evaluate', {}],
      ['PUT', '/api/admin/delivery/gate/rt-paused/waivers/logo', { option: 'Bruk tekstlogo' }],
      ['DELETE', '/api/admin/delivery/gate/rt-paused/waivers/logo', undefined],
      ['POST', '/api/admin/delivery/gate/rt-paused/approve', {}],
      ['POST', '/api/admin/sales/rt-paused/workshop/held', { startedAt: START, endedAt: END }],
      ['POST', '/api/admin/sales/rt-paused/workshop/desk-email', { kind: 'post-workshop' }],
    ];
    for (const [method, path, body] of writes) {
      const result = await call(base, method, path, body);
      assert.equal(result.status, 409, `${method} ${path}`);
      assert.equal(result.body.code, 'paused', `${method} ${path}`);
    }
  });
  assert.equal(JSON.stringify(sales.getSalesClientById('rt-paused')), before, 'nothing written while paused');
  save({ gate: { enabled: false, paused: null } });
});

test('the gate view shows an admin the client\'s shadow mails', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('view-1');
  emails.schedulePostWorkshop('view-1', { sales, endedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  const recorded = await emails.runPostWorkshopStep({ mode: 'auto', now: new Date().toISOString() }, sales.getSalesClientById('view-1'));
  assert.equal(recorded.status, 'shadow');
  await withServer(async (base) => {
    const view = await call(base, 'GET', '/api/admin/delivery/gate/view-1');
    assert.equal(view.status, 200);
    assert.equal(view.body.shadowMails.length, 1);
    assert.equal(view.body.shadowMails[0].kind, 'postWorkshop');
    assert.equal(view.body.shadowMails[0].purged, false);
    assert.match(view.body.shadowMails[0].text, /Takk for workshopen/);
    assert.deepEqual(view.body.shadowMails[0].to, ['view-1@example.com']);
  });
  save({ gate: { enabled: false } });
});
