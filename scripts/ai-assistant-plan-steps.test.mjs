// Plan steps on the client assistant: shop, search phrases and booking, only when the switch is on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-plan-steps-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
const root = fileURLToPath(new URL('..', import.meta.url));

const fetched = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  throw new Error('no network in tests');
};
test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const {
  PLAN_STEPS,
  parseAreaAnswer,
  parseBookingAnswer,
  parseKeywordAnswer,
  parseShopAnswer,
  planMissingParts,
  shopPartNamed,
  planStepsFor,
  planSubStep,
  websiteHost,
} = await import('../lib/ai-assistant/intake.js');
const { normalizeShopSetup } = await import('../data/client-portal.js');
const portal = await import('../data/client-portal.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const { servicesForTier } = await import('../packages/suite/core/delivery/vocab.js');
const { handleAssistantChat, getAssistantState, planIntakeContext } = await import('../lib/ai-assistant/service.js');
const { evaluateDeliveryGate } = await import('../lib/delivery-gate.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');
const { readSeoRecord } = await import('../lib/seo-ops/record.js');

const PILOTS = ['shop-pilot', 'shop-open', 'tier1', 'book-1', 'seo-1', 'seo-known', 'kw-known', 'ship-known', 'prefill', 'skip-shop', 'q-pickup', 'q-ret', 'q-vat', 'q-side', 'q-dunno', 'q-nomore', 'q-revisit', 'q-exit', 'kw-again', 'o-1', 'q-stale', 'q-book', 'q-kwend', 'd-shop', 'd-book', 'd-kw', 'd-area', 'd-rv-shop', 'd-rv-kw'];
const BASE_INTAKE_KEYS = ['products', 'media', 'logo', 'staff', 'hours', 'affiliations', 'focus'];
const BANK_KEYS = [
  'businessCard', 'generalInfo', 'brandIdentity', 'openingHours', 'assistantIntake',
  'affiliations', 'staff', 'domainSetup', 'productCatalogs', 'products', 'media',
  'websiteCreatorQuestions', 'seo', 'makerLink',
];

function writeSettings({ enabled = true, mode = 'auto', paused = null, pilots = PILOTS } = {}) {
  writeFileSync(join(DATA_DIR, 'automation-settings.json'), JSON.stringify({
    version: settingsStore.AUTOMATION_SETTINGS_VERSION,
    pilotClientIds: pilots,
    intake: { tierSteps: { enabled, mode, paused } },
  }));
  settingsStore.invalidateAutomationSettingsCache();
}

function resetPortal() {
  for (const name of ['client-portal-profiles.json', 'client-portal-state.json', 'client-businesses.json']) {
    rmSync(join(DATA_DIR, name), { force: true });
  }
}

function freezeTime(iso) {
  const fixed = new Date(iso).getTime();
  const RealDate = globalThis.Date;
  class Frozen extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }

    static now() {
      return fixed;
    }
  }
  globalThis.Date = Frozen;
  return () => {
    globalThis.Date = RealDate;
  };
}

function planBody(tierId) {
  return {
    status: 'active',
    tierId,
    services: servicesForTier(tierId),
    languages: ['nb'],
    billing: 'month',
    source: 'test',
  };
}

function openClient({ id, userId = id, tierId, extra = {}, materials = null, bank = null }) {
  sales.createSalesClient({
    id,
    businessName: 'Eksempel Sykkel AS',
    contactEmail: `${id}@example.com`,
    portalUserId: userId,
    product: 'asoldi',
    ...extra,
  });
  sales.setSalesSitePlan(id, planBody(tierId), { by: 'test' });
  if (materials) sales.setSalesMakerRunOwned(id, { materials });
  portal.upsertClientProfile(userId, {
    businessName: 'Eksempel Sykkel AS',
    email: `${userId}@example.com`,
    businessId: userId,
    ownerUserId: userId,
  }, { businessId: userId, ownerUserId: userId });
  if (bank) portal.setClientDataBank(userId, bank, { businessId: userId });
  return { id, userId };
}

async function skipBase(userId) {
  const replies = [];
  for (const text of ['nei', 'nei', 'nei', 'nei', 'ikke relevant', 'nei']) {
    replies.push(await handleAssistantChat(userId, { text }));
  }
  return replies;
}

function lineStatus(gate, id) {
  return gate.lines.find((row) => row.id === id)?.status;
}

function intakeAudit(clientId) {
  return readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'intake-steps' && row.clientId === clientId);
}

test('parsers, plan steps and shop setup', () => {
  assert.deepEqual(PLAN_STEPS, ['shop', 'keywords', 'booking']);
  assert.deepEqual(planStepsFor({ services: ['ecom', 'seo', 'booking'] }), ['shop', 'keywords', 'booking']);
  assert.deepEqual(planStepsFor({ services: ['site'], pageKinds: ['booking'] }), ['booking']);
  assert.deepEqual(planStepsFor({ services: ['booking'], pageKinds: ['booking'] }), ['booking']);
  assert.deepEqual(planStepsFor({ services: ['site', 'blog'] }), []);

  const shipping = parseShopAnswer('Posten, 99 kr', 'shipping');
  assert.equal(shipping.action, 'save');
  assert.equal(shipping.value, 'Posten, 99 kr');
  assert.equal(parseShopAnswer('ok', 'shipping').action, 'unclear');
  assert.equal(parseShopAnswer('hopp over', 'returns').action, 'skip');
  assert.equal(parseShopAnswer('Ingen frakt, kun henting i butikken', 'shipping').action, 'save');
  assert.equal(parseShopAnswer('Ingen retur på matvarer, ellers 14 dagers angrerett', 'returns').value, 'Ingen retur på matvarer, ellers 14 dagers angrerett');
  assert.equal(parseShopAnswer('vet ikke', 'shipping').action, 'unclear');
  assert.equal(parseShopAnswer('usikker', 'returns').action, 'unclear');
  assert.equal(parseShopAnswer('det er alt', 'shipping').action, 'unclear');
  const notRegistered = parseShopAnswer('Nei, ikke mva-registrert. Eksempel Sykkel AS 123456780', 'seller');
  assert.equal(notRegistered.action, 'save');
  assert.equal(notRegistered.value.vatRegistered, false);
  assert.equal(notRegistered.value.orgNumber, '123456780');
  assert.equal(notRegistered.value.legalName, 'Eksempel Sykkel AS');
  const seller = parseShopAnswer('Eksempel Sykkel AS, 123 456 780, MVA-registrert', 'seller');
  assert.equal(seller.action, 'save');
  assert.deepEqual(seller.value, { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS', vatRegistered: true });
  const notVat = parseShopAnswer('Testvik Te ENK, ikke mva-registrert', 'seller');
  assert.equal(notVat.value.vatRegistered, false);
  assert.equal(notVat.value.legalName, 'Testvik Te ENK');
  assert.equal(parseShopAnswer('ja', 'seller').action, 'unclear');

  const words = parseKeywordAnswer('sykkelservice, reparasjon av elsykkel, melatonin');
  assert.equal(words.action, 'save');
  assert.deepEqual(words.phrases, ['sykkelservice', 'reparasjon av elsykkel']);
  assert.deepEqual(words.dropped, ['melatonin']);
  assert.deepEqual(parseKeywordAnswer('hus og hage, rør og bad').phrases, ['hus og hage', 'rør og bad']);
  assert.equal(parseKeywordAnswer('nei').action, 'skip');
  assert.equal(parseKeywordAnswer('melatonin').action, 'unclear');
  assert.equal(parseAreaAnswer('Eksempelby').action, 'save');
  assert.equal(parseAreaAnswer('Eksempelby').value, 'Eksempelby');
  assert.equal(parseAreaAnswer('nei').action, 'skip');

  const booked = parseBookingAnswer('Herreklipp, 30 min, 450 kr\nFarge, 90 min, 1200 kr');
  assert.equal(booked.action, 'save');
  assert.deepEqual(booked.services, [
    { name: 'Herreklipp', duration: '30 min', price: '450 kr' },
    { name: 'Farge', duration: '90 min', price: '1200 kr' },
  ]);
  assert.equal(parseBookingAnswer('nei').action, 'skip');
  assert.equal(websiteHost('https://butikk.example.com/varer'), 'butikk.example.com');

  const partial = { shopSetup: { shipping: 'Hentes i butikken, 0 kr' } };
  assert.equal(planSubStep('shop', partial, { seller: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } }), 'returns');
  assert.deepEqual(planMissingParts('keywords', { websiteCreatorQuestions: { importantKeywords: ['sykkelservice'] } }, { needsArea: true }), ['area']);
  assert.equal(planSubStep('keywords', { websiteCreatorQuestions: { importantKeywords: ['sykkelservice'], town: 'Testvik' } }, { needsArea: true }), '');
  assert.equal(planSubStep('booking', {}), 'services');

  assert.equal(normalizeShopSetup({}, {}), null);
  assert.equal(normalizeShopSetup({ shopSetup: { sellerVat: { vatRegistered: true } } }, {}), null);
  const shop = normalizeShopSetup({
    shopSetup: {
      shipping: 'x'.repeat(1200),
      returns: '14 dager',
      sellerVat: { legalName: 'Eksempel Sykkel AS', orgNumber: '123 456 780', vatRegistered: false },
      bookingServices: [{ name: '', duration: '10 min' }, { name: 'Herreklipp', duration: '30 min', price: '450 kr' }],
    },
  }, {});
  assert.equal(shop.shipping.length, 1000);
  assert.equal(shop.sellerVat.orgNumber, '123456780');
  assert.equal(shop.sellerVat.vatRegistered, false);
  assert.deepEqual(shop.bookingServices, [{ name: 'Herreklipp', duration: '30 min', price: '450 kr' }]);
  assert.deepEqual(Object.keys(shop), ['shipping', 'returns', 'sellerVat', 'bookingServices']);
  const kept = normalizeShopSetup({ businessCard: { companyName: 'Eksempel Sykkel AS' } }, { shopSetup: shop });
  assert.equal(kept.returns, '14 dager');
});

test('a bank without shop data keeps today\'s keys, and a later save keeps shopSetup', () => {
  const userId = 'plain-bank';
  portal.upsertClientProfile(userId, { businessName: 'Testvik Te', email: 'plain@example.com', businessId: userId }, { businessId: userId });
  const plain = portal.getClientProfileByUserId(userId).clientDataBank;
  assert.deepEqual(Object.keys(plain), BANK_KEYS);
  assert.equal(plain.shopSetup, undefined);
  assert.deepEqual(Object.keys(plain.assistantIntake), BASE_INTAKE_KEYS);

  portal.setClientDataBank(userId, {
    shopSetup: { shipping: 'Posten, 79 kr', returns: 'Standard 14 dagers angrerett' },
    assistantIntake: { shop: 'done', keywords: 'nope', focus: 'shop' },
  }, { businessId: userId });
  const stored = portal.getClientProfileByUserId(userId).clientDataBank;
  assert.deepEqual(Object.keys(stored), [...BANK_KEYS, 'shopSetup']);
  assert.deepEqual(Object.keys(stored.assistantIntake), [...BASE_INTAKE_KEYS.slice(0, 6), 'shop', 'focus']);
  assert.equal(stored.assistantIntake.focus, 'shop');
  assert.equal(stored.assistantIntake.keywords, undefined);

  portal.setClientDataBank(userId, { businessCard: { companyName: 'Testvik Te' } }, { businessId: userId });
  const again = portal.getClientProfileByUserId(userId).clientDataBank;
  assert.equal(again.shopSetup.shipping, 'Posten, 79 kr');
  assert.equal(again.shopSetup.returns, 'Standard 14 dagers angrerett');
  assert.equal(again.businessCard.companyName, 'Testvik Te');
});

test('tier 3 asks for the shop after the six steps, and known seller details are not asked again', async () => {
  writeSettings();
  openClient({
    id: 'shop-pilot',
    tierId: 'tier-3-ecommerce',
    extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' },
  });
  const walked = await skipBase('shop-pilot');
  assert.equal(walked.at(-1).currentStep, 'shop');
  assert.ok(walked.at(-1).intakeSteps.includes('shop'));
  assert.match(walked.at(-1).assistantMessage, /frakt|sender/i);
  assert.doesNotMatch(walked.at(-1).assistantMessage, /juridisk navn|organisasjonsnummer|MVA-registrert/i);

  const shipping = await handleAssistantChat('shop-pilot', { text: 'Posten, 99 kr' });
  assert.equal(shipping.currentStep, 'shop');
  assert.match(shipping.assistantMessage, /retur|angrerett/i);

  const returns = await handleAssistantChat('shop-pilot', { text: 'Standard 14 dagers angrerett' });
  assert.equal(returns.currentStep, 'keywords');
  assert.match(returns.assistantMessage, /søkeord/i);
  assert.doesNotMatch(returns.assistantMessage, /juridisk navn|organisasjonsnummer|MVA-registrert/i);

  const bank = portal.getClientProfileByUserId('shop-pilot').clientDataBank;
  assert.equal(bank.shopSetup.shipping, 'Posten, 99 kr');
  assert.equal(bank.shopSetup.returns, 'Standard 14 dagers angrerett');
  const client = sales.getSalesClientById('shop-pilot');
  const gate = evaluateDeliveryGate(client, { bank, plan: client.sitePlan });
  assert.equal(lineStatus(gate, 'shipping'), 'have');
  assert.equal(lineStatus(gate, 'returns'), 'have');
  assert.equal(lineStatus(gate, 'seller'), 'have');

  openClient({ id: 'shop-open', tierId: 'tier-3-ecommerce' });
  const openWalk = await skipBase('shop-open');
  assert.match(openWalk.at(-1).assistantMessage, /frakt|sender/i);
  await handleAssistantChat('shop-open', { text: 'Hentes i butikken, 0 kr' });
  const askSeller = await handleAssistantChat('shop-open', { text: 'Standard 14 dagers angrerett' });
  assert.equal(askSeller.currentStep, 'shop');
  assert.match(askSeller.assistantMessage, /juridisk navn|organisasjonsnummer|MVA-registrert/i);
  const saved = await handleAssistantChat('shop-open', { text: 'Eksempel Sykkel AS, 123456780, ikke mva' });
  assert.equal(saved.currentStep, 'keywords');
  const openBank = portal.getClientProfileByUserId('shop-open').clientDataBank;
  assert.equal(openBank.shopSetup.sellerVat.legalName, 'Eksempel Sykkel AS');
  assert.equal(openBank.shopSetup.sellerVat.orgNumber, '123456780');
  assert.equal(openBank.shopSetup.sellerVat.vatRegistered, false);
  assert.equal(openBank.brandIdentity.orgNumber, '123456780');
});

test('tier 1 ends after the six steps, and a booking page asks for services', async () => {
  writeSettings();
  openClient({ id: 'tier1', tierId: 'tier-1-standard' });
  const plain = await skipBase('tier1');
  assert.equal(plain.at(-1).currentStep, 'done');
  assert.equal(plain.at(-1).intakeSteps, undefined);
  assert.equal(portal.getClientProfileByUserId('tier1').clientDataBank.shopSetup, undefined);

  openClient({
    id: 'book-1',
    tierId: 'tier-1-standard',
    materials: { pageKinds: [{ route: '/bestill', kind: 'booking' }] },
  });
  const booked = await skipBase('book-1');
  assert.equal(booked.at(-1).currentStep, 'booking');
  assert.match(booked.at(-1).assistantMessage, /bestille|booke|tjeneste/i);
  const saved = await handleAssistantChat('book-1', { text: 'Herreklipp, 30 min, 450 kr\nFarge, 90 min, 1200 kr' });
  assert.equal(saved.currentStep, 'done');
  assert.deepEqual(portal.getClientProfileByUserId('book-1').clientDataBank.shopSetup.bookingServices, [
    { name: 'Herreklipp', duration: '30 min', price: '450 kr' },
    { name: 'Farge', duration: '90 min', price: '1200 kr' },
  ]);
});

test('seo phrases are proposed and not approved, a regulated phrase is refused, and a known town is not asked', async () => {
  writeSettings();
  openClient({ id: 'seo-1', tierId: 'tier-2-seo', extra: { seo: { scope: 'local' } } });
  const walked = await skipBase('seo-1');
  assert.equal(walked.at(-1).currentStep, 'keywords');
  const answer = await handleAssistantChat('seo-1', { text: 'sykkelservice, reparasjon av elsykkel, melatonin' });
  assert.match(answer.assistantMessage, /melatonin kan ikke brukes som søkeord/i);
  assert.match(answer.assistantMessage, /by|område/i);
  assert.equal(answer.currentStep, 'keywords');
  const bank = portal.getClientProfileByUserId('seo-1').clientDataBank;
  assert.deepEqual(bank.websiteCreatorQuestions.importantKeywords, ['sykkelservice', 'reparasjon av elsykkel']);
  assert.equal(JSON.stringify(bank).includes('melatonin'), false);
  const record = readSeoRecord('seo-1');
  const proposed = (record?.agreedKeywords || []).filter((row) => row.status === 'proposed' && row.source === 'client');
  assert.deepEqual(proposed.map((row) => row.phrase), ['sykkelservice', 'reparasjon av elsykkel']);
  assert.equal((record?.agreedKeywords || []).some((row) => row.status === 'approved'), false);
  assert.equal(JSON.stringify(record).toLowerCase().includes('melatonin'), false);
  const area = await handleAssistantChat('seo-1', { text: 'Eksempelby' });
  assert.equal(area.currentStep, 'done');
  assert.equal(portal.getClientProfileByUserId('seo-1').clientDataBank.websiteCreatorQuestions.town, 'Eksempelby');

  openClient({
    id: 'seo-known',
    tierId: 'tier-2-seo',
    extra: { seo: { scope: 'local' } },
    bank: { websiteCreatorQuestions: { town: 'Testvik' } },
  });
  await skipBase('seo-known');
  const known = await handleAssistantChat('seo-known', { text: 'sykkelservice' });
  assert.equal(known.currentStep, 'done');
  assert.doesNotMatch(known.assistantMessage, /hvilken by|hvilket område|bli funnet/i);
});

test('answers already on file are not asked again', async () => {
  writeSettings();
  openClient({
    id: 'kw-known',
    tierId: 'tier-2-seo',
    extra: { seo: { scope: 'local' } },
    bank: { websiteCreatorQuestions: { importantKeywords: ['sykkelservice'], town: 'Eksempelby' } },
  });
  const walked = await skipBase('kw-known');
  assert.equal(walked.at(-1).currentStep, 'done');
  assert.doesNotMatch(walked.at(-1).assistantMessage, /søkeord/i);

  openClient({
    id: 'ship-known',
    tierId: 'tier-3-ecommerce',
    extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' },
    bank: { shopSetup: { shipping: 'Hentes i butikken, 0 kr' } },
  });
  const shop = await skipBase('ship-known');
  assert.equal(shop.at(-1).currentStep, 'shop');
  assert.match(shop.at(-1).assistantMessage, /retur|angrerett/i);
  assert.doesNotMatch(shop.at(-1).assistantMessage, /hvordan sender/i);
});

test('shadow and a non-pilot auto client match the switch off, with one audit row', async () => {
  const thaw = freezeTime('2026-11-08T12:00:00.000Z');
  try {
    sales.createSalesClient({
      id: 'shade-1',
      businessName: 'Eksempel Sykkel AS',
      contactEmail: 'shade-1@example.com',
      portalUserId: 'shade-user',
      product: 'asoldi',
    });
    sales.setSalesSitePlan('shade-1', planBody('tier-3-ecommerce'), { by: 'test' });

    writeSettings({ enabled: false });
    resetPortal();
    portal.upsertClientProfile('shade-user', {
      businessName: 'Eksempel Sykkel AS',
      email: 'shade-user@example.com',
      businessId: 'shade-user',
    }, { businessId: 'shade-user' });
    const offState = await getAssistantState('shade-user');
    const offReplies = [offState, ...await skipBase('shade-user')];

    writeSettings({ enabled: true, mode: 'shadow', pilots: ['shade-1'] });
    resetPortal();
    portal.upsertClientProfile('shade-user', {
      businessName: 'Eksempel Sykkel AS',
      email: 'shade-user@example.com',
      businessId: 'shade-user',
    }, { businessId: 'shade-user' });
    const shadowState = await getAssistantState('shade-user');
    const shadowReplies = [shadowState, ...await skipBase('shade-user')];
    assert.deepEqual(shadowReplies, offReplies);
    assert.equal(intakeAudit('shade-1').length, 1);
    await getAssistantState('shade-user');
    await handleAssistantChat('shade-user', { text: 'hei' });
    assert.equal(intakeAudit('shade-1').length, 1);

    sales.createSalesClient({
      id: 'outsider',
      businessName: 'Eksempel Sykkel AS',
      contactEmail: 'outsider@example.com',
      portalUserId: 'out-user',
      product: 'asoldi',
    });
    sales.setSalesSitePlan('outsider', planBody('tier-3-ecommerce'), { by: 'test' });
    writeSettings({ enabled: false, pilots: ['shade-1'] });
    resetPortal();
    portal.upsertClientProfile('out-user', {
      businessName: 'Eksempel Sykkel AS',
      email: 'out-user@example.com',
      businessId: 'out-user',
    }, { businessId: 'out-user' });
    const offOut = [await getAssistantState('out-user'), ...await skipBase('out-user')];
    const stored = portal.getClientProfileByUserId('out-user').clientDataBank;
    assert.equal(Object.hasOwn(offOut[1], 'intakeSteps'), false);
    assert.equal(stored.shopSetup, undefined);
    assert.deepEqual(Object.keys(stored.assistantIntake), BASE_INTAKE_KEYS);

    writeSettings({ enabled: true, mode: 'auto', pilots: ['shade-1'] });
    resetPortal();
    portal.upsertClientProfile('out-user', {
      businessName: 'Eksempel Sykkel AS',
      email: 'out-user@example.com',
      businessId: 'out-user',
    }, { businessId: 'out-user' });
    const autoOut = [await getAssistantState('out-user'), ...await skipBase('out-user')];
    assert.deepEqual(autoOut, offOut);
    assert.equal(intakeAudit('outsider').length, 1);
    await handleAssistantChat('out-user', { text: 'hei' });
    assert.equal(intakeAudit('outsider').length, 1);
  } finally {
    thaw();
  }
});

test('with the switch off the context is null and no audit directory is created for that call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asoldi-plan-steps-null-'));
  const script = `
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    process.env.APP_DATA_DIR = ${JSON.stringify(dir)};
    delete process.env.DATA_DIR;
    const service = await import(${JSON.stringify(pathToFileURL(join(root, 'lib/ai-assistant/service.js')).href)});
    const disabled = { intake: { tierSteps: { enabled: false, mode: 'auto', paused: null } } };
    const enabled = { pilotClientIds: ['pilot-1'], intake: { tierSteps: { enabled: true, mode: 'auto', paused: null } } };
    const off = await service.planIntakeContext('user-1', { settings: disabled });
    const missing = await service.planIntakeContext('user-1', { settings: enabled });
    console.log(JSON.stringify({ off, missing, audit: existsSync(join(${JSON.stringify(dir)}, 'delivery-audit')) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(payload.off, null);
  assert.equal(payload.missing, null);
  assert.equal(payload.audit, false);
  rmSync(dir, { recursive: true, force: true });
});

test('a yes on an empty shop catalogue names the site host and does not fetch it', async () => {
  writeSettings();
  openClient({
    id: 'prefill',
    tierId: 'tier-3-ecommerce',
    bank: { generalInfo: { websiteUrl: 'https://butikk.example.com/varer' } },
  });
  const before = fetched.length;
  const yes = await handleAssistantChat('prefill', { text: 'ja' });
  assert.equal(yes.currentStep, 'media');
  assert.match(yes.assistantMessage, /butikk\.example\.com/);
  assert.match(yes.assistantMessage, /nettsiden bygges/);
  assert.equal(yes.jobId || '', '');
  assert.equal(fetched.slice(before).some((url) => url.includes('butikk.example.com')), false);
  const pastedBefore = fetched.length;
  const pasted = await handleAssistantChat('prefill-url', { text: 'sjekk https://butikk.example.com/varer' });
  assert.equal(pasted.jobId || '', '');
  assert.match(pasted.assistantMessage, /dokument|fil|PDF|Excel|nettsider/i);
  assert.equal(fetched.slice(pastedBefore).some((url) => url.includes('butikk.example.com')), false);
});

test('skipping the shop step does not decline the gate lines', async () => {
  writeSettings();
  openClient({ id: 'skip-shop', tierId: 'tier-3-ecommerce' });
  await skipBase('skip-shop');
  const skipped = await handleAssistantChat('skip-shop', { text: 'nei' });
  assert.notEqual(skipped.currentStep, 'shop');
  const bank = portal.getClientProfileByUserId('skip-shop').clientDataBank;
  assert.equal(bank.assistantIntake.shop, 'skipped');
  const client = sales.getSalesClientById('skip-shop');
  const gate = evaluateDeliveryGate(client, { bank, plan: client.sitePlan });
  assert.equal(lineStatus(gate, 'shipping'), 'missing');
  assert.notEqual(lineStatus(gate, 'shipping'), 'declined');
  assert.equal(lineStatus(gate, 'returns'), 'missing');
});

test('the panel markup without plan steps matches the previous panel', async () => {
  const esbuild = await import('esbuild');
  const dir = join(root, 'app', 'pages', 'client');
  const props = JSON.stringify({
    bank: {
      productCatalogs: [],
      media: {},
      staff: [],
      affiliations: [],
      openingHours: { status: '', days: [] },
      assistantIntake: {},
      brandIdentity: { logos: { normal: '' } },
    },
    token: 'client-token',
    currentStep: 'products',
    productRows: [],
    layoutText: '',
    removingProducts: false,
    busy: false,
    viewStep: 'products',
    onSelectStep: () => {},
    onRemoveProduct: () => {},
    onClearProducts: () => {},
  }).replace(/"\(\)=>\{\}"/g, '() => {}');
  async function markup(contents, extra = '') {
    const built = await esbuild.build({
      stdin: { contents, resolveDir: dir, loader: 'tsx', sourcefile: 'render-entry.tsx' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      packages: 'external',
      logLevel: 'silent',
    });
    mkdirSync(join(root, 'build'), { recursive: true });
    const outDir = mkdtempSync(join(root, 'build', 'intake-render-'));
    const file = join(outDir, 'render.mjs');
    writeFileSync(file, built.outputFiles[0].text);
    try {
      const mod = await import(`${new URL(`file://${file}`).href}?t=${Date.now()}`);
      return extra ? mod : mod.html;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  const body = [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    "import { AssistantIntakePanel } from './AssistantIntakePanel';",
    `const props = ${props};`,
    'export const html = renderToStaticMarkup(React.createElement(AssistantIntakePanel, props));',
    'const plannedProps = { ...props, steps: ["products", "media", "logo", "staff", "hours", "affiliations", "shop"], viewStep: "shop", currentStep: "shop", bank: { ...props.bank, assistantIntake: { products: "skipped", media: "skipped", logo: "skipped", staff: "skipped", hours: "skipped", affiliations: "skipped" } } };',
    'export const planned = renderToStaticMarkup(React.createElement(AssistantIntakePanel, plannedProps));',
  ].join('\n');
  const current = await markup(body, 'both');
  const stored = readFileSync(join(root, 'scripts/fixtures/assistant-intake-panel-off.html'), 'utf8');
  assert.equal(current.html, stored);
  assert.equal(current.html.includes('Butikk'), false);
  assert.match(current.planned, /Butikk/);
  assert.match(current.planned, /Frakt/);
});

function gatePair(id) {
  const client = sales.getSalesClientById(id);
  const bank = portal.getClientProfileByUserId(id).clientDataBank;
  const gate = evaluateDeliveryGate(client, { bank, plan: client.sitePlan });
  const status = (lineId) => gate.lines.find((row) => row.id === lineId)?.status;
  return { bank, shipping: status('shipping'), returns: status('returns') };
}

test('shop answers that start with ingen or nei are stored, and a non-answer is not', async () => {
  writeSettings();
  openClient({ id: 'q-pickup', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-pickup');
  const pickupHours = portal.getClientProfileByUserId('q-pickup').clientDataBank.openingHours;
  await handleAssistantChat('q-pickup', { text: 'Ingen frakt, kun henting i butikken' });
  const pickup = gatePair('q-pickup');
  assert.equal(pickup.bank.shopSetup.shipping, 'Ingen frakt, kun henting i butikken');
  assert.equal(pickup.shipping, 'have');
  assert.equal(pickup.returns, 'missing');
  assert.deepEqual(pickup.bank.openingHours, pickupHours);

  openClient({ id: 'q-ret', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-ret');
  const returnHours = portal.getClientProfileByUserId('q-ret').clientDataBank.openingHours;
  await handleAssistantChat('q-ret', { text: 'Posten, 99 kr' });
  await handleAssistantChat('q-ret', { text: 'Ingen retur på matvarer, ellers 14 dagers angrerett' });
  const returned = gatePair('q-ret');
  assert.equal(returned.bank.shopSetup.shipping, 'Posten, 99 kr');
  assert.equal(returned.bank.shopSetup.returns, 'Ingen retur på matvarer, ellers 14 dagers angrerett');
  assert.equal(returned.shipping, 'have');
  assert.equal(returned.returns, 'have');
  assert.deepEqual(returned.bank.openingHours, returnHours);

  openClient({ id: 'q-vat', tierId: 'tier-3-ecommerce' });
  await skipBase('q-vat');
  await handleAssistantChat('q-vat', { text: 'Posten, 99 kr' });
  await handleAssistantChat('q-vat', { text: 'Standard 14 dagers angrerett' });
  await handleAssistantChat('q-vat', { text: 'Nei, ikke mva-registrert. Eksempel Sykkel AS 123456780' });
  const vat = portal.getClientProfileByUserId('q-vat').clientDataBank.shopSetup.sellerVat;
  assert.equal(vat.vatRegistered, false);
  assert.equal(vat.orgNumber, '123456780');
  assert.equal(vat.legalName, 'Eksempel Sykkel AS');
  assert.equal(portal.getClientProfileByUserId('q-vat').clientDataBank.assistantIntake.shop, 'done');

  openClient({ id: 'q-side', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-side');
  const sideHours = portal.getClientProfileByUserId('q-side').clientDataBank.openingHours;
  const sideText = 'Vi sender med Posten for 99 kr, eller du kan hente hos oss mandag til fredag 10-16';
  await handleAssistantChat('q-side', { text: sideText });
  const side = gatePair('q-side');
  assert.equal(side.bank.shopSetup.shipping, sideText);
  assert.equal(side.shipping, 'have');
  assert.deepEqual(side.bank.openingHours, sideHours);

  openClient({ id: 'q-dunno', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-dunno');
  await handleAssistantChat('q-dunno', { text: 'vet ikke' });
  await handleAssistantChat('q-dunno', { text: 'usikker' });
  const dunno = gatePair('q-dunno');
  assert.equal(dunno.bank.shopSetup, undefined);
  assert.equal(dunno.shipping, 'missing');
  assert.equal(dunno.returns, 'missing');

  openClient({ id: 'q-nomore', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-nomore');
  await handleAssistantChat('q-nomore', { text: 'det er alt' });
  const nomore = gatePair('q-nomore');
  assert.equal(nomore.bank.shopSetup, undefined);
  assert.equal(nomore.shipping, 'missing');
  assert.equal(nomore.bank.openingHours.status, 'not-relevant');
});

test('a finished shop step replaces the named part, and nei does not skip it', async () => {
  writeSettings();
  openClient({ id: 'q-revisit', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-revisit');
  await handleAssistantChat('q-revisit', { text: 'Posten, 99 kr' });
  await handleAssistantChat('q-revisit', { text: 'Standard 14 dagers angrerett' });
  const opened = await handleAssistantChat('q-revisit', { focusStep: 'shop' });
  assert.match(opened.assistantMessage, /butikken/i);
  const unnamed = await handleAssistantChat('q-revisit', { text: 'Bring, 129 kr' });
  assert.match(unnamed.assistantMessage, /frakt, retur eller selger/i);
  assert.equal(portal.getClientProfileByUserId('q-revisit').clientDataBank.shopSetup.shipping, 'Posten, 99 kr');
  await handleAssistantChat('q-revisit', { text: 'frakt' });
  await handleAssistantChat('q-revisit', { text: 'Bring, 129 kr' });
  assert.equal(portal.getClientProfileByUserId('q-revisit').clientDataBank.shopSetup.shipping, 'Bring, 129 kr');
  assert.equal(portal.getClientProfileByUserId('q-revisit').clientDataBank.shopSetup.returns, 'Standard 14 dagers angrerett');
  const closed = await handleAssistantChat('q-revisit', { text: 'det er alt' });
  const bank = portal.getClientProfileByUserId('q-revisit').clientDataBank;
  assert.equal(bank.assistantIntake.shop, 'done');
  assert.equal(bank.assistantIntake.focus, '');
  assert.equal(bank.assistantIntake.revisitPart, undefined);
  assert.equal(bank.shopSetup.shipping, 'Bring, 129 kr');
  assert.notEqual(closed.currentStep, 'shop');

  openClient({ id: 'q-exit', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('q-exit');
  await handleAssistantChat('q-exit', { text: 'Posten, 99 kr' });
  await handleAssistantChat('q-exit', { text: '14 dagers angrerett' });
  await handleAssistantChat('q-exit', { focusStep: 'shop' });
  await handleAssistantChat('q-exit', { text: 'nei' });
  const exitBank = portal.getClientProfileByUserId('q-exit').clientDataBank;
  assert.equal(exitBank.assistantIntake.shop, 'done');
  assert.equal(exitBank.assistantIntake.focus, '');
  assert.equal(exitBank.shopSetup.shipping, 'Posten, 99 kr');
});

test('a booking page on the offer is asked when there is no maker run', async () => {
  writeSettings();
  const offers = await import('../data/sales-offers.js');
  openClient({ id: 'o-1', tierId: 'tier-1-standard' });
  offers.createSalesOffer({ salesClientId: 'o-1', products: [{ id: 'p1', name: 'Nettside', priceExMva: 1000, includes: ['Forside', 'Timebestilling', 'Kontakt'] }] });
  const ctx = await planIntakeContext('o-1');
  assert.ok(ctx.steps.includes('booking'));
  const walked = await skipBase('o-1');
  assert.equal(walked.at(-1).currentStep, 'booking');
});

test('a finished keyword step keeps a phrase that contains og', async () => {
  writeSettings();
  openClient({ id: 'kw-again', tierId: 'tier-2-seo', extra: { seo: { scope: 'national' } } });
  await skipBase('kw-again');
  await handleAssistantChat('kw-again', { text: 'sykkelservice' });
  await handleAssistantChat('kw-again', { focusStep: 'keywords' });
  await handleAssistantChat('kw-again', { text: 'hus og hage' });
  const bank = portal.getClientProfileByUserId('kw-again').clientDataBank;
  assert.deepEqual(bank.websiteCreatorQuestions.importantKeywords, ['sykkelservice', 'hus og hage']);
  assert.equal(bank.assistantIntake.keywords, 'done');
});

test('declines and non-answers on the search word, area and booking questions are not saved', () => {
  for (const text of ['Nei, ingen søkeord', 'Har ikke tenkt på det', 'hopp over dette', 'Nei, vi har ingen spesielle', 'Ingen flere']) {
    assert.equal(parseKeywordAnswer(text).action, 'skip', text);
  }
  for (const text of ['vet ikke', 'usikker', 'aner ikke', 'det er alt']) {
    assert.equal(parseKeywordAnswer(text).action, 'unclear', text);
    assert.equal(parseAreaAnswer(text).action, 'unclear', text);
    assert.equal(parseBookingAnswer(text).action, 'unclear', text);
  }
  for (const text of ['Ingen timebestilling', 'Nei, vi har ingen tjenester som bookes', 'Har ikke det']) {
    assert.equal(parseBookingAnswer(text).action, 'skip', text);
  }
  assert.equal(parseAreaAnswer('hopp over dette').action, 'skip');
  assert.deepEqual(parseKeywordAnswer('Nei, kajakkutleie Eksempelby').phrases, ['kajakkutleie Eksempelby']);
  assert.equal(parseBookingAnswer('Klipp, 30 min, 500 kr').action, 'save');
  const seller = parseShopAnswer('Nei, vi er ikke mva-registrert', 'seller');
  assert.equal(seller.value.legalName, '');
  assert.equal(seller.value.vatRegistered, false);
  assert.equal(parseShopAnswer('Nei, ikke mva-registrert', 'seller').value.legalName, '');
  assert.equal(shopPartNamed('Jeg vil endre returvilkårene'), 'returns');
  assert.equal(shopPartNamed('endre returen'), 'returns');
  assert.equal(shopPartNamed('fraktprisen'), 'shipping');
});

test('a declined booking step is skipped, and a finished keyword step ends on ingen flere', async () => {
  writeSettings();
  openClient({ id: 'q-book', tierId: 'tier-1-standard', extra: {} });
  const offers = await import('../data/sales-offers.js');
  offers.createSalesOffer({ salesClientId: 'q-book', products: [{ id: 'p1', name: 'Nettside', priceExMva: 1000, includes: ['Forside', 'Timebestilling', 'Kontakt'] }] });
  await skipBase('q-book');
  await handleAssistantChat('q-book', { text: 'Ingen timebestilling' });
  const booked = portal.getClientProfileByUserId('q-book').clientDataBank;
  assert.deepEqual(booked.bookingServices || booked.shopSetup?.bookingServices || [], []);
  assert.equal(booked.assistantIntake.booking, 'skipped');

  openClient({ id: 'q-kwend', tierId: 'tier-2-seo', extra: { seo: { scope: 'national' } } });
  await skipBase('q-kwend');
  await handleAssistantChat('q-kwend', { text: 'sykkelservice' });
  await handleAssistantChat('q-kwend', { focusStep: 'keywords' });
  await handleAssistantChat('q-kwend', { text: 'Ingen flere' });
  const kw = portal.getClientProfileByUserId('q-kwend').clientDataBank;
  assert.deepEqual(kw.websiteCreatorQuestions.importantKeywords, ['sykkelservice']);
  assert.equal(kw.assistantIntake.focus, '');
});

test('a pending shop part is dropped when the client moves to another step', async () => {
  writeSettings();
  openClient({ id: 'q-stale', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS', seo: { scope: 'national' } } });
  await skipBase('q-stale');
  await handleAssistantChat('q-stale', { text: 'Posten, 99 kr' });
  await handleAssistantChat('q-stale', { text: 'Standard 14 dagers angrerett' });
  await handleAssistantChat('q-stale', { focusStep: 'shop' });
  await handleAssistantChat('q-stale', { text: 'frakt' });
  await handleAssistantChat('q-stale', { focusStep: 'keywords' });
  await handleAssistantChat('q-stale', { focusStep: 'shop' });
  const asked = await handleAssistantChat('q-stale', { text: 'retur' });
  assert.match(asked.assistantMessage, /retur/i);
  assert.equal(portal.getClientProfileByUserId('q-stale').clientDataBank.shopSetup.shipping, 'Posten, 99 kr');
});

test('a decline after nei or nei takk is not saved on any plan question, and shop content after ingen still is', () => {
  const keywordSkips = [
    'Nei takk, ikke nå', 'Nei, ikke ennå', 'Nei, ikke enda', 'Nei takk, det trenger vi ikke', 'Nei, det vet jeg ikke',
    'nei det er greit', 'Nei, vi stoler på dere', 'Nei, det har jeg ikke tenkt på', 'Dere kan bestemme', 'ikke viktig',
    'Vet ikke, dere kan velge',
  ];
  for (const text of keywordSkips) {
    const parsed = parseKeywordAnswer(text);
    assert.equal(parsed.action, 'skip', text);
    assert.deepEqual(parsed.phrases, [], text);
  }
  for (const text of ['Nei, vet ikke', 'Ingen anelse', 'Ingen idé', 'vet ikke helt']) {
    assert.equal(parseKeywordAnswer(text).action, 'unclear', text);
    assert.equal(parseAreaAnswer(text).action, 'unclear', text);
    assert.equal(parseBookingAnswer(text).action, 'unclear', text);
  }
  assert.deepEqual(parseKeywordAnswer('Nei takk, kajakkutleie, ikke padling').phrases, ['kajakkutleie']);
  assert.deepEqual(parseKeywordAnswer('Nei, kajakkutleie Eksempelby').phrases, ['kajakkutleie Eksempelby']);

  const bookingSkips = [
    'Nei, kundene ringer oss', 'Nei takk, kundene ringer oss', 'Nei, vi tar bare drop-in', 'Nei, ikke ennå',
    'Nei takk, ikke nå', 'Nei, det ordner vi selv', 'Vi tar ikke imot bestillinger på nett',
  ];
  for (const text of bookingSkips) {
    const parsed = parseBookingAnswer(text);
    assert.equal(parsed.action, 'skip', text);
    assert.deepEqual(parsed.services, [], text);
  }
  assert.deepEqual(parseBookingAnswer('Nei, Herreklipp, 30 min, 450 kr').services, [{ name: 'Herreklipp', duration: '30 min', price: '450 kr' }]);
  assert.deepEqual(parseBookingAnswer('Herreklipp\nFarge').services.map((row) => row.name), ['Herreklipp', 'Farge']);

  for (const text of ['Nei takk, ikke nå', 'Nei, ikke ennå']) assert.equal(parseAreaAnswer(text).action, 'skip', text);
  assert.deepEqual(parseAreaAnswer('Nei, hele landet'), { action: 'save', value: 'hele landet' });
  assert.deepEqual(parseAreaAnswer('Nei, bare Eksempelby'), { action: 'save', value: 'Eksempelby' });

  for (const sub of ['shipping', 'returns']) {
    for (const text of ['Nei takk, ikke nå', 'Ikke nå', 'Skip', 'hopp over dette']) {
      assert.equal(parseShopAnswer(text, sub).action, 'skip', `${sub}: ${text}`);
    }
    for (const text of ['Ingen anelse', 'vet ikke helt', 'Nei, vet ikke']) {
      assert.equal(parseShopAnswer(text, sub).action, 'unclear', `${sub}: ${text}`);
    }
  }
  assert.deepEqual(parseShopAnswer('Ingen frakt, kun henting', 'shipping'), { action: 'save', value: 'Ingen frakt, kun henting' });
  assert.deepEqual(parseShopAnswer('Ingen retur på matvarer', 'returns'), { action: 'save', value: 'Ingen retur på matvarer' });
  assert.deepEqual(parseShopAnswer('Nei, kun henting i butikken', 'shipping'), { action: 'save', value: 'kun henting i butikken' });
  assert.equal(parseShopAnswer('NOK 99 med Posten', 'shipping').action, 'save');
  assert.equal(parseShopAnswer('Nei takk, ikke nå', 'seller').action, 'skip');
  assert.equal(parseShopAnswer('Nei, ikke mva-registrert', 'seller').value.vatRegistered, false);
});

test('declines through the chat leave the gate lines missing and propose no search phrase', async () => {
  writeSettings();
  openClient({ id: 'd-shop', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS' } });
  await skipBase('d-shop');
  const shop = await handleAssistantChat('d-shop', { text: 'Nei takk, ikke nå' });
  assert.notEqual(shop.currentStep, 'shop');
  const shopBank = portal.getClientProfileByUserId('d-shop').clientDataBank;
  assert.equal(shopBank.assistantIntake.shop, 'skipped');
  assert.equal(shopBank.shopSetup?.shipping || '', '');
  const shopClient = sales.getSalesClientById('d-shop');
  const shopGate = evaluateDeliveryGate(shopClient, { bank: shopBank, plan: shopClient.sitePlan });
  assert.equal(lineStatus(shopGate, 'shipping'), 'missing');
  assert.equal(lineStatus(shopGate, 'returns'), 'missing');

  openClient({ id: 'd-book', tierId: 'tier-1-standard', materials: { pageKinds: [{ route: '/bestill', kind: 'booking' }] } });
  await skipBase('d-book');
  await handleAssistantChat('d-book', { text: 'Nei, kundene ringer oss' });
  const bookBank = portal.getClientProfileByUserId('d-book').clientDataBank;
  assert.equal(bookBank.assistantIntake.booking, 'skipped');
  assert.deepEqual(bookBank.shopSetup?.bookingServices || [], []);
  const bookClient = sales.getSalesClientById('d-book');
  const bookGate = evaluateDeliveryGate(bookClient, { bank: bookBank, plan: bookClient.sitePlan });
  assert.equal(lineStatus(bookGate, 'booking-services'), 'missing');

  openClient({ id: 'd-kw', tierId: 'tier-2-seo', extra: { seo: { scope: 'national' } } });
  await skipBase('d-kw');
  const unsure = await handleAssistantChat('d-kw', { text: 'Nei, vet ikke' });
  assert.equal(unsure.currentStep, 'keywords');
  assert.match(unsure.assistantMessage, /fikk ikke med meg/i);
  await handleAssistantChat('d-kw', { text: 'Nei, vi stoler på dere' });
  const kwBank = portal.getClientProfileByUserId('d-kw').clientDataBank;
  assert.equal(kwBank.assistantIntake.keywords, 'skipped');
  assert.deepEqual(kwBank.websiteCreatorQuestions?.importantKeywords || [], []);
  assert.deepEqual(readSeoRecord('d-kw')?.agreedKeywords || [], []);

  openClient({ id: 'd-area', tierId: 'tier-2-seo', extra: { seo: { scope: 'local' } } });
  await skipBase('d-area');
  await handleAssistantChat('d-area', { text: 'kajakkutleie' });
  await handleAssistantChat('d-area', { text: 'Nei, hele landet' });
  assert.equal(portal.getClientProfileByUserId('d-area').clientDataBank.websiteCreatorQuestions.town, 'hele landet');
});

test('a declined revisit of a finished step keeps the stored answer and the done flag', async () => {
  writeSettings();
  openClient({ id: 'd-rv-shop', tierId: 'tier-3-ecommerce', extra: { orgNumber: '123456780', legalName: 'Eksempel Sykkel AS', seo: { scope: 'national' } } });
  await skipBase('d-rv-shop');
  await handleAssistantChat('d-rv-shop', { text: 'Posten, 99 kr' });
  await handleAssistantChat('d-rv-shop', { text: 'Standard 14 dagers angrerett' });
  await handleAssistantChat('d-rv-shop', { focusStep: 'shop' });
  await handleAssistantChat('d-rv-shop', { text: 'frakt' });
  const ended = await handleAssistantChat('d-rv-shop', { text: 'Nei takk, ikke nå' });
  assert.doesNotMatch(ended.assistantMessage, /fikk ikke med meg/i);
  const shopBank = portal.getClientProfileByUserId('d-rv-shop').clientDataBank;
  assert.equal(shopBank.shopSetup.shipping, 'Posten, 99 kr');
  assert.equal(shopBank.assistantIntake.shop, 'done');
  assert.equal(shopBank.assistantIntake.revisitPart || '', '');
  assert.equal(shopBank.assistantIntake.focus, '');

  openClient({ id: 'd-rv-kw', tierId: 'tier-2-seo', extra: { seo: { scope: 'national' } } });
  await skipBase('d-rv-kw');
  await handleAssistantChat('d-rv-kw', { text: 'sykkelservice' });
  await handleAssistantChat('d-rv-kw', { focusStep: 'keywords' });
  await handleAssistantChat('d-rv-kw', { text: 'Dere kan bestemme' });
  const kwBank = portal.getClientProfileByUserId('d-rv-kw').clientDataBank;
  assert.deepEqual(kwBank.websiteCreatorQuestions.importantKeywords, ['sykkelservice']);
  assert.equal(kwBank.assistantIntake.keywords, 'done');
  assert.equal(kwBank.assistantIntake.focus, '');
});
