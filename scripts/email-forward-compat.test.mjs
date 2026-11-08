// Forward compatibility of the e-mail data: what this code writes to the e-mail settings, the site
// rows, the site keys, the opt-out record and the owner-change file survives the ordinary writes of
// an older release (a settings change, an owner-routing change, a key record, an opt-out).
//
// By default the child runs this working tree. FORWARD_COMPAT_REF=<git ref> runs that commit
// instead, extracted with `git archive` into build/email-forward-compat-<sha>/ (ignored):
//   FORWARD_COMPAT_REF=<previous release> node --test scripts/email-forward-compat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writer = join(root, 'scripts', 'fixtures', 'email-forward-compat-writer.mjs');
const AT = '2026-11-01T10:00:00.000Z';
const fakeKey = (tag) => `fixture${tag}`.padEnd(43, '0');

const SETTINGS = {
  version: 1,
  enabled: true,
  rollout: { mode: 'allowlist', siteIds: ['fc-site', 'fc-other'] },
  killSwitch: false,
  ownerRoutingDefault: { enabled: false, siteIds: ['fc-site'] },
  devCmsTargets: {},
  testRecipients: ['test-mottaker@example.com'],
  brevo: { planTier: 'starter', termsConfirmedAt: AT, campaignsOnFree: false, sandbox: true, syncContacts: false },
  quota: { limit: 300, perSiteTestMax: 20 },
  links: { imageHosts: ['cdn.example.net'] },
  ext: { futureBatch: { kept: true, n: 7 } },
};
const SITES = {
  'fc-site': {
    brevoListId: 57,
    auth: {
      keyId: 'ek_2', provisionedAt: AT, confirmedAt: AT, target: '', pendingKeyId: 'ek_3', pendingIssuedAt: AT,
      provisionRequests: { day: '2026-11-01', count: 1 }, lastProvisionRequestAt: AT,
    },
    sender: { mode: 'asoldi', domain: '', address: '', brevoDomainVerifiedAt: '', warmupStartedAt: '' },
    ownerRecipients: [
      { email: 'eier@example.com', status: 'confirmed', confirmedAt: AT, source: 'superadmin' },
      { email: 'ny-eier@example.com', status: 'pending', confirmedAt: '', source: 'owner' },
    ],
    ownerRouting: 'owner+asoldi-bcc',
    ownerRoutingSetAt: AT,
    ownerRoutingSetBy: 'owner-routing-default',
    allowHosts: ['butikk.example.com'],
    allowImageHosts: ['bilder.example.net'],
    dpa: { acceptedAt: AT, version: 'v1', attestedBy: '' },
    suspended: null,
    ext: { futureBatch: { kept: true } },
  },
  'fc-other': { brevoListId: null, ownerRecipients: [], dpa: { acceptedAt: '', version: '', attestedBy: 'superadmin' } },
};
const SECRETS = {
  brevoApiKey: '',
  siteKeys: {
    'fc-site': {
      seq: 3, keyId: 'ek_2', key: fakeKey('cur'), prevKeyId: 'ek_1', prevKey: fakeKey('prev'), prevValidUntil: AT,
      pending: { keyId: 'ek_3', key: fakeKey('pend'), issuedAt: AT },
    },
  },
};
const TOMBSTONE = `sha256:${'ab'.repeat(32)}`;
const SUPPRESSIONS = {
  'fc-site': {
    'kunde@example.com': { scope: 'marketing', source: 'one-click', at: AT, updatedAt: AT, messageId: 'em_1' },
    [TOMBSTONE]: { scope: 'marketing', source: 'unsubscribe-link', at: AT, erasedAt: AT },
    'gjen@example.com': { scope: 'none', source: 'unsubscribe-link', at: AT, resubscribedAt: AT, updatedAt: AT },
  },
  '*': { 'retur@example.com': { scope: 'all', source: 'hardBounce', at: AT, updatedAt: AT, siteIds: ['fc-site'] } },
  asoldi: { 'avmeldt@example.com': { scope: 'marketing', source: 'unsubscribe-link', at: AT } },
};
const OWNER = {
  changes: [{
    id: 'oc_0123456789ab', siteId: 'fc-site', at: AT, actor: { username: 'eier', rank: 'owner' },
    previous: [{ email: 'eier@example.com', status: 'confirmed', confirmedAt: AT, source: 'superadmin' }],
    next: SITES['fc-site'].ownerRecipients, revertedAt: '',
  }],
  notices: { 'fc-site': { day: '2026-11-01', count: 2, changes: { day: '2026-11-01', count: 1 }, keys: { [`${'cd'.repeat(16)}`]: Date.parse(AT) } } },
};

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

function codeRootForRef(ref) {
  const sha = execFileSync('git', ['rev-parse', '--short=12', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const destination = join(root, 'build', `email-forward-compat-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  untar(execFileSync('git', ['archive', '--format=tar', sha, 'data', 'lib', 'packages'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }), destination);
  return { codeRoot: destination, label: `${ref} (${sha})`, cleanup: () => rmSync(destination, { recursive: true, force: true }) };
}

/** Paths of every seeded value (leaves and arrays) that the saved value lost or changed. */
function lostValues(seed, saved, path, out) {
  if (seed && typeof seed === 'object' && !Array.isArray(seed) && Object.keys(seed).length) {
    for (const [key, value] of Object.entries(seed)) lostValues(value, saved?.[key], `${path}.${key}`, out);
  } else if (JSON.stringify(seed) !== JSON.stringify(saved)) {
    out.push(path);
  }
  return out;
}

const ref = String(process.env.FORWARD_COMPAT_REF || '').trim();

test(`e-mail data written by this code survives the writes of ${ref ? `commit ${ref}` : 'this working tree'}`, () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-forward-compat-'));
  const target = ref ? codeRootForRef(ref) : { codeRoot: root, label: 'working tree', cleanup: () => {} };
  try {
    mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    writeFileSync(join(dataDir, 'email-settings.json'), JSON.stringify(SETTINGS, null, 2));
    writeFileSync(join(dataDir, 'email-sites.json'), JSON.stringify(SITES, null, 2));
    writeFileSync(join(dataDir, 'secrets', 'email-secrets.json'), JSON.stringify(SECRETS, null, 2));
    writeFileSync(join(dataDir, 'email-suppressions.json'), JSON.stringify(SUPPRESSIONS, null, 2));
    const ownerText = JSON.stringify(OWNER, null, 2);
    writeFileSync(join(dataDir, 'email-owner.json'), ownerText);

    const out = execFileSync(process.execPath, [writer, '--code-root', target.codeRoot], {
      cwd: root,
      env: { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    const report = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(report.done, ['saveEmailSettings', 'patchEmailSite', 'patchEmailSecrets', 'updateEmailSuppressions'], `${target.label} ran every write`);

    const read = (...parts) => JSON.parse(readFileSync(join(dataDir, ...parts), 'utf8'));
    const settings = read('email-settings.json');
    const sites = read('email-sites.json');
    const secrets = read('secrets', 'email-secrets.json');
    const suppressions = read('email-suppressions.json');

    // The writes happened.
    assert.equal(settings.killSwitch, true);
    assert.equal(sites['fc-site'].ownerRouting, 'owner');
    assert.equal(sites['fc-site'].ownerRoutingSetBy, 'superadmin');
    assert.equal(secrets.siteKeys['fc-other'].seq, 1);
    assert.equal(suppressions['fc-other']['ny-kunde@example.com'].scope, 'marketing');

    // Everything else this code wrote is still there, unchanged.
    const lost = [];
    lostValues({ ...SETTINGS, killSwitch: true }, settings, 'settings', lost);
    lostValues({ ...SITES['fc-site'], ownerRouting: 'owner', ownerRoutingSetAt: '2026-11-05T12:00:00.000Z', ownerRoutingSetBy: 'superadmin' }, sites['fc-site'], 'sites.fc-site', lost);
    lostValues(SITES['fc-other'], sites['fc-other'], 'sites.fc-other', lost);
    lostValues(SECRETS.siteKeys, secrets.siteKeys, 'secrets.siteKeys', lost);
    lostValues(SUPPRESSIONS, suppressions, 'suppressions', lost);
    assert.deepEqual(lost, [], `${target.label} dropped or changed e-mail data`);
    assert.equal(readFileSync(join(dataDir, 'email-owner.json'), 'utf8'), ownerText, 'the owner-change file is left alone');
  } finally {
    target.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
