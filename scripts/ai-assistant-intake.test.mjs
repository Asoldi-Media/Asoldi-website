import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildOpeningState } from '../lib/ai-assistant/chat.js';
import {
  SETTINGS_PATH,
  alwaysOpenDays,
  businessLabel,
  personFirstName,
  hasListedTeam,
  hoursLookCustom,
  isDecline,
  isNoMore,
  intakeReview,
  nextIntakeStep,
  parseAffiliationsAnswer,
  parseOpeningHoursAnswer,
  parseStaffAnswer,
  promptFor,
  navigationTarget,
  questionFor,
  sideWrite,
} from '../lib/ai-assistant/intake.js';
import { publicJobView, updateAssistantJob, createAssistantJob } from '../lib/ai-assistant/jobs.js';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-assistant-intake-'));
process.env.APP_DATA_DIR = dataDir;
const portal = await import('../data/client-portal.js');
const { handleAssistantChat } = await import('../lib/ai-assistant/service.js');
const { formatWebsiteCorpus } = await import('../lib/ai-assistant/products-ingest.js');
const { reconcileDeterministicWithAi } = await import('../lib/ai-assistant/products-import-deterministic.js');
const { readablePageText, rankOfferingPages } = await import('../lib/ai-assistant/products-scrape.js');

function bank(patch = {}) {
  return {
    businessCard: { companyName: 'Nordlys' },
    productCatalogs: [],
    media: {},
    brandIdentity: { logos: { normal: '' } },
    staff: [],
    openingHours: {
      status: '',
      days: [
        { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
        { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
        { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
      ],
    },
    affiliations: [],
    assistantIntake: {},
    ...patch,
  };
}

function withProducts(extra = {}) {
  return bank({
    productCatalogs: [{ categories: [{ name: 'Varer', products: [{ title: 'Lampe' }] }] }],
    ...extra,
  });
}

test('intake asks products first and skips buckets that are already filled', () => {
  assert.equal(nextIntakeStep(bank()), 'products');
  assert.equal(nextIntakeStep(withProducts()), 'media');
  assert.equal(nextIntakeStep(withProducts({
    assistantIntake: { products: 'more' },
  })), 'products');
  assert.equal(nextIntakeStep(withProducts({
    media: { uncategorized: ['/foto.jpg'] },
  })), 'logo');
  assert.equal(nextIntakeStep(withProducts({
    media: { uncategorized: ['/foto.jpg'] },
    brandIdentity: { logos: { normal: '/logo.png' } },
  })), 'staff');
  assert.equal(nextIntakeStep(bank({
    assistantIntake: { products: 'skipped', media: 'skipped', logo: 'skipped' },
  })), 'staff');
});

test('the onboarding signer does not count as a team listing', () => {
  const signerOnly = withProducts({
    media: { logos: ['/logo.png'] },
    brandIdentity: { logos: { normal: '/logo.png' } },
    staff: [{ id: 'ansatt-signer', name: 'Ola', title: 'Daglig leder' }],
  });
  assert.equal(hasListedTeam(signerOnly), false);
  assert.equal(nextIntakeStep(signerOnly), 'staff');
  const listed = {
    ...signerOnly,
    staff: [
      ...signerOnly.staff,
      { id: 'ansatt-2', name: 'Kari', title: 'Baker' },
    ],
  };
  assert.equal(nextIntakeStep(listed), 'hours');
});

test('template opening hours still need an answer, custom hours do not', () => {
  const readyForHours = withProducts({
    media: { uncategorized: ['/a.jpg'] },
    brandIdentity: { logos: { normal: '/logo.png' } },
    staff: [{ id: 'ansatt-2', name: 'Kari' }],
  });
  assert.equal(hoursLookCustom(readyForHours), false);
  assert.equal(nextIntakeStep(readyForHours), 'hours');
  const custom = {
    ...readyForHours,
    openingHours: { status: 'set', days: readyForHours.openingHours.days },
  };
  assert.equal(nextIntakeStep(custom), 'affiliations');
  const finished = {
    ...custom,
    affiliations: [{ categoryName: 'Partnere', items: [{ title: 'Acme' }] }],
  };
  assert.equal(nextIntakeStep(finished), 'done');
});

test('opening hours cover weekdays, 24/7, not relevant, and an unnamed range', () => {
  const week = parseOpeningHoursAnswer('mandag til fredag 9-17, lørdag stengt');
  assert.equal(week.action, 'set');
  assert.equal(week.days[0].opensAt, '09:00');
  assert.equal(week.days[4].closesAt, '17:00');
  assert.equal(week.days[4].closed, false);
  assert.equal(week.days[5].closed, true);
  assert.equal(week.days[6].closed, true);

  const always = parseOpeningHoursAnswer('vi er åpne 24/7');
  assert.equal(always.status, 'always');
  assert.equal(always.days.every((day) => day.opensAt === '00:00' && !day.closed), true);

  const skip = parseOpeningHoursAnswer('ikke relevant for oss');
  assert.equal(skip.status, 'not-relevant');
  assert.equal(skip.days.every((day) => day.closed), true);

  const allDay = parseOpeningHoursAnswer('10-18');
  assert.equal(allDay.action, 'set');
  assert.equal(allDay.days.filter((day) => day.opensAt === '10:00' && day.closesAt === '18:00').length, 7);
  assert.equal(alwaysOpenDays()[0].closesAt, '23:59');
});

test('staff and partner answers land in the right shape', () => {
  const staff = parseStaffAnswer('Kari Nord, baker, 90011223, kari@firma.no\nPer Berg, 41223344');
  assert.equal(staff.action, 'save');
  assert.equal(staff.people[0].name, 'Kari Nord');
  assert.equal(staff.people[0].title, 'baker');
  assert.equal(staff.people[0].phone, '90011223');
  assert.equal(staff.people[0].email, 'kari@firma.no');
  assert.equal(staff.people[1].name, 'Per Berg');
  assert.equal(parseStaffAnswer('ja').action, 'details');
  assert.equal(parseStaffAnswer('nei takk').action, 'skip');

  const partners = parseAffiliationsAnswer('Sponsorer: Acme, Beta\nSamarbeid: Gamma');
  assert.equal(partners.action, 'save');
  assert.deepEqual(partners.categories.map((row) => row.categoryName), ['Sponsorer', 'Samarbeid']);
  assert.deepEqual(partners.categories[0].items.map((row) => row.title), ['Acme', 'Beta']);
  assert.equal(partners.categories[1].items[0].title, 'Gamma');
});

test('a short no is a decline, a no that includes a site is not', () => {
  assert.equal(isDecline('nei'), true);
  assert.equal(isDecline('hopp over'), true);
  assert.equal(isDecline('nei, se cafeen.no'), false);
  assert.equal(isDecline('har ikke produkter, men https://firma.no/meny'), false);
  assert.equal(isNoMore('det er alt'), true);
  assert.equal(isNoMore('ikke mer'), true);
  assert.equal(isNoMore('mandag til fredag 9-16'), false);
});

test('questions stay the same for one business and change across businesses', () => {
  const first = questionFor('products', 'Alpha Bakeri');
  assert.equal(questionFor('products', 'Alpha Bakeri'), first);
  const variants = ['Alpha Bakeri', 'Beta Snekker', 'Gamma Klinikk', 'Delta Regnskap', 'Echo Foto', 'Foxtrot Data']
    .map((name) => questionFor('products', name));
  assert.ok(new Set(variants).size > 1);
  assert.equal(questionFor('staff', 'Alpha Bakeri').includes('tonalitet'), false);
  assert.match(questionFor('done', 'Alpha Bakeri'), /steg|ferdig|skrive|velg/i);
  assert.doesNotMatch(questionFor('done', 'Alpha Bakeri'), /bedriftsinformasjon/i);
  assert.equal(businessLabel({ businessCard: { companyName: 'Alpha Bakeri' } }), 'Alpha Bakeri');
  assert.equal(personFirstName({ name: 'Kari Nord', businessName: 'Alpha Bakeri' }), 'Kari');
  assert.equal(personFirstName({ businessName: 'Alpha Bakeri' }), '');
});

test('opening state follows the next missing bucket and stays on the assistant when finished', () => {
  const open = buildOpeningState({ clientDataBank: bank(), businessName: 'Nordlys' });
  assert.equal(open.currentStep, 'products');
  assert.match(open.greeting, /Nordlys|tilbud|produkt|meny|prisliste/i);
  assert.equal(open.redirectTo, '');

  const done = buildOpeningState({
    clientDataBank: withProducts({
      media: { uncategorized: ['/a.jpg'] },
      brandIdentity: { logos: { normal: '/logo.png' } },
      staff: [{ id: 'ansatt-2', name: 'Kari', title: 'Baker' }],
      openingHours: { status: 'always', days: alwaysOpenDays() },
      affiliations: [{ categoryName: 'Partnere', items: [{ title: 'Acme' }] }],
    }),
  });
  assert.equal(done.currentStep, 'done');
  assert.equal(done.redirectTo, '');
  assert.match(done.greeting, /steg|bedriftsinformasjon|ferdig/i);
});

test('already gathered files stay on the matching step', () => {
  const review = intakeReview(withProducts({
    media: {
      mainHeroImages: ['/hero.jpg'],
      uncategorized: ['/extra.png'],
      logos: ['/logo.png'],
    },
    brandIdentity: { logos: { normal: '/logo.png' } },
    staff: [{ id: 'ansatt-2', name: 'Kari', title: 'Baker' }],
    openingHours: { status: 'always', days: alwaysOpenDays() },
    affiliations: [{ categoryName: 'Sponsorer', items: [{ title: 'Acme' }] }],
  }));
  const byStep = Object.fromEntries(review.steps.map((row) => [row.step, row]));
  assert.equal(review.current, 'done');
  assert.equal(byStep.products.status, 'filled');
  assert.equal(byStep.media.status, 'filled');
  assert.deepEqual(byStep.media.groups.map((group) => group.label), ['Hovedbilde', 'Logo', 'Annet']);
  assert.equal(byStep.logo.url, '/logo.png');
  assert.equal(byStep.logo.status, 'filled');
  assert.equal(byStep.staff.people[0].name, 'Kari');
  assert.equal(byStep.hours.summary, 'Døgnåpent');
  assert.equal(byStep.affiliations.groups[0].items[0], 'Acme');
});

test('page text keeps headings and prices and ranks offering pages first', () => {
  const text = readablePageText('<nav>Hopp</nav><h2>Kaker</h2><p>Bolle 40 kr</p><script>secret()</script>');
  assert.match(text, /## Kaker/);
  assert.match(text, /Bolle 40 kr/);
  assert.equal(text.includes('Hopp'), false);
  assert.equal(text.includes('secret'), false);

  const ranked = rankOfferingPages([
    { url: 'https://firma.no/om', text: '## Om oss\nVi holder til i byen.' },
    { url: 'https://firma.no/meny', text: '## Meny\nBolle 40 kr\nKake 80 kr\nKaffe 30 kr' },
  ]);
  assert.equal(ranked[0].url, 'https://firma.no/meny');

  const corpus = formatWebsiteCorpus({
    url: 'https://firma.no',
    catalog: { categories: [{ name: 'Kaker', products: [{ title: 'Bolle', price: '40 kr', description: 'Nybagt' }] }] },
    pageTexts: ranked,
  });
  assert.ok(corpus.indexOf('/meny') < corpus.indexOf('/om'));
  assert.match(corpus, /Kaker \| Bolle \| 40 kr/);
  assert.match(corpus, /## Meny/);
  assert.ok(corpus.length < 120000);

  const pages = Array.from({ length: 30 }, (_, index) => ({
    url: `https://firma.no/side-${index}`,
    text: `${index < 3 ? 'Bolle 40 kr\n'.repeat(30) : 'Om oss uten pris. '.repeat(40)}\n${'x'.repeat(8000)}`,
  }));
  const large = formatWebsiteCorpus({ url: 'https://firma.no', pageTexts: pages });
  assert.ok(large.length < 105000);
  assert.match(large, /40 kr/);
  assert.equal(large.includes('side-0'), true);
  assert.equal(large.includes('side-20'), false);
});

test('website reconcile can follow the AI groups, file imports stay deterministic', () => {
  const det = {
    layout: 'normal',
    label: 'normal',
    categories: [{
      name: 'Alt',
      products: ['A', 'B', 'C', 'D'].map((name, index) => ({
        title: name,
        name,
        price: `${(index + 1) * 10} kr`,
      })),
    }],
  };
  const ai = {
    layout: 'normal',
    label: 'normal',
    categories: [
      {
        name: 'Gruppe en',
        products: [
          { title: 'A', name: 'A', price: '', imageUrl: 'https://cdn.example/a.jpg' },
          { title: 'B', name: 'B', price: '20 kr' },
        ],
      },
      {
        name: 'Gruppe to',
        products: [
          { title: 'C', name: 'C', price: '30 kr' },
          { title: 'D', name: 'D', price: '40 kr' },
        ],
      },
    ],
  };
  const preferred = reconcileDeterministicWithAi({
    deterministic: { catalogs: [det] },
    aiCatalogs: [ai],
    preferAi: true,
  });
  const names = preferred.flatMap((catalog) => (catalog.categories || []).map((category) => category.name));
  assert.ok(names.includes('Gruppe en') || names.some((name) => /gruppe/i.test(name)));
  const products = preferred.flatMap((catalog) => (catalog.categories || []).flatMap((category) => category.products || []));
  assert.ok(products.length >= 4);
  const itemA = products.find((product) => /A/.test(product.title || product.name || ''));
  assert.equal(itemA.price, '10 kr');
  assert.match(itemA.imageUrl || itemA.image || '', /cdn\.example\/a\.jpg/);

  const kept = reconcileDeterministicWithAi({
    deterministic: { catalogs: [det] },
    aiCatalogs: [ai],
  });
  const keptNames = kept.flatMap((catalog) => (catalog.categories || []).map((category) => category.name));
  assert.ok(keptNames.includes('Alt') || !keptNames.includes('Gruppe en'));
});

test('job results can carry the settings redirect', () => {
  const job = createAssistantJob('user-1', 'ingest');
  updateAssistantJob(job.id, { status: 'done', redirectTo: SETTINGS_PATH, nextAction: 'done', assistantMessage: 'Ferdig' });
  const view = publicJobView(job);
  assert.equal(view.redirectTo, SETTINGS_PATH);
  assert.equal(view.nextAction, 'done');
});

test('intake flags and opening-hour status survive a later settings save', () => {
  portal.upsertClientProfile('intake-flag-user', { businessName: 'Testkafe', email: 'intake-flag@example.com' });
  portal.setClientDataBank('intake-flag-user', {
    businessCard: { companyName: 'Testkafe' },
    assistantIntake: { products: 'skipped', hours: 'done' },
    openingHours: { status: 'always', days: alwaysOpenDays() },
  });
  const first = portal.getClientProfileByUserId('intake-flag-user');
  assert.equal(first.clientDataBank.assistantIntake.products, 'skipped');
  assert.equal(first.clientDataBank.openingHours.status, 'always');
  assert.equal(first.clientDataBank.openingHours.days[0].opensAt, '00:00');

  portal.setClientDataBank('intake-flag-user', {
    businessCard: { companyName: 'Testkafe AS' },
    assistantIntake: { products: 'more' },
  });
  const second = portal.getClientProfileByUserId('intake-flag-user');
  assert.equal(second.clientDataBank.assistantIntake.products, 'more');
  assert.equal(second.clientDataBank.assistantIntake.hours, 'done');
  assert.equal(second.clientDataBank.openingHours.status, 'always');
  assert.equal(second.clientDataBank.businessCard.companyName, 'Testkafe AS');
});

test('a pasted website is not scraped; the assistant asks for a document', async () => {
  portal.upsertClientProfile('url-chat-user', { businessName: 'Urlkafe' });
  const reply = await handleAssistantChat('url-chat-user', { text: 'sjekk https://cafeen.no/meny' });
  assert.equal(reply.jobId || '', '');
  assert.equal(reply.nextAction, 'wait');
  assert.match(reply.assistantMessage, /dokument|fil|PDF|Excel/i);
  assert.doesNotMatch(reply.assistantMessage, /går gjennom hele/i);
});

test('a document uploaded on the media step is read as text', async () => {
  portal.upsertClientProfile('media-doc-user', { businessName: 'Dokkafe' });
  const skipped = await handleAssistantChat('media-doc-user', { text: 'nei' });
  assert.equal(skipped.currentStep, 'media');
  const txt = await handleAssistantChat('media-doc-user', {
    text: '',
    files: [{ originalName: 'meny.txt', mimeType: 'text/plain', buffer: Buffer.from('Bolle 40 kr') }],
  });
  assert.ok(txt.jobId);
  assert.equal(txt.nextAction, 'ingest');
  assert.match(txt.assistantMessage, /dokument/i);
  assert.doesNotMatch(txt.assistantMessage, /hører ikke hjemme|bare bilder/i);
});

test('the assistant walks the missing buckets and writes each answer into kundedata', async () => {
  portal.upsertClientProfile('intake-chat-user', { businessName: 'Chatkafe' });
  const skipped = await handleAssistantChat('intake-chat-user', { text: 'nei' });
  assert.equal(skipped.currentStep, 'media');
  assert.match(skipped.assistantMessage, /bilde|video/i);
  assert.doesNotMatch(skipped.assistantMessage, /Normal —|Meny —|Tiers/);

  const photo = await handleAssistantChat('intake-chat-user', {
    text: '',
    files: [{
      originalName: 'lokalet.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }],
  });
  assert.equal(photo.currentStep, 'media');
  assert.match(photo.assistantMessage, /flere|mer|nok|sikker/i);
  const afterMedia = portal.getClientProfileByUserId('intake-chat-user').clientDataBank;
  assert.equal(afterMedia.media.uncategorized.length, 1);
  assert.equal(afterMedia.assistantIntake.media, 'more');

  const mediaDone = await handleAssistantChat('intake-chat-user', { text: 'det er alt' });
  assert.equal(mediaDone.currentStep, 'logo');

  const logo = await handleAssistantChat('intake-chat-user', {
    text: '',
    files: [{
      originalName: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }],
  });
  assert.equal(logo.currentStep, 'staff');
  assert.match(logo.assistantMessage, /logo/i);
  const afterLogo = portal.getClientProfileByUserId('intake-chat-user').clientDataBank;
  assert.ok(afterLogo.brandIdentity.logos.normal.includes('/client-media/'));
  assert.equal(afterLogo.media.logos.length, 1);

  const details = await handleAssistantChat('intake-chat-user', { text: 'ja' });
  assert.equal(details.currentStep, 'staff');
  assert.match(details.assistantMessage, /navn/i);

  const people = await handleAssistantChat('intake-chat-user', {
    text: 'Kari Nord, baker, 90011223, kari@firma.no',
  });
  assert.equal(people.currentStep, 'staff');
  assert.match(people.assistantMessage, /legge til mer|ansatt/i);
  const staff = portal.getClientProfileByUserId('intake-chat-user').clientDataBank.staff;
  assert.equal(staff.some((row) => row.name === 'Kari Nord' && row.email === 'kari@firma.no'), true);

  const staffDone = await handleAssistantChat('intake-chat-user', { text: 'nei' });
  assert.equal(staffDone.currentStep, 'hours');

  const vague = await handleAssistantChat('intake-chat-user', { text: 'vi har vanligvis åpent' });
  assert.equal(vague.currentStep, 'hours');
  assert.match(vague.assistantMessage, /feltene under|ikke er relevant|chatten/i);

  const hours = await handleAssistantChat('intake-chat-user', { text: 'døgnåpent' });
  assert.equal(hours.currentStep, 'affiliations');
  assert.doesNotMatch(hours.assistantMessage, /alle dagene|fylt ut alle/i);
  assert.equal(portal.getClientProfileByUserId('intake-chat-user').clientDataBank.openingHours.status, 'always');

  const done = await handleAssistantChat('intake-chat-user', { text: 'Sponsorer: Acme, Beta' });
  assert.equal(done.currentStep, 'affiliations');
  assert.match(done.assistantMessage, /legge til mer|partner/i);
  const finished = await handleAssistantChat('intake-chat-user', { text: 'ikke mer' });
  assert.equal(finished.currentStep, 'done');
  assert.equal(finished.nextAction, 'done');
  assert.equal(finished.redirectTo, '');
  const finalBank = portal.getClientProfileByUserId('intake-chat-user').clientDataBank;
  assert.equal(finalBank.affiliations[0].categoryName, 'Sponsorer');
  assert.deepEqual(finalBank.affiliations[0].items.map((item) => item.title), ['Acme', 'Beta']);
  assert.equal(finalBank.assistantIntake.products, 'skipped');
  assert.equal(finalBank.assistantIntake.logo, 'done');
});

test('add-more is only asked when that chapter already has something', () => {
  assert.doesNotMatch(promptFor('logo', 'Nordlys', bank()), /legge til mer/i);
  assert.match(promptFor('logo', 'Nordlys', bank()), /logo/i);
  assert.doesNotMatch(promptFor('products', 'Nordlys', bank({ assistantIntake: { products: 'more' } })), /legge til mer/i);
  assert.match(promptFor('media', 'Nordlys', withProducts({
    media: { uncategorized: ['/a.jpg'] },
    assistantIntake: { media: 'more' },
  })), /legge til mer i mediabiblioteket/i);
  assert.match(promptFor('products', 'Nordlys', withProducts(), { revisit: true }), /legge til mer i produktinformasjonen/i);
  assert.equal(parseOpeningHoursAnswer('Åpent hele tiden').status, 'always');
  assert.equal(navigationTarget('gå til logo'), 'logo');
  assert.equal(navigationTarget('gå til åpningstider'), 'hours');
  assert.equal(navigationTarget('Åpningstidene er mandag til fredag 9-17'), '');
  assert.equal(sideWrite('Åpningstidene er mandag til fredag 9-17', 'products')?.kind, 'hours');
});

test('a named chapter opens there, and a written fact is saved from another step', async () => {
  portal.upsertClientProfile('nav-user', { businessName: 'Navkafe' });
  const logo = await handleAssistantChat('nav-user', { text: 'gå til logo' });
  assert.equal(logo.currentStep, 'logo');
  assert.match(logo.assistantMessage, /logo/i);
  assert.doesNotMatch(logo.assistantMessage, /legge til mer/i);
  assert.equal(logo.profile.clientDataBank.assistantIntake.focus, 'logo');

  const hours = await handleAssistantChat('nav-user', {
    text: 'Åpningstidene er mandag til fredag 9-17, lørdag stengt, søndag stengt',
  });
  assert.equal(portal.getClientProfileByUserId('nav-user').clientDataBank.openingHours.days[0].opensAt, '09:00');
  assert.match(hours.assistantMessage, /Åpningstidene er lagret/);

  const opened = await handleAssistantChat('nav-user', { text: '', focusStep: 'products' });
  assert.equal(opened.currentStep, 'products');
  assert.doesNotMatch(opened.assistantMessage, /legge til mer/i);
});

test('a finished client can still change hours and open a chapter that already has data', async () => {
  portal.upsertClientProfile('done-user', { businessName: 'Ferdig' });
  portal.setClientDataBank('done-user', {
    businessCard: { companyName: 'Ferdig' },
    productCatalogs: [{ categories: [{ name: 'Varer', products: [{ title: 'Lampe' }] }] }],
    media: { uncategorized: ['/a.jpg'] },
    brandIdentity: { logos: { normal: '/logo.png' } },
    staff: [{ id: 'ansatt-2', name: 'Kari', title: 'Baker' }],
    openingHours: { status: 'set', days: alwaysOpenDays() },
    affiliations: [{ categoryName: 'Partnere', items: [{ title: 'Acme' }] }],
    assistantIntake: {
      products: 'done',
      media: 'done',
      logo: 'done',
      staff: 'done',
      hours: 'done',
      affiliations: 'done',
    },
  });
  const changed = await handleAssistantChat('done-user', { text: 'endre åpningstidene til åpent hele tiden' });
  assert.equal(portal.getClientProfileByUserId('done-user').clientDataBank.openingHours.status, 'always');
  assert.match(changed.assistantMessage, /hele tiden/i);

  const staff = await handleAssistantChat('done-user', { text: 'gå til ansatte' });
  assert.equal(staff.currentStep, 'staff');
  assert.match(staff.assistantMessage, /legge til mer i ansattinformasjonen/i);
});
