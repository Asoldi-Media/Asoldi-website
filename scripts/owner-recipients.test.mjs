import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-owner-recipients-'));
process.env.APP_DATA_DIR = dataDir;
process.env.SALES_CONTACT_EMAIL = 'salg@asoldi.test';
process.env.BOOKING_INBOX_EMAIL = 'booking@asoldi.test';

const store = await import('../data/email-store.js');
const owners = await import('../lib/owner-recipients.js');
const clientForms = await import('../lib/client-forms.js');
const { buildMessage, resolveBccHeader } = await import('../lib/email.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const fields = { name: 'Kari Kunde', email: 'kari@example.no', message: 'Har dere ledig time?' };
const pageUrl = 'https://frisor.example.no/kontakt';

function site(overrides = {}) {
  return { id: 'site_1', site_key: 'key_1', domain: 'frisor.example.no', name: 'Frisør Eksempel', clientAdmin: { email: '' }, ...overrides };
}

/** Exactly what server.js sent before WS7.39. */
function legacyPayload(target) {
  const email = clientForms.buildFormEmail({ site: target, fields, pageUrl });
  const replyTo = clientForms.replyToFromFields(fields);
  return {
    to: clientForms.resolveFormRecipient(target),
    subject: email.subject,
    text: email.text,
    html: email.html,
    replyTo: replyTo || undefined,
  };
}

function mailFor(target, options = {}) {
  const routing = owners.resolveFormRouting(target, { now: NOW, ...options });
  return clientForms.buildClientFormMail({ site: target, fields, pageUrl, routing });
}

test('WS7.39: owner order is confirmed owner recipients, then clientAdmin, then the linked sales client', () => {
  const salesClients = [{ id: 'c1', contactEmail: 'Salg.Kontakt@Example.no', hubSite: { siteKey: 'key_1' } }];
  const getSalesClients = () => salesClients;
  const confirmed = { ownerRecipients: [
    { email: 'eier@example.no', status: 'confirmed' },
    { email: 'venter@example.no', status: 'pending' },
  ] };
  assert.deepEqual(
    owners.resolveOwnerRecipients(site({ clientAdmin: { email: 'admin@example.no' } }), { emailSite: confirmed, getSalesClients }),
    { recipients: ['eier@example.no'], source: 'ownerRecipients' },
    'a pending address receives nothing',
  );
  assert.deepEqual(
    owners.resolveOwnerRecipients(site({ clientAdmin: { email: 'admin@example.no' } }), { emailSite: {}, getSalesClients }),
    { recipients: ['admin@example.no'], source: 'clientAdmin' },
  );
  assert.deepEqual(
    owners.resolveOwnerRecipients(site(), { emailSite: {}, getSalesClients }),
    { recipients: ['salg.kontakt@example.no'], source: 'salesClient' },
  );
  const byId = [{ contactEmail: 'id@example.no', hubSite: { id: 'site_1' } }];
  assert.deepEqual(owners.resolveOwnerRecipients(site(), { emailSite: {}, getSalesClients: () => byId }).recipients, ['id@example.no']);
  assert.deepEqual(owners.resolveOwnerRecipients(site(), { emailSite: {}, getSalesClients: () => [] }), { recipients: [], source: 'none' });
  assert.deepEqual(
    owners.resolveOwnerRecipients(site(), { emailSite: {}, getSalesClients: () => { throw new Error('sales file busy'); } }),
    { recipients: [], source: 'none' },
    'a sales read failure never breaks a form',
  );
});

test('WS7.39 (d): name-only and domain-only sales client matches are not used', () => {
  const salesClients = [
    { contactEmail: 'navn@example.no', businessName: 'Frisør Eksempel', hubSite: {} },
    { contactEmail: 'domene@example.no', websiteDomain: 'frisor.example.no', hubSite: { domain: 'frisor.example.no' } },
    { contactEmail: 'annen@example.no', hubSite: { siteKey: 'key_other', id: 'site_other' } },
  ];
  const result = owners.resolveOwnerRecipients(site(), { emailSite: {}, getSalesClients: () => salesClients });
  assert.deepEqual(result, { recipients: [], source: 'none' });
  assert.equal(owners.salesClientLinkedToSite(site(), salesClients[0]), false);
  assert.equal(owners.salesClientLinkedToSite(site(), salesClients[1]), false);
});

test('WS7.39 (c): with ownerRouting unset the mail is byte-identical to today', () => {
  const target = site({ clientAdmin: { email: 'admin@example.no' } });
  // No email-sites.json at all.
  assert.deepEqual(mailFor(target), legacyPayload(target));
  assert.equal('bcc' in mailFor(target), false, 'the transport keeps its default copy behaviour');
  assert.equal(mailFor(target).to, 'booking@asoldi.test');
  // A row exists but the switch is unset.
  assert.deepEqual(mailFor(target, { emailSite: { ownerRouting: '' } }), legacyPayload(target));
  assert.deepEqual(clientForms.buildClientFormMail({ site: target, fields, pageUrl }), legacyPayload(target));
});

test('WS7.39 (c): an unreadable email-sites.json keeps today\'s routing', () => {
  const live = join(dataDir, 'email-sites.json');
  writeFileSync(live, '{"site_1": {', 'utf8');
  const target = site({ clientAdmin: { email: 'admin@example.no' } });
  assert.deepEqual(mailFor(target), legacyPayload(target));
  unlinkSync(live);
});

test('WS7.39 (a): owner+asoldi-bcc mails the owner with BCC to SALES_CONTACT_EMAIL', async () => {
  await store.patchEmailSite('site_1', { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: new Date(NOW - 2 * DAY).toISOString() });
  const target = site({ clientAdmin: { email: 'admin@example.no' } });
  const mail = mailFor(target);
  assert.equal(mail.to, 'admin@example.no');
  assert.equal(mail.bcc, 'salg@asoldi.test');
  assert.equal(mail.subject, legacyPayload(target).subject);
  assert.equal(mail.replyTo, 'kari@example.no');
  assert.equal(mail.text, legacyPayload(target).text);
  assert.equal(resolveBccHeader(mail.bcc, mail.to), 'salg@asoldi.test', 'the transport sends the BCC');
});

test('WS7.39: on the SMTP transport an explicit BCC is in the envelope, so it is delivered', () => {
  const saved = { user: process.env.SMTP_USER, bcc: process.env.SMTP_BCC };
  process.env.SMTP_USER = 'smtp-user@asoldi.test';
  delete process.env.SMTP_BCC;
  try {
    const copied = buildMessage({ to: 'admin@example.no', bcc: 'salg@asoldi.test', subject: 's', text: 't' });
    assert.deepEqual(copied.envelope.to, ['admin@example.no', 'salg@asoldi.test']);
    assert.equal(copied.bcc, 'salg@asoldi.test');
    const ownerOnly = buildMessage({ to: 'admin@example.no', bcc: false, subject: 's', text: 't' });
    assert.equal(ownerOnly.envelope.to, 'admin@example.no');
    assert.equal(ownerOnly.bcc, undefined);
    const legacy = buildMessage({ to: 'booking@asoldi.test', subject: 's', text: 't' });
    assert.equal(legacy.envelope.to, 'booking@asoldi.test', 'the default copy keeps the old envelope');
  } finally {
    if (saved.user === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = saved.user;
    if (saved.bcc !== undefined) process.env.SMTP_BCC = saved.bcc;
  }
});

test('WS7.39: the Asoldi BCC stops 30 days after the switch; owner mode never copies Asoldi', async () => {
  const target = site({ clientAdmin: { email: 'admin@example.no' } });
  await store.patchEmailSite('site_1', { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: new Date(NOW - 31 * DAY).toISOString() });
  const late = mailFor(target);
  assert.equal(late.to, 'admin@example.no');
  assert.equal(late.bcc, false);
  assert.equal(resolveBccHeader(late.bcc, late.to), '', 'false also turns off the default SMTP copy');
  await store.patchEmailSite('site_1', { ownerRouting: 'owner', ownerRoutingSetAt: new Date(NOW).toISOString() });
  assert.equal(mailFor(target).bcc, false);
  const routing = owners.resolveFormRouting(target, { now: NOW, emailSite: { ownerRouting: 'owner+asoldi-bcc' } });
  assert.equal(routing.bcc, 'salg@asoldi.test', 'no timestamp keeps the copy');
});

test('WS7.39 (b): a site with no owner falls back to the inbox with the [Ingen eier-e-post satt] prefix', async () => {
  await store.patchEmailSite('site_1', { ownerRouting: 'owner+asoldi-bcc', ownerRoutingSetAt: new Date(NOW).toISOString() });
  const target = site();
  const mail = mailFor(target, { getSalesClients: () => [] });
  assert.equal(mail.to, 'booking@asoldi.test');
  assert.equal(mail.subject, `[Ingen eier-e-post satt] ${legacyPayload(target).subject}`);
  assert.equal('bcc' in mail, false, 'the fallback already is the Asoldi inbox');
});

test('WS7.39: multiple confirmed owners all receive the notice', async () => {
  await store.patchEmailSite('site_1', {
    ownerRouting: 'owner',
    ownerRecipients: [
      { email: 'a@example.no', status: 'confirmed' },
      { email: 'b@example.no', status: 'confirmed' },
    ],
  });
  assert.equal(mailFor(site()).to, 'a@example.no, b@example.no');
  await store.patchEmailSite('site_1', { ownerRecipients: [] });
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  const adminAuth = (req, res, next) => (req.get('authorization') === 'Bearer ok' ? ((req.admin = { username: 'superadmin' }), next()) : res.status(401).json({ message: 'Unauthorized' }));
  const sites = { site_9: site({ id: 'site_9', site_key: 'key_9', clientAdmin: { email: '' } }) };
  let clock = NOW;
  owners.registerOwnerRoutingRoutes(app, {
    adminAuth,
    getSiteById: (id) => sites[id] || null,
    getSalesClients: () => [{ contactEmail: 'kort@example.no', hubSite: { siteKey: 'key_9' } }],
    now: () => clock,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, auth = 'Bearer ok') => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  try {
    await fn({ call, tick: (ms) => { clock += ms; } });
  } finally {
    server.close();
  }
}

test('WS7.39: Superadmin reads and sets the routing per site', async () => {
  await withServer(async ({ call, tick }) => {
    assert.equal((await call('GET', '/api/hub/sites/site_9/owner-routing', null, '')).status, 401);
    assert.equal((await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner' }, '')).status, 401);
    assert.equal((await call('GET', '/api/hub/sites/nope/owner-routing')).status, 404);
    assert.equal((await call('PUT', '/api/hub/sites/nope/owner-routing', { ownerRouting: 'owner' })).status, 404);

    const initial = await call('GET', '/api/hub/sites/site_9/owner-routing');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.ownerRouting, '');
    assert.deepEqual(initial.body.owner, { recipients: ['kort@example.no'], source: 'salesClient' });
    assert.equal(initial.body.routing.to, 'booking@asoldi.test', 'unset still shows today\'s inbox');

    assert.equal((await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'everyone' })).status, 400);
    const on = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner+asoldi-bcc' });
    assert.equal(on.status, 200);
    assert.equal(on.body.ownerRouting, 'owner+asoldi-bcc');
    assert.equal(on.body.ownerRoutingSetAt, new Date(NOW).toISOString());
    assert.equal(on.body.routing.to, 'kort@example.no');
    assert.equal(on.body.routing.bcc, 'salg@asoldi.test');
    assert.equal(on.body.routing.bccUntil, new Date(NOW + 30 * DAY).toISOString());
    assert.equal(store.readEmailSite('site_9').ownerRoutingSetBy, 'superadmin');

    tick(DAY);
    const same = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner+asoldi-bcc' });
    assert.equal(same.body.ownerRoutingSetAt, new Date(NOW).toISOString(), 'saving the same mode keeps the BCC window');

    assert.equal((await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner+asoldi-bcc', ownerEmails: 'ok@example.no, ikke-epost' })).status, 400);
    assert.equal((await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner+asoldi-bcc', ownerEmails: ['a@example.no', 'b@example.no', 'c@example.no', 'd@example.no'] })).status, 400);
    const withOwner = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner+asoldi-bcc', ownerEmails: 'Eier@Example.no' });
    assert.equal(withOwner.status, 200);
    assert.deepEqual(withOwner.body.owner, { recipients: ['eier@example.no'], source: 'ownerRecipients' });
    assert.deepEqual(withOwner.body.ownerRecipients, [{ email: 'eier@example.no', status: 'confirmed', source: 'superadmin', confirmedAt: new Date(NOW + DAY).toISOString() }]);

    const off = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: '' });
    assert.equal(off.body.ownerRouting, '');
    assert.equal(off.body.routing.to, 'booking@asoldi.test');
    assert.equal(off.body.ownerRoutingSetAt, new Date(NOW + DAY).toISOString(), 'every switch restarts the window');
  });
});

test('WS7.39: a mode change never confirms a pending owner or rewrites confirmed rows (3.3.9 change control)', async () => {
  const confirmedAt = '2026-10-01T09:00:00.000Z';
  await store.patchEmailSite('site_9', {
    ownerRouting: '',
    ownerRecipients: [
      { email: 'eier@example.no', status: 'confirmed', confirmedAt, source: 'cms-owner' },
      { email: 'ny-eier@example.no', status: 'pending', confirmedAt: '', source: 'cms-owner-change' },
    ],
  });
  await withServer(async ({ call, tick }) => {
    tick(2 * DAY);
    const modeOnly = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner' });
    assert.equal(modeOnly.status, 200);
    assert.deepEqual(store.readEmailSite('site_9').ownerRecipients, [
      { email: 'eier@example.no', status: 'confirmed', confirmedAt, source: 'cms-owner' },
      { email: 'ny-eier@example.no', status: 'pending', confirmedAt: '', source: 'cms-owner-change' },
    ], 'nothing about the owners changed');
    assert.deepEqual(modeOnly.body.owner.recipients, ['eier@example.no'], 'the pending address receives nothing');

    // The confirmed set is sent back unchanged plus one new address: old provenance stays, the pending row stays pending.
    const added = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner', ownerEmails: 'eier@example.no, kontor@example.no' });
    assert.equal(added.status, 200);
    const rows = store.readEmailSite('site_9').ownerRecipients;
    assert.deepEqual(rows[0], { email: 'eier@example.no', status: 'confirmed', confirmedAt, source: 'cms-owner' });
    assert.deepEqual(rows[1], { email: 'kontor@example.no', status: 'confirmed', confirmedAt: new Date(NOW + 2 * DAY).toISOString(), source: 'superadmin' });
    assert.deepEqual(rows[2], { email: 'ny-eier@example.no', status: 'pending', confirmedAt: '', source: 'cms-owner-change' });
    assert.deepEqual(added.body.owner.recipients, ['eier@example.no', 'kontor@example.no']);

    // Only an explicit listing promotes the pending address.
    const promoted = await call('PUT', '/api/hub/sites/site_9/owner-routing', { ownerRouting: 'owner', ownerEmails: ['ny-eier@example.no'] });
    assert.equal(promoted.status, 200);
    assert.deepEqual(store.readEmailSite('site_9').ownerRecipients, [
      { email: 'ny-eier@example.no', status: 'confirmed', confirmedAt: new Date(NOW + 2 * DAY).toISOString(), source: 'superadmin' },
    ]);
  });
  await store.patchEmailSite('site_9', { ownerRecipients: [], ownerRouting: '' });
});

test('WS7.39: the Superadmin field shows and sends only confirmed addresses, and only when edited', () => {
  const source = readFileSync(new URL('../app/pages/Admin/sections/OwnerRoutingField.tsx', import.meta.url), 'utf8');
  assert.match(source, /filter\(\(row\) => row\.status === 'confirmed'\)/, 'pending rows are not put in the input');
  assert.match(source, /if \(!sameEmailList\(emails, confirmedEmails\(view\)\)\) body\.ownerEmails = emails;/, 'ownerEmails only when the field changed');
  assert.doesNotMatch(source, /JSON\.stringify\(\{ ownerRouting: mode, ownerEmails: emails \}\)/);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
