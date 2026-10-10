import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-sales-offers-'));
process.env.APP_DATA_DIR = dataDir;

const tiers = await import('../lib/website-tiers.js');
const offerEmail = await import('../lib/offer-email.js');
const readiness = await import('../lib/offer-readiness.js');
const contractPdf = await import('../lib/offer-contract-pdf.js');
const matcher = await import('../lib/fireflies-client-match.js');
const offerAi = await import('../lib/offer-ai.js');
const quoteOffer = await import('../lib/offer-from-quote.js');
const store = await import('../data/sales-offers.js');

const CLIENT = {
  id: 'client-1',
  ownerId: 'sales-anna',
  businessName: 'Byneset Bydelskafé AS',
  contactPerson: 'Kari Nordmann',
  contactEmail: 'kari@byneset-kafe.no',
  orgNumber: '923 456 789',
  businessAddress: 'Bynesveien 1, 7070 Bosberg',
  meetingPlace: '',
  websiteDomain: 'byneset-kafe.no',
  meetingAt: '2026-09-18T10:00:00.000Z',
};

test('website tiers: 5/7/10 pages, SEO tier has Google/Maps/AI, only e-commerce is multilingual', () => {
  const [t1, t2, t3] = tiers.WEBSITE_TIERS;
  assert.deepEqual([t1.pages, t2.pages, t3.pages], [5, 7, 10]);
  const has = (tier, re) => tier.includes.some((line) => re.test(line));
  assert.ok(has(t2, /google maps/i), 'tier 2 lists Google Maps ranking');
  assert.ok(has(t2, /google/i) && has(t2, /\bAI\b/i), 'tier 2 lists Google ranking + AI');
  assert.ok(has(t3, /flerspråk|multilingual/i), 'tier 3 is multilingual');
  assert.ok(!has(t1, /flerspråk/i) && !has(t2, /flerspråk/i), 'tier 1/2 are not multilingual');
  assert.ok(has(t2, /bi-ukentlig grunrapport/i), 'tier 2 lists bi-weekly basic report');
  assert.ok(has(t3, /ukentlig avansert rapport/i), 'tier 3 lists weekly advanced report');
  assert.ok(!has(t1, /rapport/i) && !has(t1, /analyse-dashbord/i), 'tier 1 has no analytics reporting');
  assert.ok(has(t1, /koble til eget domene/i) && has(t1, /veiledningsmøte/i), 'tier 1 includes domain + guidance');
  assert.ok(has(t1, /14 arbeidsdager/) && has(t2, /14 arbeidsdager/) && has(t3, /21 arbeidsdager/));
  assert.ok(!has(t1, /2 uker/) && !has(t2, /2 uker/) && !has(t3, /3 uker/), 'pricing copy uses arbeidsdager, not weeks');
  assert.ok(!has(t1, /skreddersydde web/i) && !has(t2, /api-integrasjon/i) && !has(t3, /dedikert server/i));
  assert.equal(tiers.analyticsLevelForPlan(t2.id), 'basic');
  assert.equal(tiers.reportingIntervalDaysForLevel('basic'), 14);
  assert.equal(tiers.reportingIntervalDaysForLevel('advanced'), 7);
  assert.equal(tiers.withMva(1000), 1250);
});

test('offer email: tier block shows package, "opp til N sider", ex/incl mva per month, and is idempotent', () => {
  const products = offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id);
  assert.equal(products.length, 1);
  assert.equal(products[0].kind, 'tier');
  const email = offerEmail.buildOfferEmail({ client: CLIENT, products, mergeTags: false });
  assert.match(email.html, /Opp til 7 sider/);
  assert.match(email.html, /eks\. mva/i);
  assert.match(email.html, /inkl\. mva/i);
  assert.match(email.html, /per måned|\/ ?mnd/i);
  assert.match(email.subject, /Byneset/);

  // Swapping tier replaces the block instead of appending a second one.
  const swapped = offerEmail.applyOfferProducts(email.html, offerEmail.productsWithTier(products, tiers.WEBSITE_TIERS[2].id));
  assert.match(swapped, /Opp til 10 sider/);
  assert.doesNotMatch(swapped, /Opp til 7 sider/);
  assert.equal((swapped.match(/id="offer-products"/g) || []).length, 1);

  // Custom products survive a tier change.
  const custom = { id: 'c1', kind: 'custom', name: 'Bookingsystem', priceExMva: 500, pages: 0, includes: ['Online booking'], note: '', deliveryWeeks: 2 };
  const mixed = offerEmail.productsWithTier([...products, custom], tiers.WEBSITE_TIERS[2].id);
  assert.deepEqual(mixed.map((item) => item.kind), ['tier', 'custom']);
  const totals = offerEmail.offerTotals(mixed);
  assert.equal(totals.exMva, tiers.WEBSITE_TIERS[2].monthlyExMva + 500);
  assert.equal(totals.inclMva, Math.round(totals.exMva * 1.25));
});

test('offer email: attribute reordering from the visual editor does not break slot replacement', () => {
  const html = '<p style="x" data-offer-slot="terms">old</p><div style="a" id="offer-products"><b>x</b><div style="b" id="offer-products-end"></div></div>';
  const filled = offerEmail.fillOfferSlots(html, { terms: 'Vi trenger logo og bilder.' });
  assert.match(filled, /Vi trenger logo og bilder\./);
  assert.equal(filled.includes('Kundebetingelser'), false);
  const replaced = offerEmail.replaceOfferProducts(filled, offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id));
  assert.match(replaced, /Opp til 5 sider/);
  assert.doesNotMatch(replaced, /<b>x<\/b>/);
});

test('offer email: meeting copy fills open slots and leaves text the rep already wrote', () => {
  const html = offerEmail.buildOfferEmail({ client: CLIENT, products: [], mergeTags: true }).html;
  assert.equal(offerEmail.offerSlotIsOpen(html, 'need'), true);
  assert.equal(offerEmail.offerSlotIsOpen(html, 'project'), true);
  const filled = offerEmail.fillOfferSlots(html, {
    need: 'ny nettside for kafeen',
    project: ['Vi lager en ny side for meny og booking.'],
    terms: 'Dere sender logo og bilder.',
    benefits: 'Gjestene finner menyen før de kommer.',
  }, { onlyOpen: true });
  assert.match(filled, /data-offer-slot="need"[^>]*>ny nettside for kafeen</);
  assert.match(filled, /data-offer-slot="project"[^>]*>[\s\S]*meny og booking/);
  assert.match(filled, /Dere sender logo og bilder\./);
  assert.equal(filled.includes('Kundebetingelser'), false);
  assert.equal(offerEmail.offerSlotIsOpen(filled, 'project'), false);
  const again = offerEmail.fillOfferSlots(filled, {
    project: ['Dette skal ikke overskrive.'],
    terms: 'Heller ikke dette.',
  }, { onlyOpen: true });
  assert.match(again, /meny og booking/);
  assert.doesNotMatch(again, /Dette skal ikke overskrive/);
});

test('offer AI skips a noise transcript under 10 lines and keeps a real conversation', () => {
  const noise = Array.from({ length: 4 }, (_, i) => `Ukjent: lyd ${i}`).join('\n');
  assert.equal(offerAi.meetingContextIsTooThin({ transcript: noise, summary: 'Kort støy.' }), true);
  assert.equal(offerAi.meetingContextIsTooThin({ transcript: '', summary: 'Ingen snakket.' }), true);
  const talk = Array.from({ length: 12 }, (_, i) => `Kari: setning nummer ${i} om nettsiden.`).join('\n');
  assert.equal(offerAi.meetingContextIsTooThin({ transcript: talk }), false);
});

test('pasted Fireflies title finds the stored meeting', async () => {
  const hooks = await import('../lib/fireflies-webhook.js');
  const rows = [
    { meetingId: 'aaa', title: 'Asoldi x Byneset Bydelskafé' },
    { meetingId: 'bbb', title: 'Internt standup' },
  ];
  const hit = hooks.rankMeetingsByTitle(rows, 'Byneset Bydelskafé');
  assert.equal(hit[0].meetingId, 'aaa');
  assert.equal(hooks.rankMeetingsByTitle(rows, 'ab').length, 0);
  const linked = hooks.rankMeetingsByTitle(
    [{ meetingId: '01M39D9CR6WJ5C5BQHKWV3YE6D', title: 'Sales meeting', transcriptUrl: 'https://app.fireflies.ai/view/sales-meeting::01M39D9CR6WJ5C5BQHKWV3YE6D' }],
    'https://app.fireflies.ai/view/sales-meeting::01M39D9CR6WJ5C5BQHKWV3YE6D'
  );
  assert.equal(linked[0].meetingId, '01M39D9CR6WJ5C5BQHKWV3YE6D');
  assert.deepEqual(
    hooks.firefliesIdsFromPaste('https://app.fireflies.ai/view/sales-meeting::01M39D9CR6WJ5C5BQHKWV3YE6D'),
    ['sales-meeting::01M39D9CR6WJ5C5BQHKWV3YE6D', '01M39D9CR6WJ5C5BQHKWV3YE6D']
  );
  assert.deepEqual(
    hooks.firefliesGraphqlIdsFromPaste('https://app.fireflies.ai/view/sales-meeting::01M39D9CR6WJ5C5BQHKWV3YE6D'),
    ['01M39D9CR6WJ5C5BQHKWV3YE6D']
  );
  assert.equal(hooks.storedMeetingHasTalk({ transcript: 'Kunde: hei' }), true);
  assert.equal(hooks.storedMeetingHasTalk({ summary: 'Kort' }), true);
  assert.equal(hooks.storedMeetingHasTalk({ title: 'Møte' }), false);
});

test('fireflies matcher: only the booked sales meeting counts, not a later calendar reminder', () => {
  const client = { ...CLIENT, agreedTime: true, meetingAt: '2026-09-18T10:00:00.000Z' };
  assert.equal(matcher.recordingMatchesSalesMeeting(client, { startedAt: '2026-09-18T10:12:00.000Z' }), true);
  assert.equal(matcher.recordingMatchesSalesMeeting(client, { startedAt: '2026-09-25T10:00:00.000Z' }), false);
  assert.equal(matcher.recordingMatchesSalesMeeting({ ...client, agreedTime: false }, { startedAt: '2026-09-18T10:12:00.000Z' }), false);
});

test('offer draft shows the client and the editing rep instead of identity merge tags', async () => {
  const templates = await import('../lib/email-templates-store.js');
  const email = templates.buildOfferEmailForClient(CLIENT, {}, {
    sender: { name: 'Alexander', fromEmail: 'alexander@asoldi.com', phone: '+47 923 31 098' },
  });
  const html = offerEmail.resolveOfferIdentityTags(email.html, {
    firstName: 'Kari',
    fullName: 'Kari Nordmann',
    businessName: 'Byneset Bydelskafé AS',
    signerName: 'Alexander',
    signerEmail: 'alexander@asoldi.com',
    signerPhone: '+47 923 31 098',
  });
  const subject = offerEmail.resolveOfferIdentityTags(email.subject, {
    businessName: 'Byneset Bydelskafé AS',
  }, { escape: false });
  assert.match(html, /Hei Kari,/);
  assert.match(html, /Alexander fra Asoldi/);
  assert.match(html, /alexander@asoldi.com/);
  assert.match(html, /\+47 923 31 098/);
  assert.match(html, /\{\{need\}\}/);
  assert.equal(subject, 'Tilbud til Byneset Bydelskafé AS fra Asoldi');
  const old = offerEmail.refreshOfferShell('<p><strong>Kundebetingelser:</strong> Dere sender logo.</p><p>Nettsiden bygges i vårt eget CMS. Der ligger automatiserte prosesser.</p><h2>Hva som skjer fremover</h2><p>Vedlagt ligger kontrakten for valgt pakke. Den signeres først når dere har bestemt dere – ingenting betales før nettsiden er levert.</p>');
  assert.equal(old.includes('Kundebetingelser'), false);
  assert.match(old, /Dere sender logo/);
  assert.doesNotMatch(old, /eget CMS/);
  assert.doesNotMatch(old, /Vedlagt ligger kontrakten/);
  assert.match(old, /Hva som skjer fremover[\s\S]*signert kontrakten som er vedlagt/);
  const fromReply = offerEmail.refreshOfferShell('<h2>Hva som skjer fremover</h2><p data-offer-fixed="next">Etter at dere har sett på tilbudet og vi har mottatt svar vil vi avtale oppstarts tid.</p>');
  assert.match(fromReply, /signert kontrakten som er vedlagt/);
  assert.doesNotMatch(fromReply, /mottatt svar/);
});

test('offer party: empty override uses the card, Til is the website email, map address is the address', () => {
  assert.equal(readiness.contractAddressFor({ meetingPlace: 'Kartveien 1', businessAddress: 'Gammel vei 2' }), 'Kartveien 1');
  const resolved = readiness.resolveOfferParty(CLIENT, {
    party: { businessName: 'Annet AS', orgNumber: '', address: '', contactPerson: '', contactEmail: 'annet@example.com' },
  }, { to: 'til@example.com' });
  assert.equal(resolved.businessName, 'Annet AS');
  assert.equal(resolved.orgNumber, CLIENT.orgNumber.replace(/\D+/g, ''));
  assert.equal(resolved.address, CLIENT.meetingPlace || CLIENT.businessAddress);
  assert.equal(resolved.contactPerson, CLIENT.contactPerson);
  assert.equal(resolved.contactEmail, 'til@example.com');
  const cleared = readiness.resolveOfferParty(CLIENT, { party: { businessName: '', contactEmail: 'annet@example.com' } });
  assert.equal(cleared.businessName, CLIENT.businessName);
  assert.equal(cleared.contactEmail, CLIENT.contactEmail);
  const website = readiness.resolveOfferParty(
    { ...CLIENT, websiteEmail: 'post@kafe.no' },
    { party: { contactEmail: 'annet@example.com' } },
  );
  assert.equal(website.contactEmail, 'post@kafe.no');
});

test('offer readiness: contract fields must be on the client card', () => {
  assert.deepEqual(readiness.offerMissingFields(CLIENT), []);
  const missing = readiness.offerMissingFields({ ...CLIENT, orgNumber: '123', contactEmail: 'nope' });
  assert.deepEqual(missing.map((item) => item.key), ['orgNumber', 'contactEmail']);
  assert.match(readiness.offerReadinessMessage(missing), /Org\. nr/);
  // meetingPlace is accepted as the address fallback
  assert.equal(readiness.offerIsReady({ ...CLIENT, businessAddress: '', meetingPlace: 'Gata 1' }), true);
});

test('contract pdf: tier contract and custom-summary contract both render a PDF', async () => {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const signaturePng = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'asoldi-contract-signature.png');
  assert.equal(existsSync(signaturePng), true, 'Asoldi signature PNG is in the repo');

  const tierBuffer = await contractPdf.buildContractPdf({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[0].id });
  assert.ok(Buffer.isBuffer(tierBuffer));
  assert.equal(tierBuffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(tierBuffer.length > 8000, 'signed contract embeds the Asoldi signature image');
  assert.match(tierBuffer.toString('latin1'), /\/Subtype\s*\/Image/);

  const summary = {
    title: 'Avtale om nettside og drift',
    products: [{ id: 'p1', kind: 'custom', name: 'Skreddersydd nettside', pages: 12, includes: ['Design', 'Booking'], note: '', priceExMva: 4000, deliveryWeeks: 6 }],
    monthlyExMva: 4000,
    deliveryWeeks: 6,
    extraTerms: ['Kunden leverer tekst innen 2 uker'],
    scopeSummary: 'Nettside med booking.',
  };
  const customBuffer = await contractPdf.buildContractPdf({ client: CLIENT, tierId: 'custom', summary, preferSummary: true });
  assert.equal(customBuffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(contractPdf.contractFileName({ client: CLIENT, tierId: 'custom' }), /Skreddersydd/);
  assert.match(contractPdf.contractFileName({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[1].id }), /Tier-2/);

  // A verified custom summary makes the contract available even without a fixed tier
  assert.equal(contractPdf.offerContractIsAvailable({ tierId: 'custom', products: summary.products, contract: { summary: null } }), false);
  assert.equal(contractPdf.offerContractIsAvailable({ tierId: 'custom', products: summary.products, contract: { summary } }), true);
});

test('contract terms: statutory late interest, six-month liability, permanent ownership, legal pages', () => {
  const article = contractPdf.contractArticleModel({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[1].id });
  const blob = JSON.stringify(article);
  assert.match(blob, /forsinkelsesrente og gebyrer etter gjeldende norsk lov/);
  assert.match(blob, /six \(6\) months/);
  assert.match(blob, /seven \(7\) business days/);
  assert.match(blob, /asoldi\.com\/vilkar/);
  assert.match(blob, /asoldi\.com\/databehandleravtale/);
  assert.match(blob, /three \(3\) per week/);
  assert.match(blob, /basic report every fourteen \(14\) days/i);
  assert.doesNotMatch(blob, /NOK 100/);
  assert.doesNotMatch(blob, /ownership reverts/i);
  assert.doesNotMatch(blob, /last monthly payment/i);
  const seo = tiers.WEBSITE_TIERS[1];
  assert.ok(seo.includes.some((line) => /analyse-dashbord/i.test(line)));
  assert.ok(seo.includes.some((line) => /bi-ukentlig grunrapport/i.test(line)));
  assert.ok(seo.includes.some((line) => /3\/uke|3 per uke/i.test(line)));

  const starter = JSON.stringify(contractPdf.contractArticleModel({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[0].id }));
  assert.match(starter, /does not include an analytics page/i);
  assert.doesNotMatch(starter, /every fourteen \(14\) days/);

  const shop = JSON.stringify(contractPdf.contractArticleModel({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[2].id }));
  assert.match(shop, /advanced report every seven \(7\) days/i);
  assert.match(blob, /Domain connection/);
  assert.match(blob, /does not store the Client/);
  assert.match(blob, /Guidance meeting \(once\)/);
  assert.doesNotMatch(blob, /custom web.?app/i);
  assert.doesNotMatch(blob, /dedicated server/i);
  assert.doesNotMatch(blob, /advanced API/i);
  assert.ok(tiers.WEBSITE_TIERS[0].includes.some((line) => /koble til eget domene/i.test(line)));
  assert.ok(tiers.WEBSITE_TIERS[0].includes.some((line) => /veiledningsmøte/i.test(line)));
  assert.doesNotMatch(blob, /Google Business Profile development/i);
  assert.doesNotMatch(blob, /Asoldi \/ Hostinger hosting network/);
  assert.match(blob, /leaves the Asoldi hosting network/);
  assert.match(blob, /one \(1\) month of service free of charge/);
  assert.match(blob, /Domain access/);
  assert.match(blob, /inspiration materials/);
  assert.match(blob, /Sections 6 and 7 do not apply/);
});

test('opening Tilbud does not wait for Fireflies GraphQL', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
  const offerGet = server.slice(
    server.indexOf("app.get('/api/admin/sales/:id/offer', salesAuth"),
    server.indexOf("app.get('/api/admin/sales/:id/offer/meeting'")
  );
  const meetingGet = server.slice(
    server.indexOf("app.get('/api/admin/sales/:id/offer/meeting'"),
    server.indexOf("app.put('/api/admin/sales/:id/offer'")
  );
  assert.match(offerGet, /scheduleFirefliesTranscriptIngest/);
  assert.match(server, /hydrateRecentStoredTranscripts/);
  assert.equal(offerGet.includes('await ingestRecentFirefliesMeetLinks'), false);
  assert.equal(offerGet.includes('await hydrateOfferMeetings'), false);
  assert.equal(meetingGet.includes('await hydrateOfferMeetings'), false);
  assert.match(meetingGet, /refreshOfferClientMeetings/);
});

test('client card meetings show stored transcript text and hide live stubs', async () => {
  const hooks = await import('../lib/fireflies-webhook.js');
  const workshop = await import('../lib/workshop-meetings.js');
  hooks.storeFirefliesMeeting({
    meetingId: 'ff-card',
    title: 'Salgsmøte',
    transcript: 'Kunde: vi vil ha ny nettside.',
    meetingLink: 'https://meet.google.com/aaa-bbbb-ccc',
  });
  const shown = workshop.presentClientMeetings({
    id: 'c-card',
    agreedTime: true,
    meetingAt: '2026-09-18T10:00:00.000Z',
    meetings: [
      {
        meetingId: 'live:c-card:open',
        title: 'Fireflies ble sendt inn',
        meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
        hasTranscript: false,
        linkedBy: 'live-join',
        forSalesMeeting: true,
        purpose: 'sales',
      },
      {
        meetingId: 'ff-card',
        title: 'Salgsmøte',
        meetLink: 'https://meet.google.com/aaa-bbbb-ccc',
        hasTranscript: false,
        linkedBy: 'meet-link',
        purpose: 'sales',
      },
    ],
  });
  assert.equal(shown.some((row) => String(row.meetingId).startsWith('live:')), false);
  assert.equal(shown.find((row) => row.meetingId === 'ff-card')?.hasTranscript, true);
});

test('client card hides a live stub when the transcript is on another owned Meet', async () => {
  const { presentClientMeetings } = await import('../lib/workshop-meetings.js');
  const shown = presentClientMeetings({
    id: 'c-swap',
    agreedTime: true,
    meetingAt: '2026-10-08T14:00:00.000Z',
    calendar: { meetLink: 'https://meet.google.com/uss-ynky-nfw' },
    recordedMeetLinks: [
      'https://meet.google.com/idy-uiyh-efh',
      'https://meet.google.com/uss-ynky-nfw',
    ],
    meetings: [
      {
        meetingId: 'live:c-swap:open',
        meetLink: 'https://meet.google.com/idy-uiyh-efh',
        hasTranscript: false,
        linkedBy: 'live-join',
        forSalesMeeting: true,
        purpose: 'sales',
      },
      {
        meetingId: 'ff-swap',
        meetLink: 'https://meet.google.com/uss-ynky-nfw',
        hasTranscript: true,
        linkedBy: 'meet-link',
        purpose: 'sales',
      },
    ],
  });
  assert.equal(shown.some((row) => String(row.meetingId).startsWith('live:')), false);
  assert.equal(shown.find((row) => row.meetingId === 'ff-swap')?.hasTranscript, true);
});

test('fireflies matcher: only the booked Google Meet owns the recording', () => {
  const janMeet = 'https://meet.google.com/aaa-bbbb-ccc';
  const khanaMeet = 'https://meet.google.com/xxx-yyyy-zzz';
  const jan = {
    id: '1788440525558-7amjs3',
    businessName: 'Byggmester Jan Overrein',
    contactEmail: 'jan@example.com',
    calendar: { meetLink: janMeet },
    meetings: [{
      meetingId: 'khana-rec',
      title: 'Asoldi · Online møte · Khana Khajana',
      linkedBy: 'title',
    }],
  };
  const khana = {
    id: 'khana-1',
    businessName: 'Khana Khajana',
    contactEmail: 'khana@example.com',
    calendar: { meetLink: khanaMeet },
    meetings: [],
  };
  const clients = [jan, khana];

  assert.equal(matcher.matchMeetingToClients({
    title: 'Asoldi · Online møte · Khana Khajana',
    attendeeEmails: ['jan@example.com', 'khana@example.com'],
    hostEmail: 'anna@asoldi.com',
  }, clients).best, null);

  assert.equal(matcher.matchMeetingToClients({
    title: 'Asoldi · Online møte · Byggmester Jan Overrein',
    meetingLink: khanaMeet,
  }, clients).best?.clientId, 'khana-1');

  assert.equal(matcher.matchMeetingToClients({
    title: 'Khana Khajana',
    meetingLink: janMeet,
  }, clients).best?.clientId, jan.id);

  const workshop = matcher.matchMeetingToClients({
    meetingLink: 'https://meet.google.com/wrk-shop-meet',
  }, [{
    id: 'w1',
    businessName: 'Workshop Client',
    workshopAction: { meetLink: 'https://meet.google.com/wrk-shop-meet' },
  }]);
  assert.equal(workshop.best?.clientId, 'w1');

  const ambiguous = matcher.matchMeetingToClients({ meetingLink: janMeet }, [
    jan,
    { ...khana, calendar: { meetLink: janMeet } },
  ]);
  assert.equal(ambiguous.best, null);
  assert.equal(ambiguous.candidates.length, 2);

  const plan = matcher.planFirefliesMeetLinkBackfill({
    clients,
    meetings: [{
      meetingId: 'khana-rec',
      title: 'Asoldi · Online møte · Khana Khajana',
      meetingLink: khanaMeet,
    }],
  });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].toClientId, 'khana-1');
  assert.deepEqual(plan.unlinks.map((row) => row.fromClientId), [jan.id]);

  const fromListedLink = matcher.planFirefliesMeetLinkBackfill({
    clients: [{
      ...jan,
      meetings: [{ meetingId: 'listed-rec', meetLink: khanaMeet, linkedBy: 'title' }],
    }, khana],
    meetings: [],
  });
  assert.equal(fromListedLink.moves.length, 0);
  assert.equal(fromListedLink.unlinks[0]?.fromClientId, jan.id);

  const afterReschedule = matcher.matchMeetingToClients(
    { meetingLink: khanaMeet },
    [{
      ...khana,
      calendar: { meetLink: 'https://meet.google.com/new-neww-new' },
      recordedMeetLinks: [khanaMeet],
    }],
  );
  assert.equal(afterReschedule.best?.clientId, 'khana-1');

  const keepHistorical = matcher.planFirefliesMeetLinkBackfill({
    clients: [{
      id: 'k1',
      businessName: 'Kept',
      meetings: [{ meetingId: 'old-ws', linkedBy: 'meet-link' }],
    }],
    meetings: [{ meetingId: 'old-ws', meetingLink: 'https://meet.google.com/old-work-shp' }],
  });
  assert.equal(keepHistorical.unlinks.length, 0);
  assert.equal(keepHistorical.moves.length, 0);

  const titleOnly = matcher.planFirefliesMeetLinkBackfill({
    clients: [{
      ...jan,
      meetings: [{ meetingId: 'stolen', title: 'Khana Khajana', linkedBy: 'title' }],
    }, khana],
    meetings: [{ meetingId: 'stolen', title: 'Asoldi · Online møte · Khana Khajana' }],
  });
  assert.equal(titleOnly.moves.length, 0);
  assert.equal(titleOnly.unlinks[0]?.fromClientId, jan.id);

  const keptManual = matcher.planFirefliesMeetLinkBackfill({
    clients: [{
      id: 'm1',
      businessName: 'Manual',
      meetings: [{ meetingId: 'x', linkedBy: 'manual' }],
    }],
    meetings: [{ meetingId: 'x', title: 'Unknown room' }],
  });
  assert.equal(keptManual.unlinks.length, 0);
  assert.equal(keptManual.moves.length, 0);
});

test('offer AI: transcript fill and contract reflection go through the injected chat', async () => {
  const seen = [];
  const chat = async ({ system, user }) => {
    seen.push({ system, user });
    if (/source of truth/i.test(user)) {
      return {
        title: 'Avtale om nettside og drift',
        scopeSummary: 'Nettside for kafé med meny og booking.',
        products: [{ name: 'Nettside – SEO', pages: 7, includes: ['Design', 'SEO'], priceExMva: 2500 }],
        extraTerms: ['Kunden leverer bilder'],
        deliveryWeeks: 4,
      };
    }
    return { need: 'ny nettside for kafeen', project: ['Vi snakket om meny og åpningstider.'], terms: 'Dere sender logo.', benefits: 'Flere gjester via Google.' };
  };
  const filled = await offerAi.fillOfferFromTranscript({
    client: CLIENT,
    meeting: { title: 'Møte', transcript: 'Kunde: vi vil ha ny nettside for kafeen.', summary: 'Ny nettside.' },
    products: offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id),
    tierId: tiers.WEBSITE_TIERS[1].id,
    deps: { chat },
  });
  assert.equal(filled.need, 'ny nettside for kafeen');
  assert.ok(Array.isArray(filled.project) && filled.project.length === 1);
  const fillCall = seen[0];
  assert.match(fillCall.system, /på tvers av feltene/i);
  assert.match(fillCall.system, /ikke gjenta/i);
  assert.match(fillCall.system, /Kall mottakeren "kunden"/i);
  assert.doesNotMatch(fillCall.system, /Kunden vil at …/);
  assert.doesNotMatch(fillCall.system, /Vi kommer til å fokusere på/);
  assert.match(fillCall.user, /Takk for samtalen om \{\{need\}\}/);
  assert.match(fillCall.system, /transkriptet og produktnotatene veier likt/i);
  assert.match(fillCall.system, /Kall mottakeren "kunden"/i);
  assert.doesNotMatch(fillCall.system, /Kunden vil at …/);
  const letter = offerEmail.offerLetterAlreadyWritten();
  assert.match(letter, /\{\{terms\}\}[\s\S]*Hva er inkludert[\s\S]*\{\{benefits\}\}[\s\S]*Hva som skjer fremover[\s\S]*signert kontrakten som er vedlagt/);
  assert.doesNotMatch(letter, /eget CMS/);
  assert.match(fillCall.system, /allerede står/i);
  assert.doesNotMatch(fillCall.system, /Aldri start med/i);
  assert.doesNotMatch(fillCall.system, /I samtalen la dere/i);
  assert.doesNotMatch(fillCall.user, /SEO optimization/i);
  assert.doesNotMatch(fillCall.user, /opp til 7 sider/i);
  assert.doesNotMatch(fillCall.system, /enkelt CMS/i);

  const products = offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id);
  const summary = await offerAi.reflectContractFromEmail({ emailHtml: '<p>Tilbud</p>', products, deps: { chat } });
  assert.equal(summary.products.length, 1);
  assert.equal(summary.deliveryWeeks, 4);
  assert.ok(summary.monthlyExMva > 0);
  assert.equal(seen.length, 2);
});

test('sales offers store: draft → review → verify → send lifecycle with locks', () => {
  const created = store.createSalesOffer({
    salesClientId: CLIENT.id,
    ownerId: CLIENT.ownerId,
    email: { subject: 'Tilbud', preheader: '', html: '<p>hei</p>' },
    tierId: 'custom',
    products: [{ id: 'c1', kind: 'custom', name: 'Skreddersydd', priceExMva: 3000, pages: 8, includes: ['A'], note: '', deliveryWeeks: 5 }],
  }, { actor: 'anna' });
  assert.equal(created.status, 'draft');
  assert.equal(store.offerNeedsVerification(created), true, 'custom tier must go through admin');
  assert.equal(store.offerCanBeSentBySales(created), false);

  const reviewed = store.requestOfferReview(created.id, { actor: 'anna' });
  assert.equal(reviewed.status, 'review-requested');
  assert.equal(store.getOfferForClient(CLIENT.id)?.id, created.id);
  assert.equal(store.countOffersByStatus()['review-requested'], 1);

  const verified = store.verifySalesOffer(created.id, { actor: 'damian', adminNote: 'Send som avtalt' });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.adminNote, 'Send som avtalt');
  assert.equal(store.offerCanBeSentBySales(verified), true);
  assert.equal(store.offerContentIsLocked(verified), true);
  const attempted = store.upsertClientOfferDraft(CLIENT.id, { email: { html: '<p>hack</p>' } });
  assert.equal(attempted.email.html, '<p>hei</p>', 'verified offers stay frozen for the sales upsert');

  const reopened = store.reopenSalesOffer(created.id, { actor: 'damian' });
  assert.equal(reopened.status, 'review-requested', 'default reopen keeps it in the admin queue');
  assert.equal(reopened.verifiedAt, '');
  const returned = store.reopenSalesOffer(created.id, { actor: 'damian', toDraft: true });
  assert.equal(returned.status, 'draft');
  store.verifySalesOffer(created.id, { actor: 'damian' });

  const sent = store.markSalesOfferSent(created.id, { actor: 'anna', to: CLIENT.contactEmail });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentTo, CLIENT.contactEmail);
  assert.ok(sent.history.some((entry) => entry.action === 'sent'));

  // A standard tier without review flag can be sent directly
  const standard = store.createSalesOffer({ salesClientId: 'client-9', ownerId: 'x', tierId: tiers.WEBSITE_TIERS[0].id, products: offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id) });
  assert.equal(store.offerNeedsVerification(standard), false);
  assert.equal(store.offerCanBeSentBySales(standard), true);
  const flagged = store.updateSalesOffer(standard.id, { reviewRequested: true });
  assert.equal(store.offerNeedsVerification(flagged), true);
});

test('offer email: "inkluder mva" treats the listed price as the all-in monthly price', () => {
  const products = offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id);
  const listed = tiers.WEBSITE_TIERS[0].monthlyExMva;

  const onTop = offerEmail.offerTotals(products);
  assert.equal(onTop.mvaIncluded, false);
  assert.equal(onTop.exMva, listed);
  assert.equal(onTop.inclMva, Math.round(listed * 1.25));

  const absorbed = offerEmail.offerTotals(products, { mvaIncluded: true });
  assert.equal(absorbed.mvaIncluded, true);
  assert.equal(absorbed.inclMva, listed, 'client pays the listed price');
  assert.equal(absorbed.exMva, Math.round(listed / 1.25));
  assert.equal(absorbed.exMva + absorbed.mva, absorbed.inclMva);

  const html = offerEmail.buildOfferEmail({ client: CLIENT, products, mvaIncluded: true, mergeTags: false }).html;
  assert.match(html, /data-mva-included="1"/);
  assert.match(html, /Pris inkl\. mva:/);
  assert.match(html, new RegExp(`Pris: ${tiers.formatKr(listed).replace(/\\s/g, '\\s')} inkl\\. mva per måned`.replace(/ /g, '[\\s\\u00a0]')));
  assert.match(html, /Herav MVA \(25 %\)/);

  // Flipping the toggle re-renders the block in place (no duplicate product blocks).
  const back = offerEmail.applyOfferProducts(html, products, { mvaIncluded: false });
  assert.match(back, /data-mva-included="0"/);
  assert.match(back, /Pris eks\. mva:/);
  assert.equal((back.match(/data-offer-product="1"/g) || []).length, 1);

  assert.match(offerEmail.summarizeOfferProducts(products, { mvaIncluded: true }), /mva er inkludert i oppgitt pris/);
});

test('offer email: shell has no envelope icon and a left-aligned heading; old drafts are refreshed', async () => {
  const layoutMod = await import('../lib/sales-email.js');
  const email = offerEmail.buildOfferEmail({ client: CLIENT, products: [], mergeTags: true, layout: layoutMod.buildSalesLayoutEmail, layoutOptions: { embed: false, assetBase: '/email/sales' } });
  assert.doesNotMatch(email.html, /<img\b[^>]*width="160"/, 'no envelope illustration');
  assert.match(email.html, /text-align:left;[^>]*>\s*<h1[^>]*>Tilbud fra Asoldi<\/h1>/, 'heading is left-aligned');

  const legacy = '<td style="padding:28px 20px 0;text-align:center;">\n<h1 style="margin:0;">Tilbud fra Asoldi</h1>\n<img src="/email/sales/envelope.png" width="160" alt="" style="display:block;" />\n</td>';
  const refreshed = offerEmail.refreshOfferShell(legacy);
  assert.doesNotMatch(refreshed, /<img/);
  assert.match(refreshed, /text-align:left;/);
  assert.equal(offerEmail.refreshOfferShell(refreshed), refreshed, 'idempotent');
});

test('offer email: template placeholders are detectable until filled or deleted', () => {
  const email = offerEmail.buildOfferEmail({ client: CLIENT, products: [], mergeTags: true });
  const found = offerEmail.findOfferPlaceholders(email.html);
  assert.ok(found.length >= 4, `expected template placeholders, got ${found.length}`);
  assert.ok(found.some((label) => /Velg nettside tier/.test(label)));

  const withTier = offerEmail.applyOfferProducts(email.html, offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id));
  assert.ok(!offerEmail.findOfferPlaceholders(withTier).some((label) => /Velg nettside tier/.test(label)), 'tier placeholder gone');

  const filled = offerEmail.fillOfferSlots(withTier, {
    need: 'ny nettside',
    project: ['Avsnitt 1', 'Avsnitt 2', 'Avsnitt 3'],
    terms: 'Logo og bilder fra dere.',
    benefits: 'Flere kunder.',
  });
  assert.deepEqual(offerEmail.findOfferPlaceholders(filled), []);

  // Legacy markup without the data attribute (drafts made before this change) is still detected.
  const legacy = '<span style="background:#fff3ea;color:#b34300;">[Avsnitt 2]</span>';
  assert.deepEqual(offerEmail.findOfferPlaceholders(legacy), ['Avsnitt 2']);
});

test('sales offers store: preview approval is tied to the exact content and mva mode', () => {
  const offer = store.createSalesOffer({
    salesClientId: 'client-preview',
    ownerId: 'x',
    tierId: tiers.WEBSITE_TIERS[0].id,
    products: offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id),
    email: { subject: 'Tilbud', preheader: '', html: '<p>hei</p>' },
  });
  assert.equal(offer.mvaIncluded, false);
  assert.equal(store.offerPreviewIsCurrent(offer), false, 'never previewed');

  const previewed = store.markOfferPreviewed(offer.id, { actor: 'anna' });
  assert.equal(store.offerPreviewIsCurrent(previewed), true);
  const olderApproval = {
    ...previewed,
    previewHash: store.offerContentHash(previewed, { includeParty: false }),
  };
  assert.equal(store.offerPreviewIsCurrent(olderApproval), true, 'approval from before party was hashed still counts');
  assert.ok(previewed.previewedAt);
  assert.ok(previewed.history.some((entry) => entry.action === 'previewed'));

  const edited = store.updateSalesOffer(offer.id, { email: { html: '<p>hei igjen</p>' } });
  assert.equal(store.offerPreviewIsCurrent(edited), false, 'content edit invalidates the approval');

  store.markOfferPreviewed(offer.id, { actor: 'anna' });
  const mvaFlipped = store.updateSalesOffer(offer.id, { mvaIncluded: true });
  assert.equal(mvaFlipped.mvaIncluded, true);
  assert.equal(store.offerPreviewIsCurrent(mvaFlipped), false, 'mva mode change invalidates the approval');
});

test('contract pdf: mva-included offers state the incl. VAT price as the quoted amount', async () => {
  const inputs = contractPdf.contractInputsForOffer({ tierId: tiers.WEBSITE_TIERS[0].id, products: [], mvaIncluded: true, contract: { summary: null } });
  assert.equal(inputs.mvaIncluded, true);
  const buffer = await contractPdf.buildContractPdf({ client: CLIENT, ...inputs });
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  const exVat = JSON.stringify(contractPdf.contractArticleModel({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[0].id, mvaIncluded: false }));
  const inclVat = JSON.stringify(contractPdf.contractArticleModel({ client: CLIENT, tierId: tiers.WEBSITE_TIERS[0].id, mvaIncluded: true }));
  assert.match(exVat, /Monthly price: 999 kr excl\. VAT/);
  assert.match(inclVat, /Monthly price: 999 kr incl\. VAT/);
  assert.doesNotMatch(exVat, /Monthly price: 999 kr incl\. VAT/);
  assert.notEqual(exVat, inclVat);
  const products = offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id);
  const emailEx = offerEmail.buildOfferEmail({ client: CLIENT, products, mvaIncluded: false, mergeTags: false }).html;
  const emailIncl = offerEmail.buildOfferEmail({ client: CLIENT, products, mvaIncluded: true, mergeTags: false }).html;
  assert.match(emailEx, /data-mva-included="0"/);
  assert.match(emailIncl, /data-mva-included="1"/);
  assert.match(emailIncl, /mva er inkludert|inkl\. mva/i);
});

test('users store + sender: phone is normalized, formatted and flows into {{signerPhone}}', async () => {
  const users = await import('../data/store.js');
  const senderMod = await import('../lib/sales-sender.js');
  const salesEmail = await import('../lib/sales-email.js');

  assert.equal(users.normalizePhone('+47 92331098'), '+4792331098');
  assert.equal(users.normalizePhone('923 31 098'), '+4792331098');
  assert.equal(users.normalizePhone('004792331098'), '+4792331098');
  assert.equal(users.normalizePhone('abc'), '');
  assert.equal(users.normalizePhone(''), '');

  assert.equal(senderMod.formatPhoneNumber('+4792331098'), '+47 923 31 098');
  assert.equal(senderMod.formatPhoneNumber('73 51 00 00'), '+47 73 51 00 00');

  const sender = senderMod.buildSalesSender({ name: 'Alexander', username: 'alexander@asoldi.com', phone: '+4792331098' });
  assert.equal(sender.phone, '+47 923 31 098');
  assert.equal(sender.fromEmail, 'alexander@asoldi.com');
  const merge = salesEmail.salesEmailMergeMap(CLIENT, {}, sender);
  assert.equal(merge.signerPhone, '+47 923 31 098');
  assert.equal(merge.signerEmail, 'alexander@asoldi.com');
  // No number on the profile → office fallback, never an empty signature.
  assert.match(salesEmail.salesEmailMergeMap(CLIENT, {}, senderMod.buildSalesSender({ name: 'Ola', username: 'ola@asoldi.com' })).signerPhone, /^\+47 /);

  // Users created without a phone can get one later; alexander@asoldi.com is seeded on first read.
  const created = await users.createUser('alexander@asoldi.com', 'secret-pass', 'sales', { name: 'Alexander' });
  assert.equal(created.ok, true);
  const seeded = await users.getUserByUsername('alexander@asoldi.com');
  assert.equal(seeded.phone, '+4792331098', 'seeded number is written to users.json');
  const updated = await users.updateUserProfile(created.user.id, { phone: '+47 999 88 777' });
  assert.equal(updated.user.phone, '+4799988777', 'admin edit wins over the seed');
  assert.equal((await users.getUserByUsername('alexander@asoldi.com')).phone, '+4799988777', 'seed does not overwrite an existing number');

  const damian = await users.createUser('damian@asoldi.com', 'secret-pass-2', 'sales', { name: 'Damian', phone: '+47 400 00 001' });
  assert.equal(damian.ok, true);
  await users.updateAdminSender({ name: 'Damian', fromEmail: 'damian@asoldi.com' });
  assert.equal(
    users.linkedSenderProfile({ role: 'admin', username: 'admin' }).phone,
    '+4740000001',
    'admin offer sender uses the Users-row number for the same inbox',
  );
  await users.updateAdminSender({ phone: '+47 400 00 002' });
  assert.equal((await users.getUserByUsername('damian@asoldi.com')).phone, '+4740000002');
  assert.equal((await users.getAdminSender()).phone, '+4740000002');
  await users.updateUserProfile(damian.user.id, { phone: '+47 400 00 003' });
  assert.equal((await users.getAdminSender()).phone, '+4740000003', 'saving the Users row copies the number onto admin');
});

test('meeting quote sets tier pages, one-time host, and workshop date on the offer', () => {
  const starter = quoteOffer.buildOfferFromMeetingQuote({
    tierId: 'starter',
    pages: 5,
    selected: ['hosting', 'contact', 'changes', 'blog'],
    oneTimeAddOns: [],
  });
  assert.equal(starter.tierId, 'tier-1-standard');
  assert.equal(starter.billing, 'month');
  assert.equal(starter.products[0].pages, 5);
  assert.equal(starter.products[0].priceExMva, 999);

  const extraPage = quoteOffer.buildOfferFromMeetingQuote({
    tierId: 'starter',
    pages: 6,
    selected: ['hosting', 'contact', 'changes', 'blog'],
    oneTimeAddOns: [],
  });
  assert.ok(extraPage.products[0].priceExMva > 999);
  assert.match(extraPage.products[0].includes.join(' '), /1 ekstra side utover 5 inkludert/);

  const seo = quoteOffer.buildOfferFromMeetingQuote({
    tierId: 'seo',
    pages: 7,
    selected: ['hosting', 'seo', 'blog'],
    oneTimeAddOns: [],
  });
  assert.equal(seo.products[0].pages, 7);
  assert.equal(seo.products[0].priceExMva, 1499);

  const shop = quoteOffer.buildOfferFromMeetingQuote({
    tierId: 'nettbutikk',
    pages: 10,
    selected: [],
    oneTimeAddOns: [],
  });
  assert.equal(shop.products[0].priceExMva, 1999);

  const hosted = quoteOffer.buildOfferFromMeetingQuote({
    tierId: 'starter',
    pages: 5,
    selected: ['hosting'],
    oneTimeAddOns: ['thirdpartyhost'],
  });
  assert.equal(hosted.billing, 'once');
  assert.equal(hosted.products[0].priceExMva, 999 * 9 + 2500);
  assert.match(hosted.products[0].includes.join(' '), /tredjeparts host/i);

  assert.equal(offerEmail.workshopStartSentence(''), 'Startdato for workshop: Vi avtaler startdato for workshop senere.');
  assert.match(offerEmail.workshopStartSentence('2026-10-15'), /15\. oktober 2026/);
  const html = offerEmail.ensureWorkshopSentence('<h2>Hva som skjer fremover</h2>', offerEmail.workshopStartSentence('2026-10-15'));
  assert.match(html, /data-offer-slot="workshop"/);
  assert.match(html, /15\. oktober 2026/);
});

test('offer send can target email, asoldi.com, or both', () => {
  assert.deepEqual(store.normalizeOfferChannels({}), ['email']);
  assert.deepEqual(store.normalizeOfferChannels({ delivery: 'portal' }), ['portal']);
  assert.deepEqual(store.normalizeOfferChannels({ delivery: 'both' }), ['email', 'portal']);
  assert.deepEqual(store.normalizeOfferChannels({ channels: ['portal', 'email', 'email'] }), ['portal', 'email']);
  const offer = store.createSalesOffer({
    salesClientId: 'client-both',
    email: { subject: 'Hei', html: '<p>Hei</p>' },
  });
  const sent = store.markSalesOfferSent(offer.id, { to: 'kari@byneset-kafe.no', delivery: 'both' });
  assert.equal(sent.delivery, 'both');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentTo, 'kari@byneset-kafe.no');
  assert.equal(sent.sentContent, '');

  const duringMeeting = store.createSalesOffer({
    salesClientId: 'client-live',
    email: { subject: 'Hei', html: '<p><span data-offer-placeholder="1">[behov]</span></p>' },
  });
  const contractSent = store.markSalesOfferSent(duringMeeting.id, {
    to: 'kari@byneset-kafe.no',
    delivery: 'email',
    sentContent: 'contract',
  });
  assert.equal(contractSent.sentContent, 'contract');
  assert.match(contractSent.history.at(-1).note, /email:contract:/);
});

test('in-meeting contract mail skips the transcript letter', () => {
  assert.equal(offerEmail.offerSendContentMode('contract'), 'contract');
  assert.equal(offerEmail.offerSendContentMode(''), 'full');
  assert.equal(offerEmail.offerSendContentMode('full'), 'full');
  const email = offerEmail.buildContractOnlyBodyHtml({ attached: true });
  const portal = offerEmail.buildContractOnlyBodyHtml({ attached: false });
  assert.equal(offerEmail.findOfferPlaceholders(email).length, 0);
  assert.doesNotMatch(email, /data-offer-slot|data-offer-placeholder|\{\{need\}\}/);
  assert.match(email, /kontrakten vedlagt/i);
  assert.match(email, /asoldi\.com under Tilbud/);
  assert.match(portal, /avtalen under/i);
  assert.doesNotMatch(portal, /vedlagt/);
  const built = offerEmail.buildContractOnlyEmail({ client: CLIENT, attached: true });
  assert.match(built.subject, /Kontrakt til \{\{businessName\}\}/);
  assert.match(built.html, /Hei \{\{firstName\}\}/);
});

test('portal letter strips email chrome and keeps greeting plus product specs', async () => {
  const { extractOfferLetterBody } = await import('../lib/offer-letter-html.js');
  const { renderBrandedSalesEmailHtml } = await import('../lib/sales-email-layout.js');
  const branded = `
    <table class="email-bg">
      <tr><td class="email-hero"><img src="hero.jpg" alt="hero"></td></tr>
      <tr><td class="pad-title"><h1>Tilbud fra Asoldi</h1></td></tr>
      <tr>
        <td class="pad-body">
          <p>Hei Kari,</p>
          <p data-offer-slot="intro">Takk for samtalen om nettsiden.</p>
          <h2>Hva er inkludert</h2>
          <div id="offer-products">
            <table data-offer-product="1"><tr><td>Pakke 2<br>Opp til 7 sider</td></tr></table>
            <div id="offer-products-end"></div>
          </div>
          <p>Med vennlig hilsen<br/><strong>Anna fra Asoldi</strong></p>
        </td>
      </tr>
      <tr><td class="email-footer">© 2026 Alle rettigheter reservert</td></tr>
    </table>`;
  const letter = extractOfferLetterBody(branded);
  assert.match(letter, /Hei Kari/);
  assert.match(letter, /Takk for samtalen/);
  assert.match(letter, /Opp til 7 sider/);
  assert.match(letter, /id="offer-products"/);
  assert.doesNotMatch(letter, /email-hero|email-footer|hero\.jpg|Tilbud fra Asoldi/);
  assert.equal(extractOfferLetterBody(letter), letter);

  const products = offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id);
  const email = offerEmail.buildOfferEmail({
    client: CLIENT,
    products,
    mergeTags: false,
    layout: (_client, view) => ({ html: renderBrandedSalesEmailHtml(view) }),
  });
  const fromShell = extractOfferLetterBody(email.html);
  assert.match(fromShell, /Hei/);
  assert.match(fromShell, /Opp til 7 sider/);
  assert.match(fromShell, /id="offer-products"/);
  assert.doesNotMatch(fromShell, /email-hero|email-footer|Tilbud fra Asoldi/);
});

test('portal contract html uses a document header, party columns, and numbered sections', async () => {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
  const html = contractHtmlForOffer(
    { tierId: tiers.WEBSITE_TIERS[0].id, sentAt: '2026-09-28T08:00:00.000Z' },
    CLIENT,
  );
  assert.match(html, /offer-contract-masthead/);
  assert.match(html, /<h1>Service agreement<\/h1>/);
  assert.match(html, /leaves the Asoldi hosting network/);
  assert.match(html, /Domain access/);
  assert.doesNotMatch(html, /Google Business Profile development/);
  assert.match(html, /offer-contract-parties/);
  assert.match(html, /Byneset Bydelskafé/);
  assert.match(html, /1\. Service scope/);
  assert.match(html, /offer-contract-sign/);
  assert.match(html, /asoldi-contract-signature\.png/);
  assert.match(html, /offer-contract-stamp/);
  assert.match(html, /Jeg aksepterer avtalen/);
  const stamp = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'asoldi-contract-signature.png');
  assert.equal(existsSync(stamp), true, 'portal signature PNG is served from public/');
});

test('meeting quote describes the selected plan for admin review', () => {
  const described = quoteOffer.describeMeetingQuote({
    tierId: 'seo',
    pages: 7,
    selected: ['seo', 'blog'],
    oneTimeAddOns: ['pos'],
    productNotes: 'De vil ha meny og bordbooking.',
    productGoal: 'Flere bookinger fra Google.',
  });
  assert.match(described.plan, /SEO/i);
  assert.match(described.plan, /Koble opp til kassasystem/);
  assert.equal(described.notes, 'De vil ha meny og bordbooking.');
  assert.equal(described.goal, 'Flere bookinger fra Google.');
});

test('client intent briefing uses transcript, notes and the selected plan', async () => {
  const chat = async () => ({
    headline: 'Kunden vil ha meny, booking og SEO.',
    wants: ['Meny på nettsiden', 'Bordbooking'],
    uncertainties: ['Språk er ikke avklart'],
  });
  const briefing = await offerAi.summarizeClientIntent({
    client: CLIENT,
    meeting: { title: 'Møte', transcript: 'Vi trenger meny og booking på nettsiden.', summary: 'Meny og booking.' },
    quote: { tierId: 'seo', pages: 7, selected: ['seo'], productNotes: 'Booking er viktigst.' },
    products: offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[1].id),
    notes: 'Booking er viktigst.',
    deps: { chat },
  });
  assert.equal(briefing.source, 'ai');
  assert.match(briefing.headline, /meny/i);
  assert.ok(briefing.wants.includes('Bordbooking'));
  assert.ok(briefing.plan);
  const fallback = await offerAi.summarizeClientIntent({
    client: CLIENT,
    quote: { tierId: 'starter', pages: 5, productGoal: 'En enkel nettside.' },
    notes: '',
    deps: { chat: async () => { throw new Error('offline'); } },
  });
  assert.equal(fallback.source, 'fallback');
  assert.match(fallback.headline, /enkel nettside/i);
  const hashA = offerAi.clientIntentSourceHash({ notes: 'a', products: [] });
  const hashB = offerAi.clientIntentSourceHash({ notes: 'b', products: [] });
  assert.notEqual(hashA, hashB);
});

test('offer AI concatenates selected meetings and hashes all of them', () => {
  const first = { meetingId: 'a', title: 'Salgsmøte', when: '1. okt', transcript: 'Vi trenger meny og booking.' };
  const second = { meetingId: 'b', title: 'Planlegging', when: '6. okt', transcript: 'Neste gang går vi gjennom tilbudet.' };
  const described = offerAi.describeMeetings([first, second]);
  assert.match(described, /Møte 1 · Salgsmøte/);
  assert.match(described, /Møte 2 · Planlegging/);
  assert.match(described, /meny/);
  assert.match(described, /tilbudet/);
  const both = offerAi.clientIntentSourceHash({ meetings: [first, second], notes: 'x', products: [] });
  const one = offerAi.clientIntentSourceHash({ meetings: [first], notes: 'x', products: [] });
  assert.notEqual(both, one);
});

const STARTER_QUOTE = {
  tierId: 'starter',
  pages: 5,
  selected: ['hosting', 'contact', 'changes', 'blog'],
  oneTimeAddOns: [],
};

const SEO_QUOTE = {
  tierId: 'seo',
  pages: 7,
  customMode: false,
  oneTime: false,
  selected: ['hosting', 'seo', 'blog'],
  oneTimeAddOns: [],
};

test('dual meeting quote builds two alternatives without summing products', () => {
  const dual = quoteOffer.buildOfferFromMeetingQuote({
    ...STARTER_QUOTE,
    altQuote: SEO_QUOTE,
  });
  assert.equal(dual.alternatives.length, 2);
  assert.equal(dual.products.length, 1, 'products stay Tilbud 1, not both packages');
  assert.equal(dual.tierId, dual.alternatives[0].tierId);
  assert.equal(dual.products[0].priceExMva, 999);
  assert.equal(dual.alternatives[1].products[0].priceExMva, 1499);
  const productTotal = dual.products.reduce((sum, item) => sum + item.priceExMva, 0);
  assert.ok(productTotal < 999 + 1499, 'composer products must not be a summed total');
  assert.equal(quoteOffer.quoteBuiltIsCustom(dual), false);

  const customAlt = quoteOffer.buildOfferFromMeetingQuote({
    ...STARTER_QUOTE,
    altQuote: { ...SEO_QUOTE, customMode: true, tierId: 'custom' },
  });
  assert.equal(quoteOffer.quoteBuiltIsCustom(customAlt), true);
  const saved = store.createSalesOffer({
    salesClientId: 'client-dual-custom',
    ownerId: 'x',
    ...customAlt,
    reviewRequested: false,
  });
  assert.equal(store.offerNeedsVerification(saved), true, 'custom on either package needs admin review');
});

test('dual offer email uses Tilbud 1/2 headings, eller, and two Totalt/Leveringstid blocks', () => {
  const single = quoteOffer.buildOfferFromMeetingQuote(STARTER_QUOTE);
  const dual = quoteOffer.buildOfferFromMeetingQuote({ ...STARTER_QUOTE, altQuote: SEO_QUOTE });
  const singleHtml = offerEmail.buildOfferBodyHtml({
    products: single.products,
    alternatives: single.alternatives,
    tierId: single.tierId,
  });
  assert.match(singleHtml, /<h2[^>]*>Hva er inkludert<\/h2>/);
  assert.doesNotMatch(singleHtml, /Tilbud 1 – Hva er inkludert/);
  assert.doesNotMatch(singleHtml, /data-offer-or/);
  assert.equal((singleHtml.match(/Totalt:/g) || []).length, 1);
  assert.equal((singleHtml.match(/Leveringstid:/g) || []).length, 1);
  assert.match(singleHtml, /14 arbeidsdager fra signert kontrakt/);
  assert.doesNotMatch(singleHtml, /Leveringsdato:/);
  assert.doesNotMatch(singleHtml, /uker fra oppstart/);
  assert.equal((singleHtml.match(/Hva som skjer fremover/g) || []).length, 1);

  const html = offerEmail.buildOfferBodyHtml({
    products: dual.products,
    alternatives: dual.alternatives,
    tierId: dual.tierId,
  });
  assert.match(html, /Tilbud 1 – Hva er inkludert/);
  assert.match(html, /data-offer-or="1"/);
  assert.match(html, />eller</);
  assert.match(html, /Tilbud 2 – Hva er inkludert/);
  assert.equal((html.match(/Totalt:/g) || []).length, 2);
  assert.equal((html.match(/Leveringstid:/g) || []).length, 2);
  assert.doesNotMatch(html, /Leveringsdato:/);
  assert.doesNotMatch(html.split(/id="offer-products"/)[0], /<h2[^>]*>Hva er inkludert<\/h2>/);
  assert.equal((html.match(/Hva som skjer fremover/g) || []).length, 1);
  assert.equal((html.match(/data-offer-slot="benefits"/g) || []).length, 1);

  const fromSingle = offerEmail.applyOfferProducts(singleHtml, dual.products, {
    alternatives: dual.alternatives,
    tierId: dual.tierId,
  });
  assert.match(fromSingle, /Tilbud 1 – Hva er inkludert/);
  assert.match(fromSingle, /Tilbud 2 – Hva er inkludert/);
  const back = offerEmail.applyOfferProducts(fromSingle, single.products, {
    alternatives: single.alternatives,
    tierId: single.tierId,
  });
  assert.match(back, /<h2[^>]*>Hva er inkludert<\/h2>/);
  assert.doesNotMatch(back, /Tilbud 1 – Hva er inkludert/);
});

test('offer email keeps one Leveringstid line and drops leftover Leveringsdato / 2 uker', () => {
  const leftover = [
    '<p style="margin:0 0 14px;"><strong>Leveringsdato:</strong> <span data-offer-slot="delivery">14 arbeidsdager fra signert kontrakt</span></p>',
    '<p>Leveringsdato: 2 uker fra oppstart</p>',
    '<div id="offer-products"></div><div id="offer-products-end"></div>',
  ].join('');
  const refreshed = offerEmail.refreshOfferShell(leftover);
  assert.equal((refreshed.match(/Leveringstid:/g) || []).length, 1);
  assert.doesNotMatch(refreshed, /Leveringsdato:/);
  assert.doesNotMatch(refreshed, /2 uker fra oppstart/);
  assert.match(refreshed, /14 arbeidsdager fra signert kontrakt/);

  const applied = offerEmail.applyOfferProducts(
    leftover,
    offerEmail.productsWithTier([], tiers.WEBSITE_TIERS[0].id),
    { tierId: tiers.WEBSITE_TIERS[0].id },
  );
  assert.equal((applied.match(/Leveringstid:/g) || []).length, 1);
  assert.doesNotMatch(applied, /Leveringsdato:/);
  assert.doesNotMatch(applied, /uker fra oppstart/);
  assert.match(applied, /14 arbeidsdager fra signert kontrakt/);
});

test('dual PDF and portal HTML list both scopes and Tilbud 1/2 checkboxes', async () => {
  const dual = quoteOffer.buildOfferFromMeetingQuote({ ...STARTER_QUOTE, altQuote: SEO_QUOTE });
  const { contractHtmlForOffer } = await import('../lib/offer-contract-html.js');
  const html = contractHtmlForOffer(
    { tierId: dual.tierId, alternatives: dual.alternatives, sentAt: '2026-09-28T08:00:00.000Z' },
    CLIENT,
  );
  assert.match(html, /alternative service scopes/);
  assert.match(html, /<strong>Tilbud 1<\/strong>/);
  assert.match(html, /<strong>Tilbud 2<\/strong>/);
  assert.match(html, /Chosen scope:<\/strong> Tilbud 1 or Tilbud 2/);
  assert.doesNotMatch(html, /The Client has selected the following service tier/);
  assert.match(html, /14 working days from the signed contract/);
  assert.doesNotMatch(html, /\b14 days from\b/);

  const article = contractPdf.contractArticleModel({
    client: CLIENT,
    tierId: dual.tierId,
    alternatives: dual.alternatives,
  });
  assert.equal(article.alternativeScopes.length, 2);
  assert.equal(article.chosenOfferIndex, null);

  const inputs = contractPdf.contractInputsForOffer({
    tierId: dual.tierId,
    products: dual.products,
    alternatives: dual.alternatives,
    contract: { summary: null },
  });
  assert.equal(inputs.alternatives.length, 2);
  assert.equal(contractPdf.offerContractIsAvailable({
    tierId: dual.tierId,
    products: dual.products,
    alternatives: dual.alternatives,
    contract: { summary: null },
  }), true);

  const buffer = await contractPdf.buildContractPdf({ client: CLIENT, ...inputs });
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy();
  const pdfText = parsed?.text || '';
  assert.match(pdfText, /Tilbud 1/);
  assert.match(pdfText, /Tilbud 2/);
  assert.doesNotMatch(pdfText, /Custom scope \(Section 1\)/);
});

test('dual portal accept requires an index and flattens tilbud 2 onto tierId', () => {
  const dual = quoteOffer.buildOfferFromMeetingQuote({ ...STARTER_QUOTE, altQuote: SEO_QUOTE });
  const offer = store.createSalesOffer({
    salesClientId: 'client-dual-accept',
    ownerId: 'x',
    ...dual,
  });
  assert.equal(store.offerHasDualAlternatives(offer), true);
  assert.equal(store.parseChosenOfferIndex(undefined, 2).ok, false);
  assert.equal(store.parseChosenOfferIndex(null, 2).ok, false);
  assert.equal(store.parseChosenOfferIndex(1, 1).ok, true);
  assert.equal(store.parseChosenOfferIndex(1, 1).index, null, 'single-offer accept does not require an index');
  const picked = store.parseChosenOfferIndex(1, 2);
  assert.equal(picked.ok, true);
  assert.equal(picked.index, 1);
  const flattened = store.flattenOfferToChosen(offer, 1);
  assert.equal(flattened.tierId, dual.alternatives[1].tierId);
  assert.equal(flattened.tierId, 'tier-2-seo');
  assert.equal(flattened.products[0].priceExMva, 1499);
  assert.equal(flattened.chosenOfferIndex, 1);
  assert.equal(offer.products[0].priceExMva, 999);
  const persisted = store.updateSalesOffer(offer.id, flattened, { actor: 'client', action: 'chosen-offer' });
  assert.equal(persisted.tierId, 'tier-2-seo');
  assert.equal(persisted.chosenOfferIndex, 1);
  assert.equal(persisted.products[0].priceExMva, 1499);
  assert.equal(store.offerHasDualAlternatives(persisted), true);
});

test('sending tilbud or kun kontrakt checks Møte and Tilbud without a page reload', async () => {
  const salesClients = await import('../data/sales.js');
  const row = salesClients.createSalesClient({
    id: 'client-offer-progress',
    businessName: 'Tilbud Test AS',
    ownerId: 'x',
    progression: { meetingHeld: false, offerSent: false, contractSigned: false },
  });
  assert.equal(row.progression.offerSent, false);
  const afterContract = salesClients.markOfferSentOnDelivery(row.id);
  assert.equal(afterContract.progression.meetingHeld, true);
  assert.equal(afterContract.progression.offerSent, true);
  const again = salesClients.markOfferSentOnDelivery(row.id);
  assert.equal(again.progression.offerSent, true);
});

