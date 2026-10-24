// WS8.28: Maker delivery events on the hub. Payload normalization (no URLs, counts and routes
// only), the recorder on the data layer, the materials snapshot in place of a live run fetch, and
// the switch wiring in the status callback (off by default: the old step-status path). The live run
// fetch comes first; the snapshot of the linked run stands in only when it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-maker-events-'));
process.env.APP_DATA_DIR = DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

writeFileSync(join(DATA_DIR, 'sales-clients.json'), JSON.stringify([
  { id: 'c1', product: 'asoldi', businessName: 'Events AS', status: 'active', progression: { meetingHeld: true, offerSent: true, contractSigned: true }, makerRun: { runId: 'run-1', latestReadyStep: '2' } },
  { id: 'lead1', product: 'asoldi', businessName: 'Lead Events AS', status: 'active', progression: { meetingHeld: true }, makerRun: { runId: 'run-lead', latestReadyStep: '1' } },
], null, 2));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const events = await import('../lib/maker-events.js');
const hubEvents = await import('../lib/maker-events-hub.js');
const sales = await import('../data/sales.js');
const settingsStore = await import('../data/automation-settings.js');
const { scoreClientMaterials } = await import('../lib/client-material-dots.js');
const { summarizeMakerRun } = await import('../lib/workshop-needs.js');

const PAYLOAD = {
  event: 'run.materials.updated',
  runId: 'run-1',
  salesClientId: 'c1',
  materials: {
    logo: { present: true, source: 'upload' },
    uploads: { heroImages: 3, aboutImages: ['a.jpg', 'b.jpg'], 'bad key!': 4 },
    uploadsTotal: 8,
    products: 6,
    productCatalogs: 1,
    domain: 'example-client.no',
    latestReadyStep: '2',
    customSiteEdits: 28,
    pageKinds: [
      { route: '/prosjekter', kind: 'portfolio' },
      { route: 'https://example-client.no/team', kind: 'team' },
      { route: '//cdn.example/x', kind: 'menu' },
      { route: '/meny', kind: 'Menu Page' },
    ],
    step1Qa: { status: 'warn', score: 0.8234 },
    siteIntelSummary: { pages: 5, preview: 'http://127.0.0.1:3000/runs/run-1', note: 'ok', 'https://k.example/x': 1, 'cdn.example.no/k': 2, host: 'cdn.example.no/uploads/logo.png' },
    needs: { schema: 'run-needs/1', items: [
      { id: 'hero-1', kind: 'media', status: 'missing', label: 'Forsidebilde', src: 'http://localhost:3000/x.png', file: '/api/runs/run-1/uploads/hero.jpg', alt: 'https:example.com' },
      { id: 'logo', kind: 'logo', status: 'have' },
      { id: 'contact.email', kind: 'fact', status: 'missing', label: 'E-post' },
    ] },
    at: '2026-11-01T10:00:00.000Z',
  },
};

test('materials: URLs are dropped everywhere; counts, routes, kinds and QA stay', () => {
  const materials = events.normalizeMakerMaterials(PAYLOAD.materials);
  assert.deepEqual(materials.uploads, { heroImages: 3, aboutImages: 2 });
  assert.equal(materials.uploadsTotal, 8);
  assert.equal(materials.domain, 'example-client.no');
  assert.deepEqual(materials.pageKinds, [{ route: '/prosjekter', kind: 'portfolio' }]);
  assert.deepEqual(materials.step1Qa, { status: 'warn', score: 0.823 });
  assert.deepEqual(materials.siteIntelSummary, { pages: 5, note: 'ok' }, 'URL values and URL-shaped keys are dropped');
  assert.deepEqual(materials.needs.items[0], { id: 'hero-1', kind: 'media', status: 'missing', label: 'Forsidebilde' });
  assert.equal(materials.needs.items[2].id, 'contact.email', 'a dotted id is not an address');
  assert.doesNotMatch(JSON.stringify(materials), /:\/\/|localhost|127\.0\.0\.1|cdn\.|\/api\/|https:/);
  assert.deepEqual(events.normalizeMakerMaterials(materials), materials, 'idempotent');
  assert.equal(events.normalizeMakerMaterials({ domain: 'https://example-client.no', products: 1 }).domain, '');
  assert.equal(events.normalizeMakerMaterials({}), null, 'an empty payload is not a snapshot');
  assert.equal(events.normalizeMakerMaterials({ logo: { present: false }, uploads: {}, domain: 'https://x.no', note: 'x' }), null, 'nor is one without any material field');
  assert.equal(events.makerRunPatchForEvent('run.materials.updated', { materials: {} }), null);
  assert.equal(events.makerRunPatchForEvent('run.materials.updated', { materials: { products: 2 } }, { runId: 'run-9', now: '2026-11-01T10:00:00.000Z' }).materials.runId, 'run-9', 'the checked run id is stored');
  const big = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`part${index}`, 'x'.repeat(200)]));
  assert.equal(events.normalizeMakerMaterials({ siteIntelSummary: big, products: 1 }).siteIntelSummary, null, 'over 2 KB is dropped');
  assert.equal(events.withoutUrls('y'.repeat(900)).length, 500, 'long strings are cut');
  for (const value of [
    'https://a.b', 'http://x', '//cdn.x', 'data:image/png;base64,xx', 'mailto:a@b.c', 'www.example.no', 'host.docker.internal:3000',
    'cdn.example.no/uploads/logo.png', 'example.com/path', 'example.com?x=1', 'host.example:3000', 'see cdn.example.no/x for it',
    '192.168.1.20:3000/api/runs/x', '10.0.0.5', '[::1]:3000', 'fe80::1', '::1', 'https:example.com', 'HTTPS:/example.com',
    'custom+scheme:/x', 'C:/x/logo.png', 'C:\\x\\logo.png', '\\\\server\\share', '/api/runs/run-1/uploads/logo.png',
    '/uploads/x', '/assets/logo.png', 'localhost',
  ]) {
    assert.equal(events.looksLikeUrl(value), true, value);
  }
  for (const value of [
    '/prosjekter', '/om-oss/team', '/meny.html', '/media', 'portfolio', 'Forsidebilde', '2', '0.823', '10:00:00', 'contact.email',
    'slot:hero-1', 'Tips: ta med logo', 'f.eks. logo', 'run-needs/1', 'example-client.no', 'needs-language', '2026-11-01T10:00:00.000Z',
  ]) {
    assert.equal(events.looksLikeUrl(value), false, value);
  }
  assert.deepEqual(events.withoutUrls({ 'https://k.example/x': 1, '/api/x/': 2, ok: { 'cdn.example.no/k': 3, n: 4 } }), { ok: { n: 4 } }, 'URL-shaped keys are dropped');
});

test('autopilot and preview push normalize to their shapes', () => {
  assert.deepEqual(events.normalizeMakerAutopilot({ runId: 'run-1', phase: 'pipeline', status: 'blocked', blocked: 'needs-language', at: '2026-11-01T10:00:00.000Z' }), { runId: 'run-1', phase: 'pipeline', status: 'blocked', blocked: 'needs-language', at: '2026-11-01T10:00:00.000Z' });
  assert.equal(events.normalizeMakerAutopilot({ phase: 'x', blocked: 'not-a-code' }).blocked, '');
  assert.equal(events.normalizeMakerAutopilot({}), null);
  const push = events.normalizePreviewPush({ at: '2026-11-01T11:00:00.000Z', sha256: 'A'.repeat(64), url: 'https://x' });
  assert.deepEqual(push, { at: '2026-11-01T11:00:00.000Z', sha256: 'a'.repeat(64), sourceStep: '', runId: '', sessionId: '' });
  assert.equal(events.normalizePreviewPush({ sha256: 'a' }), null);
});

test('recorder: the event lands on makerRun, a signed client is marked for a gate re-check, set-maker-run cannot write it', () => {
  const result = hubEvents.recordMakerDeliveryEvent({ event: PAYLOAD.event, body: PAYLOAD, client: { id: 'c1' }, sales, runId: 'run-1', now: '2026-11-01T10:00:05.000Z' });
  assert.deepEqual(result, { ok: true, event: 'run.materials.updated', recorded: ['materials'] });
  const client = sales.getSalesClientById('c1');
  assert.equal(client.makerRun.materials.uploads.heroImages, 3);
  assert.equal(client.makerRun.materials.runId, 'run-1');
  assert.equal(client.makerRun.materials.receivedAt, '2026-11-01T10:00:05.000Z');
  assert.equal(client.makerRun.latestReadyStep, '2', 'other makerRun keys are kept');
  assert.equal(client.delivery.dirtyAt, '2026-11-01T10:00:05.000Z');
  const auto = hubEvents.recordMakerDeliveryEvent({ event: 'run.autopilot.updated', body: { autopilot: { phase: 'qa', status: 'done' } }, client: { id: 'c1' }, sales, now: '2026-11-01T10:10:00.000Z' });
  assert.deepEqual(auto.recorded, ['autopilot']);
  assert.equal(sales.getSalesClientById('c1').makerRun.autopilot.phase, 'qa');
  const ignored = hubEvents.recordMakerDeliveryEvent({ event: 'run.materials.updated', body: {}, client: { id: 'c1' }, sales });
  assert.equal(ignored.ignored, true);
  const empty = hubEvents.recordMakerDeliveryEvent({ event: 'run.materials.updated', body: { materials: {} }, client: { id: 'c1' }, sales, runId: 'run-1' });
  assert.equal(empty.ignored, true, 'materials: {} does not replace the stored snapshot');
  assert.equal(sales.getSalesClientById('c1').makerRun.materials.uploads.heroImages, 3);
  const lead = hubEvents.recordMakerDeliveryEvent({ event: PAYLOAD.event, body: PAYLOAD, client: { id: 'lead1' }, sales, runId: 'run-lead', now: '2026-11-01T10:00:05.000Z' });
  assert.deepEqual(lead.recorded, ['materials']);
  assert.equal(sales.getSalesClientById('lead1').delivery, undefined, 'a lead gets no delivery record');
  const viaPatch = sales.setSalesMakerRun('c1', { materials: { logo: { present: false } }, autopilot: { phase: 'x' } });
  assert.equal(viaPatch.makerRun.materials.logo.present, true, 'a set-maker-run body cannot overwrite the snapshot');
  assert.equal(viaPatch.makerRun.autopilot.phase, 'qa');
  const viaUpdate = sales.updateSalesClient('c1', { makerRun: { materials: null } });
  assert.equal(viaUpdate.makerRun.materials.logo.present, true);
});

test('materials snapshot: the logo dot turns green from a snapshot of the linked run younger than 24 h', () => {
  const client = sales.getSalesClientById('c1');
  const fresh = events.freshMakerMaterials(client.makerRun, Date.parse('2026-11-01T20:00:00.000Z'));
  assert.ok(fresh);
  assert.equal(events.freshMakerMaterials(client.makerRun, Date.parse('2026-11-03T10:00:00.000Z')), null, 'older than 24 h');
  assert.equal(events.freshMakerMaterials({ ...client.makerRun, runId: 'run-2' }, Date.parse('2026-11-01T20:00:00.000Z')), null, 'a snapshot of another run');
  assert.equal(events.freshMakerMaterials({ ...client.makerRun, runId: '' }, Date.parse('2026-11-01T20:00:00.000Z')), null, 'no linked run');
  const maker = summarizeMakerRun({ run: events.makerRunFromMaterials(fresh) });
  const dots = Object.fromEntries(scoreClientMaterials({ client, bank: {}, maker }).map((dot) => [dot.id, dot.mark]));
  assert.equal(dots.logo, 'green');
  const without = Object.fromEntries(scoreClientMaterials({ client, bank: {}, maker: {} }).map((dot) => [dot.id, dot.mark]));
  assert.equal(without.logo, 'red');
  assert.deepEqual(events.materialsPageKinds(client.makerRun), [{ route: '/prosjekter', kind: 'portfolio' }]);
  assert.deepEqual(events.materialsOpenNeeds(client.makerRun).map((item) => item.id), ['hero-1', 'contact.email'], 'open WS3 placeholder slots');
});

test('run fetch: the live run (with its answers) comes first; the snapshot stands in only when the fetch fails', async () => {
  const client = sales.getSalesClientById('c1');
  const nowMs = Date.parse('2026-11-01T20:00:00.000Z');
  const liveRun = { answers: { businessName: 'Events AS', phone: '12345678' }, uploads: {}, metadata: {} };
  const live = hubEvents.makerRunFetchWithMaterials(client, async () => ({ run: liveRun }), { recording: true, nowMs });
  assert.deepEqual(await live('run-1'), { run: liveRun }, 'answers from the live run are kept');
  const down = hubEvents.makerRunFetchWithMaterials(client, async () => ({ failed: true }), { recording: true, nowMs });
  const fromSnapshot = await down('run-1');
  assert.equal(fromSnapshot.run.fromMaterialsSnapshot, true);
  assert.equal(fromSnapshot.run.uploads.heroImages.length, 3);
  const throwing = hubEvents.makerRunFetchWithMaterials(client, async () => { throw new Error('unreachable'); }, { recording: true, nowMs });
  assert.equal((await throwing('run-1')).run.fromMaterialsSnapshot, true);
  const off = hubEvents.makerRunFetchWithMaterials(client, async () => ({ failed: true }), { recording: false, nowMs });
  assert.deepEqual(await off('run-1'), { failed: true }, 'switch off: as before');
  const relinked = sales.setSalesMakerRun('c1', { runId: 'run-2' });
  assert.equal(relinked.makerRun.materials.runId, 'run-1', 'the stored snapshot stays on the client');
  const other = hubEvents.makerRunFetchWithMaterials(relinked, async () => ({ failed: true }), { recording: true, nowMs });
  assert.deepEqual(await other('run-2'), { failed: true }, 'the snapshot of the earlier run is not used for the new one');
  sales.setSalesMakerRun('c1', { runId: 'run-1' });
});

test('switch: development.makerEvents is off by default and validated', () => {
  const settings = settingsStore.getAutomationSettings({ fresh: true });
  assert.equal(settings.development.makerEvents, 'off');
  assert.equal(hubEvents.makerEventsRecording(settings), false);
  assert.equal(hubEvents.makerEventsRecording({ development: { makerEvents: 'record' } }), true);
  assert.equal(settingsStore.saveAutomationSettings({ development: { makerEvents: 'always' } }).ok, false);
  const saved = settingsStore.saveAutomationSettings({ development: { makerEvents: 'record' } }, { by: 'test' });
  assert.equal(saved.ok, true);
  assert.equal(hubEvents.makerEventsRecording(settingsStore.getAutomationSettings({ fresh: true })), true);
  settingsStore.saveAutomationSettings({ development: { makerEvents: 'off' } }, { by: 'test' });
});

test('status callback: delivery events go to the recorder only with the switch on, after the run-link check', () => {
  const server = readFileSync(join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf("app.post('/api/admin/sales/maker-status-callback'");
  const end = server.indexOf("\n});\n", start);
  const body = server.slice(start, end);
  const auth = body.indexOf("requireMakerHost('callback')");
  const linkCheck = body.indexOf("reason: 'callback-run-does-not-match-linked-run'");
  const branch = body.indexOf('if (isMakerDeliveryEvent(event) && makerEventsRecording()) {');
  const fieldSync = body.indexOf("if (event === 'run.fields.updated')");
  assert.ok(auth > 0 && linkCheck > auth && branch > linkCheck && fieldSync > branch, 'auth, then the run-link check, then the switch-gated branch');
  assert.match(body.slice(branch, fieldSync), /return res\.json\(recordMakerDeliveryEvent\(\{ event, body: req\.body \|\| \{\}, client, sales, runId: nextRunId \}\)\);/);
  const fetchStart = server.indexOf('async function workshopNeedsMakerFetch(client) {');
  const fetchBody = server.slice(fetchStart, server.indexOf('\n}\n', fetchStart));
  assert.match(fetchBody, /return makerRunFetchWithMaterials\(client, async \(runId\) => \{/);
  assert.match(fetchBody, /fetchMakerRunRecord\(\{ websiteMakerBaseUrl, runId \}\)/);
});
