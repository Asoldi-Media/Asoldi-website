// The post-workshop mail (two hours after the workshop) and the Datainnsamling reminders: due times,
// shadow and auto delivery, a restart between scheduling and sending, the ready variant, the manual
// desk kind, the workshop/held route, and the negative controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
  assert.deepEqual(emails.schedulePostWorkshop('off-1', { sales, startedAt: START, endedAt: END }), { scheduled: false, dueAt: '', reason: 'gate-off' });
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
  const scheduled = emails.schedulePostWorkshop('pw-1', { sales, startedAt: START, endedAt: END });
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
  emails.schedulePostWorkshop('pw-auto', { sales, startedAt: START, endedAt: END });
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
  emails.schedulePostWorkshop('pw-off', { sales, startedAt: START, endedAt: END });
  const result = await emails.runPostWorkshopStep({ mode: 'auto', now: '2026-11-03T14:00:00.000Z' }, sales.getSalesClientById('pw-off'));
  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'mode-off');
  assert.equal(shadowRecords('pw-off').length, 0);
  assert.equal(readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'email-shadow' && row.clientId === 'pw-off').length, 0);
  save({ emails: { postWorkshop: { enabled: true } } });
});

test('the Prosjektdokument schedules the mail from the recorded workshop', async () => {
  save({ gate: { enabled: true, mode: 'shadow' } });
  seed('pw-doc');
  const applied = await applyWorkshopTranscriptToRecord({
    client: sales.getSalesClientById('pw-doc'),
    workshopMeeting: { meetingId: 'm-doc', transcript: 'Workshop.', dateString: START, duration: 60 },
    force: true,
    generateDocument: async () => ({ goalExplanation: 'Mål', clientDocumentation: 'Dok', todos: [] }),
  });
  sales.setSalesWorkshop('pw-doc', applied.workshop);
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('pw-doc')).postWorkshopDueAt, DUE);
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
  emails.schedulePostWorkshop('dr-1', { sales, startedAt: START, endedAt: END });
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
  emails.schedulePostWorkshop('dr-2', { sales, startedAt: START, endedAt: END });
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
    const held = await call(base, 'POST', '/api/admin/sales/rt-2/workshop/held', { startedAt: START, endedAt: END });
    assert.equal(held.body.postWorkshopDueAt, DUE);
    assert.equal(sales.getSalesClientById('rt-2').workshop.heldAt, END);
    const before = transport.length;
    const sent = await call(base, 'POST', '/api/admin/sales/rt-2/workshop/desk-email', { kind: 'post-workshop' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.sent, true);
    assert.equal(transport.length, before + 1, 'the manual desk kind sends now');
    assert.ok(deliveryEmailStamps(sales.getSalesClientById('rt-2')).postWorkshopSentAt);
    // Other kinds still go to the existing desk route.
    assert.deepEqual((await call(base, 'POST', '/api/admin/sales/rt-2/workshop/desk-email', { kind: 'data-innsamling-2' })).body, { legacy: true, kind: 'data-innsamling-2' });
  });
  save({ gate: { enabled: false } });
});
