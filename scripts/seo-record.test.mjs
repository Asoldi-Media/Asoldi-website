// The SEO record (lib/seo-ops/record.js): the Maker's plan summary is kept without a portal user,
// a push keeps the other bank seo fields, agreed keywords round-trip through approve and block, and
// the limits hold. Every business here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-record-'));
process.env.APP_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
  { id: 'sc-record-1', businessName: 'Fjordlys Frisør AS', product: 'asoldi', status: 'active' },
  { id: 'sc-record-2', businessName: 'Testbakeriet', product: 'asoldi', status: 'active' },
], null, 2));

const record = await import('../lib/seo-ops/record.js');
const { applyMakerBundleToPortal } = await import('../lib/maker-bundle-sync.js');
const { makerBundleToClientDataBank } = await import('../lib/maker-bundle-to-bank.js');
const { agreedKeywordsContractText } = await import('../lib/seo-ops/contract-text.js');

function summary(extra = {}) {
  return {
    planVersion: 1,
    builtAt: '2026-10-30T10:00:00.000Z',
    language: { code: 'nb', name: 'Norwegian' },
    locale: { locationCode: 2578, languageCode: 'nb', country: 'Norway' },
    town: 'Eksempelby',
    counts: { primary: 2, secondary: 3, local: 1, questions: 0, brand: 1, rejected: 4, candidates: 40 },
    primaries: [{ keyword: 'frisør eksempelby', volume: 320, intent: 'commercial' }, { keyword: 'herreklipp eksempelby', volume: 90 }],
    candidates: [
      { keyword: 'frisør eksempelby', volume: 320, intent: 'commercial', role: 'home' },
      { keyword: 'balayage eksempelby', volume: 40, intent: 'commercial', role: 'services' },
      { keyword: 'hårfarge', volume: 900 },
    ],
    brand: [{ keyword: 'fjordlys frisør' }],
    spendUsd: 0.31,
    // Fields a summary never keeps.
    raw: { tasks: [{ result: [{ items: [{ keyword_info: { search_volume: 320 } }] }] }] },
    diagnostics: { calls: [{ endpoint: 'dataforseo_labs', costUsd: 0.1 }] },
    ...extra,
  };
}

test('a plan summary is recorded for a sales client without a portal user', async () => {
  const pushed = await record.recordPlanSummaryFromPush('sc-record-1', summary());
  assert.deepEqual(pushed, { seoRecorded: true });
  const portal = applyMakerBundleToPortal({ salesClientId: 'sc-record-1', bundle: { id: 'b1', data: { businessName: 'Fjordlys Frisør AS' } } });
  assert.equal(portal.ok, false);
  assert.equal(portal.status, 404, 'the portal sync still has no match; the SEO record does not need one');
  const stored = record.readSeoRecord('sc-record-1');
  assert.ok(stored);
  assert.deepEqual(stored.planSummary.candidates.map((row) => row.phrase), ['frisør eksempelby', 'balayage eksempelby', 'hårfarge']);
  assert.deepEqual(stored.planSummary.primaries[0], { phrase: 'frisør eksempelby', volume: 320, intent: 'commercial' });
  assert.deepEqual(stored.planSummary.brand, ['fjordlys frisør']);
  assert.equal(stored.planSummary.locale.locationCode, 2578);
  const text = readFileSync(join(dataDir, 'seo-ops', 'clients', 'sc-record-1.json'), 'utf8');
  assert.equal(text.includes('search_volume'), false, 'no raw provider payload is stored');
  assert.equal(text.includes('dataforseo_labs'), false);
  assert.equal(stored.history.filter((row) => row.action === 'plan-summary').length, 1);
});

test('the same summary pushed again writes nothing, and a new plan keeps the agreed keywords', async () => {
  await record.approveAgreedKeyword('sc-record-1', 'herreklipp eksempelby', { by: 'dev-a' });
  const path = join(dataDir, 'seo-ops', 'clients', 'sc-record-1.json');
  const before = readFileSync(path, 'utf8');
  const mtime = statSync(path).mtimeMs;
  assert.deepEqual(await record.recordPlanSummaryFromPush('sc-record-1', summary()), { seoRecorded: true });
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.deepEqual(await record.recordPlanSummaryFromPush('sc-record-1', summary({ builtAt: '2026-11-01T08:00:00.000Z' })), { seoRecorded: true });
  const stored = record.readSeoRecord('sc-record-1');
  assert.equal(stored.planSummary.builtAt, '2026-11-01T08:00:00.000Z');
  assert.deepEqual(record.agreedKeywordsFor(stored), ['herreklipp eksempelby']);
  assert.equal(stored.history.filter((row) => row.action === 'plan-summary').length, 2);
});

test('a push without a summary changes nothing and adds no response field', async () => {
  assert.equal(await record.recordPlanSummaryFromPush('sc-record-2', undefined), null);
  assert.deepEqual(record.seoPushResponseFields(null), {});
  assert.equal(existsSync(join(dataDir, 'seo-ops', 'clients', 'sc-record-2.json')), false);
});

test('unknown or missing sales clients are not recorded', async () => {
  assert.deepEqual(await record.recordPlanSummaryFromPush('sc-nobody', summary()), { seoRecorded: false, seoReason: 'unknown-sales-client' });
  assert.deepEqual(await record.recordPlanSummaryFromPush('', summary()), { seoRecorded: false, seoReason: 'no-sales-client' });
  assert.deepEqual(await record.recordPlanSummaryFromPush('sc-record-2', 'not an object'), { seoRecorded: false, seoReason: 'invalid-summary' });
  assert.deepEqual(record.seoPushResponseFields({ seoRecorded: false, seoReason: 'unknown-sales-client' }), { seoRecorded: false, seoReason: 'unknown-sales-client' });
  assert.equal(existsSync(join(dataDir, 'seo-ops', 'clients', 'sc-nobody.json')), false);
});

test('a bundle push keeps the other bank seo fields and replaces only the keyword plan', () => {
  const plan = { primary: [{ keyword: 'baker eksempelby' }] };
  const fallback = { seo: { keywordPlan: { primary: [] }, searchConsole: { property: 'sc-domain:example.com' }, notes: 'kept' } };
  const bank = makerBundleToClientDataBank({ keywordPlan: plan, data: { businessName: 'Testbakeriet' } }, fallback);
  assert.deepEqual(bank.seo, { keywordPlan: plan, searchConsole: { property: 'sc-domain:example.com' }, notes: 'kept' });
  const noPlan = makerBundleToClientDataBank({ data: { businessName: 'Testbakeriet' } }, fallback);
  assert.deepEqual(noPlan.seo.keywordPlan, { primary: [] }, 'no plan in the bundle keeps the stored plan');
  assert.equal(noPlan.seo.notes, 'kept');
  // The common case today: a bank whose seo holds only the plan gives the same object as before.
  assert.deepEqual(makerBundleToClientDataBank({ data: {} }, { seo: { keywordPlan: plan } }).seo, { keywordPlan: plan });
  assert.deepEqual(makerBundleToClientDataBank({ data: {} }, {}).seo, { keywordPlan: null });
});

test('approve and block round-trip, with history', async () => {
  const id = 'sc-record-2';
  await record.approveAgreedKeyword(id, '  Bakeri   Eksempelby ', { by: 'dev-a', source: 'developer' });
  let stored = record.readSeoRecord(id);
  assert.deepEqual(stored.agreedKeywords.map((row) => [row.phrase, row.status]), [['Bakeri Eksempelby', 'approved']]);
  await record.blockAgreedKeyword(id, 'bakeri eksempelby', { by: 'dev-b', reason: 'not a target' });
  stored = record.readSeoRecord(id);
  assert.deepEqual(stored.agreedKeywords.map((row) => [row.phrase, row.status, row.by]), [['bakeri eksempelby', 'blocked', 'dev-b']]);
  await record.approveAgreedKeyword(id, 'bakeri eksempelby', { by: 'dev-a' });
  stored = record.readSeoRecord(id);
  assert.equal(stored.agreedKeywords[0].status, 'approved');
  assert.deepEqual(stored.history.map((row) => [row.action, row.from]), [['approve', null], ['block', 'approved'], ['approve', 'blocked']]);
  assert.equal(record.recordGuidesConsumers(stored), true);
  // The same status again writes nothing.
  const path = join(dataDir, 'seo-ops', 'clients', `${id}.json`);
  const before = readFileSync(path, 'utf8');
  await record.approveAgreedKeyword(id, 'BAKERI EKSEMPELBY', { by: 'dev-c' });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('limits: at most three approved, 1-6 words, no prescription-only substance', async () => {
  const id = 'sc-record-2';
  await assert.rejects(
    record.updateClientSeo(id, { agreedKeywords: ['a b', 'c d', 'e f', 'g h'].map((phrase) => ({ phrase, status: 'approved' })) }, { by: 'dev-a' }),
    (error) => error.code === 'too-many-approved' && error.status === 400,
  );
  await assert.rejects(record.approveAgreedKeyword(id, 'en to tre fire fem seks sju'), (error) => error.code === 'too-many-words');
  await assert.rejects(record.approveAgreedKeyword(id, 'kjøp melatonin på nett'), (error) => error.code === 'regulated');
  await assert.rejects(record.approveAgreedKeyword(id, 'melatonintabletter'), (error) => error.code === 'regulated');
  await assert.rejects(record.approveAgreedKeyword(id, '   '), (error) => error.code === 'empty-phrase');
  await record.updateClientSeo(id, { agreedKeywords: [
    { phrase: 'bakeri eksempelby', status: 'approved' },
    { phrase: 'brød eksempelby', status: 'approved' },
    { phrase: 'kaker til selskap', status: 'approved' },
    { phrase: 'Kaker til selskap', status: 'blocked' },
    { phrase: 'surdeigsbrød', status: 'proposed', source: 'sales' },
  ] }, { by: 'dev-a' });
  const stored = record.readSeoRecord(id);
  assert.deepEqual(stored.agreedKeywords.map((row) => [row.phrase, row.status]), [
    ['bakeri eksempelby', 'approved'],
    ['brød eksempelby', 'approved'],
    ['Kaker til selskap', 'blocked'],
    ['surdeigsbrød', 'proposed'],
  ], 'duplicates collapse to the strongest status');
  await assert.rejects(
    record.updateClientSeo(id, { agreedKeywords: [{ phrase: 'x y', status: 'maybe' }] }),
    (error) => error.code === 'invalid-status',
  );
  assert.deepEqual(record.readSeoRecord(id).agreedKeywords.length, 4, 'a refused change writes nothing');
});

test('the own name is approved only when confirmed; a phrase that only resembles it is approved and flagged', async () => {
  const id = 'sc-record-1';
  const brandName = 'Fjordlys Frisør AS';
  // Exactly the name without its legal form (and the plan's brand search): refused without allowBrand.
  await assert.rejects(
    record.approveAgreedKeyword(id, 'Fjordlys Frisør', { by: 'dev-a', brandName }),
    (error) => error.code === 'brand' && error.status === 400 && error.message.includes('firmanavnet'),
  );
  assert.equal(record.readSeoRecord(id).agreedKeywords.some((row) => row.phrase === 'Fjordlys Frisør'), false, 'a refused approval writes nothing');
  await assert.rejects(
    record.updateClientSeo(id, { agreedKeywords: [...record.readSeoRecord(id).agreedKeywords, { phrase: 'fjordlys frisør', status: 'approved' }] }, { by: 'dev-a', brandName }),
    (error) => error.code === 'brand',
  );
  await record.approveAgreedKeyword(id, 'fjordlys frisør', { by: 'dev-a', brandName, allowBrand: true });
  let rows = record.readSeoRecord(id).agreedKeywords;
  const own = rows.find((entry) => entry.phrase === 'fjordlys frisør');
  assert.equal(own.status, 'approved');
  assert.deepEqual(own.flags, ['brand']);
  assert.equal('allowBrand' in own, false, 'the confirmation is not stored on the row');
  // A row that is already approved stays approved when the list is sent again without allowBrand.
  await record.updateClientSeo(id, { agreedKeywords: rows }, { by: 'dev-b', brandName });
  assert.equal(record.readSeoRecord(id).agreedKeywords.find((entry) => entry.phrase === 'fjordlys frisør').status, 'approved');
  // The name words in another order are not the name: approved without a confirmation, flagged.
  await record.approveAgreedKeyword(id, 'frisør fjordlys', { by: 'dev-a', brandName });
  rows = record.readSeoRecord(id).agreedKeywords;
  assert.deepEqual(rows.find((entry) => entry.phrase === 'frisør fjordlys').flags, ['brand']);
  // Approved rows are what the contract lists, flagged or not.
  assert.equal(agreedKeywordsContractText(record.readSeoRecord(id)), 'Avtalte søkeord: herreklipp eksempelby, fjordlys frisør, frisør fjordlys');
});

test('a short listed substance matches only at the start of a word; long ones also inside compounds', () => {
  for (const phrase of ['dental specialist eksempelby', 'specialized clinic', 'socialist', 'commercialisation', 'spesialist eksempelby']) {
    assert.equal(record.checkAgreedPhrase(phrase), phrase, `${phrase} is not regulated`);
  }
  for (const [phrase, term] of [['melatonintabletter', 'melatonin'], ['cialis eksempelby', 'cialis'], ['botoxbehandling', 'botox'], ['kjøp semaglutidpenn', 'semaglutid'], ['zopiklontabletter', 'zopiklon']]) {
    assert.throws(() => record.checkAgreedPhrase(phrase), (error) => error.code === 'regulated' && error.message.includes(`«${term}»`), phrase);
  }
});

test('a phrase whose substance is listed after it was stored never locks the list: it can be kept, removed or blocked', async () => {
  const id = 'sc-record-listed-later';
  const regulated = (error) => error.code === 'regulated' && error.status === 400;
  const at = '2026-10-01T10:00:00.000Z';
  // Written straight to the file, as rows stored before their substance was listed would be.
  const { createSeoOpsStore } = await import('../lib/seo-ops/store.js');
  await createSeoOpsStore().updateClient(id, (draft) => {
    draft.agreedKeywords = [
      { phrase: 'melatonin for barn', status: 'approved', source: 'developer', at, by: 'dev-a' },
      { phrase: 'helsekost eksempelby', status: 'approved', source: 'developer', at, by: 'dev-a' },
      { phrase: 'cialis eksempelby', status: 'proposed', source: 'plan', at, by: 'dev-a' },
    ];
  });
  const rows = () => record.readSeoRecord(id).agreedKeywords;
  const pairs = () => rows().map((row) => [row.phrase, row.status]);
  assert.equal(agreedKeywordsContractText(record.readSeoRecord(id)), 'Avtalte søkeord: helsekost eksempelby', 'the contract line already leaves it out');

  // A PUT that keeps every stored row and adds an ordinary one passes; the stored rows are unchanged.
  await record.updateClientSeo(id, { agreedKeywords: [...rows(), { phrase: 'urtete eksempelby', status: 'proposed' }] }, { by: 'dev-b' });
  assert.deepEqual(pairs(), [['melatonin for barn', 'approved'], ['helsekost eksempelby', 'approved'], ['cialis eksempelby', 'proposed'], ['urtete eksempelby', 'proposed']]);
  assert.equal(rows()[0].by, 'dev-a', 'a kept row keeps its author');

  // Still refused: a new proposal, a new approval, and a stored proposal turned into an approval.
  await assert.rejects(record.updateClientSeo(id, { agreedKeywords: [...rows(), { phrase: 'kjøp melatonin', status: 'proposed' }] }, { by: 'dev-b' }), regulated);
  await assert.rejects(record.approveAgreedKeyword(id, 'cialis eksempelby', { by: 'dev-b' }), regulated);
  await assert.rejects(record.updateClientSeo(id, { agreedKeywords: rows().map((row) => (row.phrase === 'cialis eksempelby' ? { ...row, status: 'approved' } : row)) }, { by: 'dev-b' }), regulated);
  assert.equal(pairs().length, 4, 'a refused change writes nothing');

  // The plan candidate can be blocked (the panel's block button), and so can a phrase never stored.
  await record.blockAgreedKeyword(id, 'cialis eksempelby', { by: 'dev-b' });
  await record.blockAgreedKeyword(id, 'viagra eksempelby', { by: 'dev-b' });
  // An approved one can go back to proposed, be blocked, or be removed (the panel's remove is a PUT without it).
  await record.updateClientSeo(id, { agreedKeywords: rows().map((row) => (row.phrase === 'melatonin for barn' ? { ...row, status: 'proposed' } : row)) }, { by: 'dev-b' });
  assert.equal(rows().find((row) => row.phrase === 'melatonin for barn').status, 'proposed');
  await record.blockAgreedKeyword(id, 'melatonin for barn', { by: 'dev-b' });
  await record.updateClientSeo(id, { agreedKeywords: rows().filter((row) => row.phrase !== 'melatonin for barn') }, { by: 'dev-b' });
  assert.deepEqual(pairs(), [['helsekost eksempelby', 'approved'], ['cialis eksempelby', 'blocked'], ['urtete eksempelby', 'proposed'], ['viagra eksempelby', 'blocked']]);
});

test('contract text, agreedKeywordsFor and freezeAgreedKeywords', async () => {
  const id = 'sc-record-2';
  const stored = record.readSeoRecord(id);
  assert.equal(agreedKeywordsContractText(stored), 'Avtalte søkeord: bakeri eksempelby, brød eksempelby');
  assert.equal(agreedKeywordsContractText(null), null);
  assert.equal(agreedKeywordsContractText({ agreedKeywords: [{ phrase: 'x', status: 'proposed' }] }), null);
  assert.deepEqual(record.agreedKeywordsFor(id), ['bakeri eksempelby', 'brød eksempelby']);
  assert.deepEqual(record.agreedKeywordsFor(id, { status: 'blocked' }), ['Kaker til selskap']);
  assert.deepEqual(record.agreedKeywordsFor('sc-nobody'), []);
  const frozen = await record.freezeAgreedKeywords(id, { ref: 'offer-1' });
  assert.deepEqual([...frozen.phrases], ['bakeri eksempelby', 'brød eksempelby']);
  assert.equal(frozen.contractText, 'Avtalte søkeord: bakeri eksempelby, brød eksempelby');
  assert.ok(Object.isFrozen(frozen));
  assert.equal(record.readSeoRecord(id).history.at(-1).action, 'freeze');
  assert.deepEqual(record.tickSteps, []);
  assert.ok(Object.isFrozen(record.tickSteps));
});

test('views: the Maker sees decided keywords only', () => {
  const view = record.makerSeoRecordView(record.readSeoRecord('sc-record-2'));
  assert.deepEqual(view.agreedKeywords.map((row) => row.status).sort(), ['approved', 'approved', 'blocked']);
  const admin = record.seoRecordView(record.readSeoRecord('sc-record-2'));
  assert.equal(admin.guidesConsumers, true);
  assert.equal(admin.contractText, 'Avtalte søkeord: bakeri eksempelby, brød eksempelby');
  assert.equal(record.seoRecordView(null), null);
});

test('a client with no record file reads as no record', () => {
  assert.equal(record.readSeoRecord('sc-none'), null);
  const linked = { id: 'sc-record-1', portalBusinessId: 'biz-1' };
  const profile = (salesClientId) => ({ businessId: 'biz-1', userId: 'user-1', clientDataBank: { makerLink: { salesClientId } } });
  assert.equal(record.seoRecordForProfile(profile('sc-none'), { readSalesClients: () => [linked] }), null);
  assert.equal(record.seoRecordForProfile({ businessId: 'biz-1', clientDataBank: {} }), null);
  assert.ok(record.seoRecordForProfile(profile('sc-record-1'), { readSalesClients: () => [linked] }));
  assert.equal(record.seoRecordForProfile(profile('sc-record-1')), null, 'sc-record-1 is linked to no portal business');
  assert.equal(record.recordGuidesConsumers(null), false);
  assert.equal(record.recordGuidesConsumers({ agreedKeywords: [{ phrase: 'x', status: 'proposed' }] }), false);
});

test('who may read or change a record: own sales clients, visible and workable developer clients, admins', async () => {
  const { seoRecordAccess } = await import('../lib/routes/seo-record-routes.js');
  const client = { id: 'sc-x', ownerId: 'sales:101', developerOwnerId: 'developer:201' };
  const rep = (userId, username = '') => ({ salesUser: { role: 'sales', isAdmin: false, userId, username, accountKey: `sales:${userId}` } });
  const dev = (userId) => ({ developmentUser: { role: 'developer', isAdmin: false, userId, accountKey: `developer:${userId}` } });
  const admin = { salesUser: { role: 'admin', isAdmin: true }, developmentUser: { role: 'admin', isAdmin: true } };
  assert.equal(seoRecordAccess(rep('101'), client), 'ok');
  assert.equal(seoRecordAccess(rep('999', 'rep-b@example.com'), client), 'forbidden', 'another rep');
  assert.equal(seoRecordAccess(rep('999', 'rep-a@example.com'), { ...client, ownerId: 'sales:rep-a@example.com' }), 'ok', 'owner by username');
  assert.equal(seoRecordAccess(rep('101'), { ...client, ownerId: '' }), 'forbidden', 'a client without an owner');
  assert.equal(seoRecordAccess(rep('101'), client, { work: true }), 'forbidden', 'sales never change keywords');
  assert.equal(seoRecordAccess(dev('201'), client), 'ok');
  assert.equal(seoRecordAccess(dev('201'), client, { work: true }), 'ok');
  assert.equal(seoRecordAccess(dev('202'), client), 'not-found', 'an unassigned developer');
  const handoff = { ...client, developerOwnerId: 'developer:202', developerHandoff: { status: 'waiting-upload', fromOwnerId: 'developer:201', toOwnerId: 'developer:202' } };
  assert.equal(seoRecordAccess(dev('201'), handoff), 'ok', 'the developer handing off still sees the client');
  assert.equal(seoRecordAccess(dev('201'), handoff, { work: true }), 'forbidden');
  assert.equal(seoRecordAccess(dev('202'), handoff, { work: true }), 'forbidden', 'nobody works on it until the handoff is accepted');
  assert.equal(seoRecordAccess(admin, handoff, { work: true }), 'ok');
  assert.equal(seoRecordAccess(admin, null), 'not-found');
  assert.equal(seoRecordAccess({}, client), 'forbidden');
});

test('each seo switch takes paused (null or {reason}), and a paused switch is off', async () => {
  const settings = await import('../data/automation-settings.js');
  const { seoRecordPullEnabled } = await import('../lib/routes/seo-record-routes.js');
  const { dfsLedgerEnabled } = await import('../lib/seo-ops/dfs-ledger.js');
  const { seoJobGatingMode } = await import('../lib/seo-ops/job-gating.js');
  assert.deepEqual(settings.defaultAutomationSettings().seo, {
    jobGating: { enabled: false, mode: 'shadow', paused: null },
    dfsLedger: { enabled: false, paused: null },
    recordPull: { enabled: false, paused: null },
  });
  const on = settings.validateAutomationSettings({ seo: { jobGating: { enabled: true, mode: 'auto' }, dfsLedger: { enabled: true }, recordPull: { enabled: true } } }, { by: 'test' });
  assert.equal(on.ok, true, JSON.stringify(on.errors));
  assert.deepEqual([seoJobGatingMode({ settings: on.value }), dfsLedgerEnabled({ settings: on.value }), seoRecordPullEnabled(on.value)], ['auto', true, true]);
  const reason = { reason: 'checking the gating diff' };
  const paused = settings.validateAutomationSettings({ seo: { jobGating: { paused: reason }, dfsLedger: { paused: reason }, recordPull: { paused: reason } } }, { current: on.value, by: 'test' });
  assert.equal(paused.ok, true, JSON.stringify(paused.errors));
  assert.equal(paused.value.seo.jobGating.paused.reason, 'checking the gating diff');
  assert.equal(paused.value.seo.jobGating.paused.by, 'test');
  assert.deepEqual([seoJobGatingMode({ settings: paused.value }), dfsLedgerEnabled({ settings: paused.value }), seoRecordPullEnabled(paused.value)], ['off', false, false]);
  const resumed = settings.validateAutomationSettings({ seo: { jobGating: { paused: null } } }, { current: paused.value, by: 'test' });
  assert.equal(seoJobGatingMode({ settings: resumed.value }), 'auto');
  const bad = settings.validateAutomationSettings({ seo: { recordPull: { paused: 'yes' } } }, { by: 'test' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((error) => error.path), ['seo.recordPull.paused']);
});

test('a push answers busy within seconds while another writer holds the client file', async () => {
  const id = 'sc-record-2';
  const lockPath = join(dataDir, 'seo-ops', 'clients', `${id}.json.lock`);
  const before = readFileSync(join(dataDir, 'seo-ops', 'clients', `${id}.json`), 'utf8');
  // A fresh lock of another process (an admin change in progress, or one that stopped a moment ago).
  writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'elsewhere', at: new Date().toISOString(), nonce: 'held-by-test' }));
  try {
    const started = Date.now();
    const pushed = await record.recordPlanSummaryFromPush(id, summary({ builtAt: '2026-11-02T08:00:00.000Z' }));
    const tookMs = Date.now() - started;
    assert.deepEqual(pushed, { seoRecorded: false, seoReason: 'busy' });
    assert.ok(tookMs >= record.PUSH_LOCK_TIMEOUT_MS - 50 && tookMs < record.PUSH_LOCK_TIMEOUT_MS + 2500, `answered in ${tookMs} ms`);
    assert.ok(record.PUSH_LOCK_TIMEOUT_MS <= 3000, 'well inside the 12 s the Maker waits for a push');
    assert.equal(readFileSync(join(dataDir, 'seo-ops', 'clients', `${id}.json`), 'utf8'), before, 'nothing written');
  } finally {
    rmSync(lockPath, { force: true });
  }
  assert.deepEqual(await record.recordPlanSummaryFromPush(id, summary({ builtAt: '2026-11-02T08:00:00.000Z' })), { seoRecorded: true });
  assert.equal(record.readSeoRecord(id).planSummary.builtAt, '2026-11-02T08:00:00.000Z');
});
