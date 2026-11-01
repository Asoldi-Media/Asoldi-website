// Every outbound host the hub, Maker and CMS code can reach has a row in the subprocessor register,
// the snapshots are current, and every AI provider allowed personal data is named in the privacy
// policy and the DPA appendix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'legal-hosts-'));
process.env.DATA_DIR = '';

const scan = await import('./legal/scan-hosts.mjs');
const subprocessors = await import('../lib/legal/subprocessors.js');
const render = await import('../lib/legal/render.js');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SNAPSHOTS = ['hub', 'maker', 'cms'];

function snapshot(name) {
  return JSON.parse(readFileSync(new URL(`./legal/hosts-${name}.json`, import.meta.url), 'utf8'));
}

/** The sibling checkout for a snapshot: LEGAL_HOSTS_<NAME>_REPO, else ../website-<name> next to this repo. */
function siblingRepo(name) {
  const fromEnv = process.env[`LEGAL_HOSTS_${name.toUpperCase()}_REPO`];
  const guess = resolve(repoRoot, '..', `website-${name}`);
  const dir = fromEnv || guess;
  return existsSync(join(dir, '.git')) ? dir : '';
}

test('every host in the three snapshots has a register row', () => {
  for (const name of SNAPSHOTS) {
    const hosts = scan.snapshotHosts(snapshot(name));
    assert.ok(hosts.length > 0, `${name} snapshot is empty`);
    assert.deepEqual(subprocessors.hostsWithoutRow(hosts), [], `${name}: hosts without a register row`);
  }
});

test('a host without a row is reported (negative control)', () => {
  assert.deepEqual(subprocessors.hostsWithoutRow(['api.anthropic.com', 'api.unlisted-provider.example.net', 'new.unlisted.io']), ['api.unlisted-provider.example.net', 'new.unlisted.io']);
  assert.ok(subprocessors.registerRowForHost('files.fireflies.ai'), 'a wildcard row covers subdomains');
  assert.equal(subprocessors.registerRowForHost('fireflies.ai.other.io'), null);
});

test('the register is well formed and names every required provider', () => {
  assert.deepEqual(subprocessors.validateRegister(), []);
  const names = Object.values(subprocessors.HOSTS_REGISTER.processors).map((processor) => processor.name);
  for (const name of ['Anthropic', 'DeepSeek', 'OpenAI', 'Google', 'Brevo', 'Resend', 'Stripe', 'PayPal', 'Hostinger', 'Fireflies.ai', 'Deepgram', 'Myphoner', 'Luca Regnskap', 'DataForSEO', 'SerpApi', 'Brave Search']) {
    assert.ok(names.includes(name), name);
  }
  const deepseek = subprocessors.HOSTS_REGISTER.processors.deepseek;
  assert.equal(deepseek.personalData, false, 'DeepSeek receives no personal data while the AI policy says so');
  assert.deepEqual(subprocessors.HOSTS_REGISTER.hosts['api.deepseek.com'].dataCategories, []);
  const broken = { processors: { x: { name: 'X', entity: 'X', region: 'EU', role: 'r', scopes: ['asoldi'], personalData: false } }, hosts: { 'a.example.org': { processor: 'x', purpose: 'p', dataCategories: ['navn'], region: 'EU' }, 'b.example.org': { noPersonalData: true }, 'c.example.org': {} } };
  assert.equal(subprocessors.validateRegister(broken).length, 3, 'contradictions and missing fields are reported');
});

test('the hub snapshot matches a fresh scan of this checkout', async (t) => {
  if (!existsSync(join(repoRoot, '.git'))) {
    t.skip('no git checkout');
    return;
  }
  const committed = snapshot('hub');
  const fresh = await scan.scanRepoHosts(repoRoot, { name: 'hub', ref: committed.ref || '', egress: true });
  assert.deepEqual(scan.diffSnapshots(committed, fresh), { added: [], removed: [] }, 'run node scripts/legal/scan-hosts.mjs . --name hub --egress --out scripts/legal/hosts-hub.json');
});

for (const name of ['maker', 'cms']) {
  test(`the ${name} snapshot matches the ${name} repository when it is next to this one`, async (t) => {
    const dir = siblingRepo(name);
    if (!dir) {
      t.skip(`no ${name} checkout (set LEGAL_HOSTS_${name.toUpperCase()}_REPO)`);
      return;
    }
    const committed = snapshot(name);
    const fresh = await scan.scanRepoHosts(dir, { name, ref: committed.ref || 'HEAD' });
    assert.deepEqual(scan.diffSnapshots(committed, fresh), { added: [], removed: [] }, `regenerate scripts/legal/hosts-${name}.json with scripts/legal/scan-hosts.mjs`);
  });
}

test('the scanner finds outbound hosts and skips comments, placeholders, links in React text and reserved names', () => {
  const js = [
    "const BASE = 'https://api.newprovider.io/v1';",
    '// see https://docs.commented.io/page',
    "/* https://block.commented.io */",
    "fetch(`https://api.second.io/${path}`);",
    "const opts = { hostname: 'files.third.io' };",
    "const demo = 'https://example.com/x';",
    "const ns = 'http://www.w3.org/2000/svg';",
    "input.placeholder = 'https://placeholder.only.io';",
  ].join('\n');
  assert.deepEqual([...scan.hostsInSource(js, 'lib/x.js')].sort(), ['api.newprovider.io', 'api.second.io', 'files.third.io']);
  const tsx = [
    '<a href="https://www.link-only.io">profil</a>',
    "const SRC = 'https://embed.widget.io/x'; s.src = SRC;",
    '<img src="https://images.cdn.io/a.jpg" />',
  ].join('\n');
  assert.deepEqual([...scan.hostsInSource(tsx, 'app/x.tsx')].sort(), ['embed.widget.io', 'images.cdn.io']);
  assert.equal(scan.isScannedPath('lib/foo.js'), true);
  assert.equal(scan.isScannedPath('scripts/foo.test.mjs'), false);
  assert.equal(scan.isScannedPath('test/fixtures/x.js'), false);
  assert.deepEqual(scan.sdkHostsForPackage(JSON.stringify({ dependencies: { stripe: '1', express: '4' } })), ['api.stripe.com']);
});

test('every AI provider allowed a personal-data class is named in the privacy policy and the DPA appendix', () => {
  const rows = subprocessors.llmProviderRows();
  const personal = rows.filter((row) => row.personal);
  assert.ok(personal.length >= 1);
  const privacy = render.documentPlainText(render.renderDocument('personvern', { retentionText: null }));
  const appendix = render.renderDpaAppendixMarkdown();
  for (const row of rows) {
    assert.ok(row.processorId, `${row.provider} has a register processor`);
    assert.ok(privacy.includes(`${row.name}:`), `${row.name} in the privacy policy`);
    assert.ok(appendix.includes(`${row.name}:`), `${row.name} in the DPA appendix`);
  }
  for (const row of personal) assert.match(privacy, new RegExp(`${row.name}: kan få personopplysninger`));
  assert.match(privacy, /DeepSeek: får bare offentlige opplysninger/);
});

test('every processor with personal data is listed where it belongs', () => {
  const privacy = render.documentPlainText(render.renderDocument('personvern', { retentionText: null }));
  const appendix = render.renderDpaAppendixMarkdown();
  for (const entry of subprocessors.subprocessorList({ scope: 'asoldi' })) {
    if (entry.id === 'thirdPartyContent') continue;
    assert.ok(privacy.includes(`${entry.name} (`), `${entry.name} in the privacy policy`);
  }
  for (const entry of subprocessors.subprocessorList({ scope: 'client' })) {
    assert.ok(appendix.includes(`${entry.name} (`), `${entry.name} in the DPA appendix`);
  }
  for (const name of ['Myphoner', 'Deepgram', 'Luca Regnskap', 'Fireflies.ai', 'Brevo', 'Resend', 'Stripe', 'Hostinger']) {
    assert.ok(privacy.includes(`${name} (`), name);
  }
});

test('retention text comes from the personal-data registry when it answers, else from the settings', () => {
  const fromSettings = subprocessors.retentionRows({ retentionText: null });
  assert.equal(fromSettings.find((row) => row.id === 'leads').text, '12 måneder etter siste aktivitet');
  const settings = { retention: { leadMonths: 18 } };
  assert.equal(subprocessors.retentionRows({ settings, retentionText: null }).find((row) => row.id === 'leads').text, '18 måneder etter siste aktivitet');
  const registry = (storeId) => (storeId === 'email-log' ? '13 måneder' : '');
  const mixed = subprocessors.retentionRows({ retentionText: registry });
  assert.equal(mixed.find((row) => row.id === 'emailLog').text, '13 måneder');
  assert.equal(mixed.find((row) => row.id === 'leads').text, '12 måneder etter siste aktivitet');
  const privacy = render.documentPlainText(render.renderDocument('personvern', { retentionText: registry }));
  assert.match(privacy, /Logg over e-post sendt fra Asoldi: 13 måneder\./);
});
