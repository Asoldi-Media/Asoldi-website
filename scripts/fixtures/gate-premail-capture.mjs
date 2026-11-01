// Captures the pre-workshop and Datainnsamling mails a hub code tree sends or builds, for the
// delivery gate's byte-identity check against an earlier commit.
//
//   node scripts/fixtures/gate-premail-capture.mjs --code-root <tree>
//
// Run it in a child process with APP_DATA_DIR set to a fresh folder (and an optional
// automation-settings.json in it). The mail transport is a stand-in: fetch is replaced before any
// hub module loads, so a send to the mail API is recorded and answered locally; nothing leaves the
// process. Prints one JSON line: { sends: [...], built: {...} }.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const at = process.argv.indexOf('--code-root');
const codeRoot = resolve(at === -1 ? '.' : process.argv[at + 1]);
const load = (path) => import(pathToFileURL(join(codeRoot, path)).href);

const sends = [];
const network = [];
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target === 'https://api.resend.com/emails') {
    const body = JSON.parse(String(init.body || '{}'));
    if (body.headers) delete body.headers['X-Entity-Ref-ID'];
    sends.push(body);
    return new Response(JSON.stringify({ id: `stand-in-${sends.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  network.push(target);
  throw new Error('no network in the capture');
};

const SENDER = { name: 'Rep', fullName: 'Rep Person', fromEmail: 'rep@asoldi.com', from: 'Rep fra Asoldi <rep@asoldi.com>', replyTo: 'rep@asoldi.com', phone: '' };
const LEGACY_LINES = [
  { id: 'logo', title: 'Logo', detail: 'Høy oppløsning' },
  { id: 'hero', title: 'Hovedbilde', detail: '' },
];

const sales = await load('data/sales.js');
const prep = await load('lib/workshop-prep-send.js');
const mail = await load('lib/sales-email.js');
const templates = await load('lib/email-templates-store.js');

const deps = { fetchMakerRun: async () => ({ failed: true }), listMail: async () => ({ messages: [] }) };
const base = {
  businessName: 'Example Bakery AS',
  contactPerson: 'Kari Example',
  contactEmail: 'kari@example.com',
  product: 'asoldi',
  progression: { contractSigned: true },
};

const results = {};
const noTime = sales.createSalesClient({ ...base, id: 'capture-no-time' });
const first = await prep.sendPreWorkshopAfterContractSigned(noTime, { sender: SENDER, previousSigned: false, ...deps });
results.noTime = { sent: first.sent, reason: first.reason || '', warning: first.warning || '', needLines: first.needLines || [] };

const timed = sales.createSalesClient({
  ...base,
  id: 'capture-timed',
  workshopAction: { name: 'Workshop', format: 'sms-ring', dueAt: '2026-11-20T09:00:00.000Z', status: 'confirmed', confirmationSentAt: '2026-11-01T09:00:00.000Z' },
});
const second = await prep.sendPreWorkshopAfterContractSigned(timed, { sender: {}, previousSigned: false, ...deps });
results.timed = { sent: second.sent, reason: second.reason || '', warning: second.warning || '' };

const view = { ...base, id: 'capture-view' };
const pick = (built) => ({ subject: built.subject, text: built.text, html: built.html, from: built.from, replyTo: built.replyTo });
const built = {
  data1: pick(mail.buildDataInnsamlingEmail(view, {}, 1, { sender: SENDER, needLines: LEGACY_LINES })),
  data2Empty: pick(mail.buildDataInnsamlingEmail(view, {}, 2, { sender: {}, needLines: [] })),
  preNoTime: pick(mail.buildPreWorkshopEmail(view, {}, { sender: SENDER, hasTime: false, needLines: LEGACY_LINES })),
  preTimed: pick(mail.buildPreWorkshopEmail(view, {}, { sender: {}, hasTime: true, needLines: LEGACY_LINES, workshop: { format: 'sms-ring', dueAt: '2026-11-20T09:00:00.000Z' } })),
};
const composed = templates.composeEmailForClient(view, 'data-innsamling-2', null, { sender: SENDER, needLines: LEGACY_LINES }).message;
built.composedData2 = { subject: composed.subject, html: composed.html, text: composed.text, from: composed.from, replyTo: composed.replyTo };
const thankYouStyle = templates.composeEmailForClient(view, 'post-workshop', null, { sender: SENDER }).message;
built.postWorkshopKeyWithoutLines = { subject: thankYouStyle.subject, from: thankYouStyle.from, replyTo: thankYouStyle.replyTo, ics: Boolean(thankYouStyle.icalEvent) };

console.log(JSON.stringify({ sends, results, built, network }));
