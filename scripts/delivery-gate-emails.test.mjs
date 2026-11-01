// Missing-info mails with the gate's lines: the pre-workshop mail and the Datainnsamling desk lines,
// grouped HTML, the scheduling Reply-To rule, shadow records, and the negative control that with the
// gate off the pre-workshop mails are byte-identical to the deployed commit's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'asoldi-gate-mail-'));
process.env.APP_DATA_DIR = DATA_DIR;
delete process.env.DATA_DIR;
for (const key of Object.keys(process.env)) if (/^(SMTP|RESEND|EMAIL_REDIRECT)/.test(key)) delete process.env[key];
process.env.RESEND_API_KEY = 're_standin_for_tests';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_REF = String(process.env.GATE_BASELINE_REF || '859429c').trim();

// The mail transport is a stand-in: every send to the mail API is counted here and answered locally.
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
});

const settingsStore = await import('../data/automation-settings.js');
const sales = await import('../data/sales.js');
const prep = await import('../lib/workshop-prep-send.js');
const gateLib = await import('../lib/delivery-gate.js');
const emails = await import('../lib/delivery-emails.js');
const mail = await import('../lib/sales-email.js');
const { listOutbox, readOutboxItem } = await import('../lib/safe-mode-outbox.js');
const { readDeliveryAudit } = await import('../lib/delivery-audit.js');

const TIER3 = { status: 'active', tierId: 'tier-3-ecommerce', services: ['site', 'changes', 'blog', 'seo', 'social', 'email', 'backlinks', 'ecom', 'dashboard', 'multilingual'], languages: ['nb'], billing: 'month', source: 'backfill' };
const deps = { fetchMakerRun: async () => ({ failed: true }), listMail: async () => ({ messages: [] }) };
const SENDER = { name: 'Alexander', fullName: 'Alexander', fromEmail: 'alexander@asoldi.com', from: 'Alexander fra Asoldi <alexander@asoldi.com>', replyTo: 'alexander@asoldi.com' };

function save(patch) {
  const result = settingsStore.saveAutomationSettings(patch);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  settingsStore.invalidateAutomationSettingsCache();
}

function seedSigned(id, extra = {}) {
  sales.createSalesClient({
    id,
    businessName: 'Example Shop AS',
    contactPerson: 'Kari Example',
    contactEmail: `${id}@example.com`,
    product: 'asoldi',
    progression: { contractSigned: true },
    contractSignedAt: '2026-11-01T09:00:00.000Z',
    ...extra,
  });
  sales.setSalesSitePlan(id, TIER3, { by: 'test' });
  return sales.getSalesClientById(id);
}

// ---------------------------------------------------------------- baseline extraction

function untar(buffer, destination) {
  let offset = 0;
  let paxPath = '';
  const text = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = '';
    if (path.includes('..')) throw new Error(`unsafe path in archive: ${path}`);
    const target = join(destination, path);
    if (type === '5') mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

function baselineTree() {
  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', '--short=12', `${BASELINE_REF}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  const destination = join(root, 'build', `gate-baseline-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', sha, 'data', 'lib', 'packages', 'public/email'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  untar(tar, destination);
  return { root: destination, sha, cleanup: () => rmSync(destination, { recursive: true, force: true }) };
}

function capture(codeRoot, settingsFile = null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-gate-capture-'));
  if (settingsFile) writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify(settingsFile));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SMTP|RESEND|EMAIL_REDIRECT|HUB_SAFE)/.test(key)));
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'fixtures', 'gate-premail-capture.mjs'), '--code-root', codeRoot], {
    cwd: root,
    env: { ...env, APP_DATA_DIR: dataDir, DATA_DIR: dataDir, RESEND_API_KEY: 're_standin_for_tests' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  rmSync(dataDir, { recursive: true, force: true });
  return JSON.parse(out.trim().split('\n').pop());
}

test(`negative control: with the gate off the pre-workshop and Datainnsamling mails equal ${BASELINE_REF}'s byte for byte`, (t) => {
  const baseline = baselineTree();
  if (!baseline) {
    t.skip(`${BASELINE_REF} is not in this checkout`);
    return;
  }
  try {
    const expected = capture(baseline.root);
    assert.equal(expected.sends.length, 2, 'the deployed code sends both pre-workshop mails');
    assert.deepEqual(expected.network, []);
    const defaults = settingsStore.defaultAutomationSettings();
    const variants = {
      'defaults (gate off)': null,
      'gate off, lines set to gate': { ...defaults, emails: { ...defaults.emails, preWorkshop: { ...defaults.emails.preWorkshop, lines: 'gate' } } },
      'gate on, lines legacy': { ...defaults, gate: { enabled: true, mode: 'shadow', paused: null } },
    };
    for (const [label, settings] of Object.entries(variants)) {
      const actual = capture(root, settings);
      assert.deepEqual(actual.sends, expected.sends, `${label}: sends (body, headers, Reply-To)`);
      assert.deepEqual(actual.results, expected.results, `${label}: results`);
      assert.deepEqual(actual.built, expected.built, `${label}: built mails`);
      assert.deepEqual(actual.network, []);
    }
  } finally {
    baseline.cleanup();
  }
});

test('with lines set to gate and the gate in shadow, no pre-workshop mail reaches the transport', async () => {
  save({ gate: { enabled: true, mode: 'shadow' }, emails: { preWorkshop: { lines: 'gate', mode: 'shadow' } } });
  const client = seedSigned('pre-shadow-1');
  const before = transport.length;
  const result = await prep.sendPreWorkshopAfterContractSigned(client, { sender: SENDER, previousSigned: false, ...deps });
  assert.equal(result.sent, false);
  assert.equal(result.shadow, true);
  assert.equal(result.gateLines, true);
  assert.equal(transport.length, before, 'nothing reached the transport');
  const records = listOutbox(DATA_DIR).items.filter((item) => item.channel === emails.SHADOW_CHANNEL && item.to.includes('pre-shadow-1@example.com'));
  assert.equal(records.length, 1);
  assert.equal(records[0].replyTo, 'alexander@asoldi.com');
  const body = readOutboxItem(DATA_DIR, records[0].id);
  for (const group of ['Merke', 'Innhold', 'Kontakt', 'Nettbutikk', 'Synlighet']) assert.match(body.html, new RegExp(`>${group}<`));
  assert.equal((body.text.match(/Logoen deres/g) || []).length, 1, 'one logo line');
  assert.ok(result.needLines.length <= 12);
  const audit = readDeliveryAudit({ dataDir: DATA_DIR }).filter((row) => row.kind === 'email-shadow' && row.clientId === 'pre-shadow-1');
  assert.equal(audit.length, 1);
  assert.equal(sales.getSalesClientById('pre-shadow-1').workshop?.deskEmails?.preWorkshopSentAt || '', '', 'a shadow mail stamps nothing');
  // The same signing again records nothing new.
  await prep.sendPreWorkshopAfterContractSigned(client, { sender: SENDER, previousSigned: false, ...deps });
  assert.equal(listOutbox(DATA_DIR).items.filter((item) => item.to.includes('pre-shadow-1@example.com')).length, 1);
  assert.equal(transport.length, before);
});

test('with the pre-workshop kind released to auto, the gate in shadow still keeps the mail out of the transport', async () => {
  settingsStore.recordReleasePass('emails.preWorkshop.gate', { suite: 'test suite' });
  settingsStore.invalidateAutomationSettingsCache();
  const settings = settingsStore.getAutomationSettings({ fresh: true });
  assert.equal(settings.emails.preWorkshop.lines, 'gate');
  assert.equal(settings.emails.preWorkshop.mode, 'auto');
  const client = seedSigned('pre-shadow-2');
  const before = transport.length;
  const result = await prep.sendPreWorkshopAfterContractSigned(client, { sender: SENDER, previousSigned: false, ...deps });
  assert.equal(result.shadow, true);
  assert.equal(transport.length, before);
  // A stored gate in auto (not offered by the settings yet) would send through the transport.
  const auto = { ...settings, gate: { enabled: true, mode: 'auto', paused: null }, pilotClientIds: ['pre-shadow-3'] };
  assert.equal(emails.deliveryEmailMode('preWorkshop', { id: 'pre-shadow-3' }, { settings: auto }), 'auto');
  assert.equal(emails.deliveryEmailMode('preWorkshop', { id: 'not-a-pilot' }, { settings: auto }), 'shadow');
  assert.equal(emails.deliveryEmailMode('preWorkshop', { id: 'pre-shadow-3' }, { settings: { ...auto, gate: { enabled: false, mode: 'shadow', paused: null } } }), 'off');
});

test('Reply-To on the gate path: the rep mailbox only when the inbox bot reads it', async () => {
  const settings = settingsStore.defaultAutomationSettings();
  assert.deepEqual(emails.botReadMailboxes(settings), ['alexander@asoldi.com']);
  const rep = await emails.schedulingSender({ id: 'x' }, { ...SENDER }, { settings });
  assert.equal(rep.replyTo, 'alexander@asoldi.com');
  // A rep mailbox the bot does not read keeps today's Reply-To.
  const other = { name: 'Damian', fromEmail: 'damian@asoldi.com', from: 'Damian fra Asoldi <damian@asoldi.com>', replyTo: 'damian@asoldi.com' };
  assert.equal((await emails.schedulingSender({ id: 'x' }, other, { settings })).replyTo, 'damian@asoldi.com');
  const outside = { fromEmail: 'someone@asoldi.com', replyTo: 'someone@asoldi.com' };
  assert.equal((await emails.schedulingSender({ id: 'x' }, outside, { settings })).replyTo, 'someone@asoldi.com');
  // Read by the bot once listed in inbox.mailboxes.
  const both = { ...settings, inbox: { ...settings.inbox, mailboxes: ['alexander@asoldi.com', 'damian@asoldi.com'] } };
  assert.equal((await emails.schedulingSender({ id: 'x' }, other, { settings: both })).replyTo, 'damian@asoldi.com');
  // No sender (signing outside the admin): the client's owner when that mailbox is read.
  const owned = await emails.schedulingSender({ id: 'x', ownerId: 'admin:alexander@asoldi.com' }, {}, { settings });
  assert.equal(owned.replyTo, 'alexander@asoldi.com');
  assert.equal((await emails.schedulingSender({ id: 'x' }, {}, { settings })).replyTo, undefined, 'otherwise the layout default stays');
  // The built mail carries it.
  const built = mail.buildPreWorkshopEmail({ businessName: 'Example AS' }, {}, { sender: owned, hasTime: false, needLines: [] });
  assert.equal(built.replyTo, 'alexander@asoldi.com');
});

test('desk Datainnsamling lines: today\'s lines unless the pre-workshop mail is auto for the client with lines set to gate', async () => {
  save({ gate: { enabled: false }, emails: { preWorkshop: { lines: 'legacy', mode: 'auto' } } });
  const client = seedSigned('desk-1', { makerRun: { runId: 'run-d1' } });
  sales.setSalesMakerRunOwned('desk-1', {
    materials: {
      runId: 'run-d1',
      at: '2026-11-01T10:00:00.000Z',
      receivedAt: '2026-11-01T10:00:00.000Z',
      needs: { schema: 'asoldi.run-needs/1', items: [{ id: 'media.placeholders', status: 'missing', slots: [{ route: '/portfolio', key: 'p1' }, { route: '/portfolio', key: 'p2' }] }] },
    },
  });
  assert.equal(await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1')), null, 'gate off');
  save({ gate: { enabled: true } });
  assert.equal(await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1')), null, 'lines legacy');
  // The desk sends through the real transport: with the gate in shadow it keeps today's lines,
  // also with lines set to gate and the pre-workshop kind released to auto.
  save({ emails: { preWorkshop: { lines: 'gate', mode: 'shadow' } } });
  assert.equal(await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1')), null, 'gate in shadow');
  const stored = settingsStore.getAutomationSettings({ fresh: true });
  const kindAuto = { ...stored, emails: { ...stored.emails, preWorkshop: { ...stored.emails.preWorkshop, lines: 'gate', mode: 'auto' } } };
  assert.equal(await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1'), { settings: kindAuto }), null, 'gate in shadow, kind auto');
  // Only with the gate and the kind auto for this client (a pilot) do the gate's lines reach the desk.
  const auto = { ...kindAuto, pilotClientIds: ['desk-1'], gate: { enabled: true, mode: 'auto', paused: null } };
  assert.equal(await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1'), { settings: { ...auto, pilotClientIds: ['someone-else'] } }), null, 'not a pilot');
  const rows = await gateLib.gateMailLinesFor(sales.getSalesClientById('desk-1'), { settings: auto });
  assert.ok(Array.isArray(rows) && rows.length > 0);
  assert.ok(rows.every((row) => row.source === 'gate' && row.group));
  const placeholder = rows.find((row) => row.placeholder);
  assert.equal(placeholder.title, 'Vi bruker fortsatt 2 eksempelbilder, blant annet på /portfolio.');
  assert.equal(placeholder.group, 'Bilder');
  const built = mail.buildDataInnsamlingEmail(client, {}, 2, { needLines: rows });
  const order = ['Merke', 'Innhold', 'Kontakt', 'Bilder', 'Nettbutikk', 'Synlighet'].map((group) => built.html.indexOf(`>${group}<`)).filter((index) => index >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'groups in the fixed order');
  assert.match(built.text, /^Bilder:$/m);
  assert.match(built.text, /eksempelbilder, blant annet på \/portfolio/);
  save({ gate: { enabled: false }, emails: { preWorkshop: { lines: 'legacy', mode: 'auto' } } });
});

test('legacy need lines render as one list, exactly as before', () => {
  const lines = [{ id: 'logo', title: 'Logo', detail: 'Høy oppløsning' }];
  const built = mail.buildDataInnsamlingEmail({ businessName: 'Example AS' }, {}, 1, { needLines: lines });
  assert.match(built.html, /<p style="margin:0 0 8px;">Vi trenger fortsatt dette fra dere:<\/p><ul style="margin:0 0 14px;padding-left:18px;"><li style="margin:0 0 8px;"><strong>Logo<\/strong><br \/>Høy oppløsning<\/li><\/ul>/);
  assert.match(built.text, /^- Logo: Høy oppløsning$/m);
});
