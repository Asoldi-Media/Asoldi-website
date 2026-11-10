// Signing and gate rules that must hold on every signing path (repros of earlier findings, invented
// businesses on a temp data dir):
//   - a site reached through the client's own hub link that belongs to another client is never
//     changed, also when the client is already signed (the got-client retry);
//   - a pilot whose offer has two alternatives and whose contract came in on paper or by e-mail can
//     still be signed once a person picks the alternative;
//   - with the gate in shadow, today's pre-workshop mail still goes out and the gate's version is only
//     a shadow record;
//   - the desk's post-workshop mail never reaches the transport in shadow;
//   - a scheduled post-workshop due time is never in the past.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-delivery-residuals-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT|HUB_SAFE)/.test(key)) delete process.env[key];
process.env.RESEND_API_KEY = 're_standin_for_tests';

// The mail transport is a stand-in: every send to the mail API is counted here.
const transport = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === 'https://api.resend.com/emails') {
    transport.push(JSON.parse(String(init.body || '{}')));
    return new Response(JSON.stringify({ id: `stand-in-${transport.length}` }), { status: 200 });
  }
  throw new Error(`no network in tests: ${url}`);
};
test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const T0 = '2026-10-20T09:00:00.000Z';
const T1 = '2026-10-21T09:00:00.000Z';
const { buildOfferFromMeetingQuote } = await import('../lib/offer-from-quote.js');
const vocab = await import('../packages/suite/core/delivery/vocab.js');

function sentOffer(id, salesClientId, quote) {
  const built = buildOfferFromMeetingQuote(quote);
  return {
    id,
    salesClientId,
    ownerId: '',
    status: 'sent',
    tierId: built.tierId,
    billing: built.billing,
    products: built.products,
    alternatives: built.alternatives,
    plan: built.plan,
    pricing: built.pricing,
    email: { subject: 'Tilbud på nettside', preheader: '', html: '<p>Tilbud</p>' },
    sentAt: T1,
    sentTo: `${salesClientId}@example.com`,
    createdAt: T0,
    updatedAt: T1,
  };
}

function client(id, name, extra = {}) {
  return {
    id,
    product: 'asoldi',
    status: 'active',
    ownerId: '',
    businessName: name,
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    clientEmail: `${id}@example.com`,
    progression: { meetingHeld: true, offerSent: true },
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const plan = (tierId, extra = {}) => ({
  version: 1, status: 'active', tierId, services: vocab.servicesForTier(tierId), pages: 5, billing: 'month',
  source: 'portal-accept', offerId: `offer-${tierId}`, alternativeIndex: 0, signedAt: T0, history: [], ...extra,
});

const PILOTS = ['rs-copy', 'rs-dual'];
writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  client('rs-owner', 'Fjordlys Keramikk AS', {
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: T0,
    websiteDomain: 'fjordlys.example.com',
    hubSite: { id: 'site-rs-owned', siteKey: 'key-rs-owned', domain: 'fjordlys.example.com', createdAt: T0 },
    sitePlan: plan('tier-1-standard', { appliedSiteId: 'site-rs-owned' }),
  }),
  // A signed lead whose hub link was copied from the client above.
  client('rs-copy', 'Kopilenke Verksted AS', {
    progression: { meetingHeld: true, offerSent: true, contractSigned: true },
    contractSignedAt: T0,
    websiteDomain: 'fjordlys.example.com',
    hubSite: { id: 'site-rs-owned', siteKey: 'key-rs-owned', domain: 'fjordlys.example.com', createdAt: T0 },
    sitePlan: plan('tier-3-ecommerce'),
  }),
  client('rs-dual', 'Tovalg Bakeri AS'),
], null, 2));
writeFileSync(join(DATA_DIR, 'sites.json'), JSON.stringify([{
  id: 'site-rs-owned',
  site_key: 'key-rs-owned',
  name: 'Fjordlys Keramikk AS',
  domain: 'fjordlys.example.com',
  websitePlan: 'tier-1-standard',
  features: { users: true, analytics: true },
  deliveryPhase: 'client',
  createdAt: T0,
  planSource: { kind: 'offer', salesClientId: 'rs-owner', tierId: 'tier-1-standard', services: vocab.servicesForTier('tier-1-standard') },
}], null, 2));
writeFileSync(join(DATA_DIR, 'sales-offers.json'), JSON.stringify([
  sentOffer('so-rs-dual', 'rs-dual', { tierId: 'starter', selected: [], pages: 5, altQuote: { tierId: 'seo', selected: [], pages: 7 } }),
], null, 2));
writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
  pilotClientIds: PILOTS,
  signing: { enabled: true, mode: 'auto', paused: null },
  releases: { signing: { passedAt: '2026-10-31T10:00:00.000Z', suite: 'residual-test', evidence: '', by: 'test' } },
}, null, 2));

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const signing = await import('../lib/contract-signing.js');
const apply = await import('../lib/site-plan-apply.js');
const prep = await import('../lib/workshop-prep-send.js');
const emails = await import('../lib/delivery-emails.js');
const { listOutbox } = await import('../lib/safe-mode-outbox.js');
const { deliveryEmailStamps } = await import('../lib/delivery-state.js');
// A module imported before the settings file above was written may have cached the defaults.
settingsStore.invalidateAutomationSettingsCache();

const HOOKS = { freezeAgreedKeywords: async () => {}, askableLines: async () => null };
const SENDER = { name: 'Alexander', fullName: 'Alexander', fromEmail: 'alexander@asoldi.com', from: 'Alexander fra Asoldi <alexander@asoldi.com>', replyTo: 'alexander@asoldi.com' };
const GATE_DEPS = { fetchMakerRun: async () => ({ failed: true }), listMail: async () => ({ messages: [] }) };
const sitesFile = () => readFileSync(join(DATA_DIR, 'sites.json'), 'utf8');
const sendsTo = (id, from = 0) => transport.slice(from).filter((row) => JSON.stringify(row.to || '').includes(`${id}@example.com`));
const shadowOutbox = (id) => listOutbox(DATA_DIR, { limit: 500 }).items.filter((row) => row.channel === emails.SHADOW_CHANNEL && JSON.stringify(row.to || '').includes(`${id}@example.com`));

function writeSettings(patch) {
  const file = join(DATA_DIR, 'automation-settings.json');
  const current = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
  settingsStore.invalidateAutomationSettingsCache();
}

test('an already-signed client whose own hub link points at another client\'s site gets site-owned-elsewhere and changes nothing', async () => {
  const before = sitesFile();
  const located = apply.locateSiteForClient(sales.getSalesClientById('rs-copy'));
  assert.equal(located.via, 'key', 'found through the client\'s own site key');
  assert.equal(located.owner, 'rs-owner');
  // got-client in auto runs the signer first; on a signed client that is the already-signed branch.
  const signed = await signing.markContractSigned('rs-copy', { source: 'got-client', actor: 'test', hooks: HOOKS });
  assert.equal(signed.ok, true, JSON.stringify({ ...signed, client: undefined }));
  assert.equal(signed.alreadySigned, true);
  assert.equal(signed.site, null);
  assert.ok(signed.warnings.includes('plan-apply:site-owned-elsewhere'), JSON.stringify(signed.warnings));
  // A second call (the rep's retry) says the same.
  const again = await signing.markContractSigned('rs-copy', { source: 'got-client', actor: 'test', hooks: HOOKS });
  assert.ok(again.warnings.includes('plan-apply:site-owned-elsewhere'));
  const placed = await signing.siteForGotClient('rs-copy', again, { create: () => assert.fail('no site is created') });
  assert.deepEqual([placed.site, placed.owner], [null, 'rs-owner']);
  assert.equal(sitesFile(), before, 'the other client\'s site is unchanged');
  assert.equal(sales.getSalesClientById('rs-copy').sitePlan.appliedSiteId, '');
});

test('a pilot with a two-alternative offer signed on paper or by e-mail is signed once a person picks the alternative', async () => {
  const waiting = await signing.markContractSigned('rs-dual', { source: 'inbox-contract', actor: 'inbox', hooks: HOOKS });
  assert.equal(waiting.status, 409);
  assert.equal(waiting.needsChoice, true);
  assert.equal(waiting.alternatives.length, 2);
  let client = sales.getSalesClientById('rs-dual');
  assert.notEqual(client.progression.contractSigned, true, 'nothing signed without a choice');
  assert.ok(client.nextActions.some((action) => action.name === signing.CHOOSE_ALTERNATIVE_ACTION_NAME && !action.doneAt), 'the rep sees the choice');
  const pending = signing.pendingSigningChoice(client);
  assert.equal(pending.contractReceived, true);
  assert.equal(pending.alternatives.length, 2);
  // The card signs the alternative the client picked (the Kontrakt tick with chosenOfferIndex).
  const before = transport.length;
  const picked = await signing.markContractSigned('rs-dual', { source: 'progression', actor: 'test', alternativeIndex: 1, fastTrack: true, sender: SENDER, hooks: HOOKS });
  assert.equal(picked.ok, true, JSON.stringify(picked));
  client = sales.getSalesClientById('rs-dual');
  assert.equal(client.progression.contractSigned, true);
  assert.equal(client.sitePlan.alternativeIndex, 1);
  assert.equal(client.sitePlan.tierId, pending.alternatives.find((row) => row.index === 1).tierId);
  assert.equal(sendsTo('rs-dual', before).length, 1, 'one pre-workshop mail');
  assert.equal(signing.pendingSigningChoice(client), null);
});

test('with the gate in shadow, today\'s pre-workshop mail goes out once and the gate\'s mail is only a shadow record', async () => {
  settingsStore.recordReleasePass('emails.preWorkshop.gate', { suite: 'residual-test' });
  writeSettings({ gate: { enabled: true, mode: 'shadow', paused: null } });
  const saved = settingsStore.saveAutomationSettings({ emails: { preWorkshop: { lines: 'gate' } } });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  sales.createSalesClient(client('rs-pre', 'Skogly Snekkeri AS', { progression: { contractSigned: true }, contractSignedAt: '2026-11-01T09:00:00.000Z' }));
  sales.setSalesSitePlan('rs-pre', plan('tier-2-seo'), { by: 'test' });
  const before = transport.length;
  const result = await prep.sendPreWorkshopAfterContractSigned(sales.getSalesClientById('rs-pre'), { sender: SENDER, previousSigned: false, ...GATE_DEPS });
  assert.equal(result.sent, true);
  assert.equal(result.gateShadow.status, 'shadow');
  assert.equal(sendsTo('rs-pre', before).length, 1, 'today\'s mail reached the transport once');
  assert.equal(shadowOutbox('rs-pre').length, 1, 'the gate\'s version is one shadow record');
});

test('the desk post-workshop mail in shadow is recorded, never sent; off sends nothing either', async () => {
  writeSettings({ gate: { enabled: true, mode: 'shadow', paused: null } });
  sales.createSalesClient(client('rs-desk', 'Elvekant Kafe AS', { progression: { contractSigned: true }, contractSignedAt: '2026-11-01T09:00:00.000Z' }));
  sales.setSalesSitePlan('rs-desk', plan('tier-1-standard'), { by: 'test' });
  const before = transport.length;
  const deps = { ...GATE_DEPS, sales };
  const shadow = await emails.sendPostWorkshopNow(sales.getSalesClientById('rs-desk'), { sender: SENDER, deps });
  assert.equal(shadow.sent, false);
  assert.equal(shadow.shadow, true);
  assert.equal(shadow.status, 'shadow');
  const twice = await emails.sendPostWorkshopNow(sales.getSalesClientById('rs-desk'), { sender: SENDER, deps });
  assert.equal(twice.status, 'already-recorded', 'one record per client');
  assert.equal(sendsTo('rs-desk', before).length, 0, 'nothing reached the transport');
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('rs-desk')).postWorkshopSentAt, '');
  const saved = settingsStore.saveAutomationSettings({ emails: { postWorkshop: { enabled: false } } });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  settingsStore.invalidateAutomationSettingsCache();
  const off = await emails.sendPostWorkshopNow(sales.getSalesClientById('rs-desk'), { sender: SENDER, deps });
  assert.deepEqual([off.sent, off.reason], [false, 'mode-off']);
  assert.equal(sendsTo('rs-desk', before).length, 0);
});

test('a post-workshop due time that has already passed is stored as now; a future one as computed', () => {
  writeSettings({ gate: { enabled: true, mode: 'shadow', paused: null } });
  const [start, end, due] = ['2026-11-03T10:00:00.000Z', '2026-11-03T11:00:00.000Z', '2026-11-03T13:00:00.000Z'];
  sales.createSalesClient(client('rs-due-late', 'Havbris Frisør AS', { progression: { contractSigned: true } }));
  const late = emails.schedulePostWorkshop('rs-due-late', { sales, startedAt: start, endedAt: end, now: '2026-11-03T15:30:00.000Z' });
  assert.deepEqual(late, { scheduled: true, dueAt: '2026-11-03T15:30:00.000Z', reason: '' });
  assert.equal(deliveryEmailStamps(sales.getSalesClientById('rs-due-late')).postWorkshopDueAt, '2026-11-03T15:30:00.000Z');
  sales.createSalesClient(client('rs-due-ahead', 'Lyngheia Gartneri AS', { progression: { contractSigned: true } }));
  const ahead = emails.schedulePostWorkshop('rs-due-ahead', { sales, startedAt: start, endedAt: end, now: '2026-11-03T11:05:00.000Z' });
  assert.deepEqual(ahead, { scheduled: true, dueAt: due, reason: '' });
  // More than a day late: still not scheduled at all.
  sales.createSalesClient(client('rs-due-stale', 'Nordvik Maleri AS', { progression: { contractSigned: true } }));
  assert.equal(emails.schedulePostWorkshop('rs-due-stale', { sales, startedAt: start, endedAt: end, now: '2026-11-05T13:00:00.000Z' }).reason, 'stale');
});
