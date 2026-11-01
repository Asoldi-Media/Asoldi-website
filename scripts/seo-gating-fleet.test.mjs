// Negative control for SEO job gating (lib/seo-ops/job-gating.js): on a synthetic fleet (tiers 1-3
// and custom, blog on and off, with and without services, with and without a portal user, with and
// without a hub site), the sets of sites that get automatic posts and that get Maps ranking are the
// same as the base release's (SEO_BASE_REF, default 859429c, extracted with git archive) with
// seo.jobGating off and in shadow. In shadow the decision-diff file lists exactly the sites where the
// feature-key gate decides differently. No request leaves the process (the Maps runs answer every
// request themselves). Every business is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fsModule from 'node:fs';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = join(root, 'scripts', 'fixtures', 'seo-gating-maps-runner.mjs');
const egressGuard = pathToFileURL(join(root, 'scripts', 'security', 'loopback-only-egress.mjs')).href;
const BASE_REF = process.env.SEO_BASE_REF || '859429c';

const fleetDir = mkdtempSync(join(tmpdir(), 'asoldi-seo-fleet-'));
process.env.APP_DATA_DIR = fleetDir;

// ---------------------------------------------------------------- the fleet

const TIERS = ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce', 'custom'];
const PLAN_SOURCES = [null, { kind: 'offer', services: ['site'] }, { kind: 'offer', services: ['site', 'seo'] }, { kind: 'backfill', derivedFeatures: {} }];

function buildFleet() {
  const sites = [];
  const profiles = [];
  let n = 0;
  for (const tier of TIERS) {
    for (const blog of [true, false]) {
      for (const planSource of PLAN_SOURCES) {
        for (const portal of [true, false]) {
          for (const analytics of tier === 'custom' ? [true, false] : [null]) {
            n += 1;
            const tierNumber = tier === 'tier-3-ecommerce' ? 3 : tier === 'tier-2-seo' ? 2 : 1;
            const site = {
              id: `site-${n}`,
              site_key: `fleet-${n}`,
              name: `Flåtebedrift ${n}`,
              domain: `fleet-${n}.example.com`,
              websitePlan: tier,
              features: {
                users: true,
                analytics: tier === 'custom' ? analytics : tierNumber >= 2,
                ecommerce: tierNumber >= 3,
                blog,
                socialSync: false,
                emailMarketing: false,
                general: true,
              },
            };
            if (planSource) site.planSource = planSource;
            // An agency override stored under ext: it must change nothing while gating is off or in shadow.
            if (n % 5 === 0) site.ext = { seoFeatureOverrides: { 'blog.autoPosts': false, 'seo.tracking.maps': false } };
            sites.push(site);
            if (portal) {
              profiles.push({
                businessId: `biz-${n}`,
                userId: `user-${n}`,
                email: `post${n}@example.com`,
                businessName: site.name,
                createdAt: '2026-10-01T10:00:00.000Z',
                updatedAt: '2026-10-01T10:00:00.000Z',
                clientDataBank: {
                  generalInfo: { companyName: site.name, websiteUrl: `https://${site.domain}/`, companyAddress: n % 7 === 0 ? '' : `Flåteveien ${n}, 0001 Eksempelby` },
                  websiteCreatorQuestions: { town: n % 7 === 0 ? '' : 'Eksempelby', importantKeywords: ['eksempel tjeneste'] },
                },
              });
            }
          }
        }
      }
    }
  }
  // Portal users without a hub site: the plan they paid for or picked decides.
  for (const [i, planId] of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce', 'seo', ''].entries()) {
    profiles.push({
      businessId: `solo-${i}`,
      userId: `solo-user-${i}`,
      email: `solo${i}@example.com`,
      businessName: `Solobedrift ${i}`,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      payment: planId ? { planId } : undefined,
      clientDataBank: {
        generalInfo: { companyName: `Solobedrift ${i}`, companyAddress: `Soloveien ${i}, 0001 Eksempelby` },
        websiteCreatorQuestions: { town: 'Eksempelby' },
      },
    });
  }
  return { sites, profiles };
}

const fleet = buildFleet();
writeFileSync(join(fleetDir, 'sites.json'), JSON.stringify(fleet.sites));
writeFileSync(join(fleetDir, 'client-portal-profiles.json'), JSON.stringify(fleet.profiles));

// ---------------------------------------------------------------- the base release

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

function baseCodeRoot() {
  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', '--short=12', `${BASE_REF}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  // Inside the repo (build/ is ignored) so the base code resolves this tree's node_modules.
  const destination = join(root, 'build', `seo-gating-${sha}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  untar(execFileSync('git', ['archive', '--format=tar', sha, 'data', 'lib', 'packages'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }), destination);
  return destination;
}

const base = baseCodeRoot();
test.after(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  rmSync(fleetDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

const { normalizeSite } = await import('../data/hub-model.js');
const blog = await import('../lib/local-blog-brief.js');
const gating = await import('../lib/seo-ops/job-gating.js');
const { defaultAutomationSettings } = await import('../data/automation-settings.js');
const baseBlog = base ? await import(pathToFileURL(join(base, 'lib', 'local-blog-brief.js')).href) : null;

function settingsFor(mode) {
  const settings = defaultAutomationSettings();
  if (mode !== 'off') settings.seo.jobGating = { enabled: true, mode };
  return settings;
}

const sorted = (set) => [...set].sort();

function runMaps(codeRoot, mode) {
  const dataDir = mkdtempSync(join(tmpdir(), `asoldi-seo-fleet-${mode}-`));
  const cwd = mkdtempSync(join(tmpdir(), 'asoldi-seo-fleet-cwd-'));
  try {
    for (const file of ['sites.json', 'client-portal-profiles.json']) cpSync(join(fleetDir, file), join(dataDir, file));
    if (mode !== 'off' && mode !== 'base') writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify(settingsFor(mode)));
    const out = execFileSync(process.execPath, ['--import', egressGuard, runner, '--code-root', codeRoot], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot || '',
        TEMP: process.env.TEMP || tmpdir(),
        TMP: process.env.TMP || tmpdir(),
        APP_DATA_DIR: dataDir,
        PERSIST_PRODUCTION_ENV: '0',
        DATAFORSEO_AUTH: Buffer.from('test-only:not-a-credential').toString('base64'),
        DATAFORSEO_MAPS_BUDGET_USD: '1000',
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- automatic posts

test('automatic posts: off and shadow give the base release\'s set of sites; shadow logs exactly the differences', async () => {
  const sites = fleet.sites.map((site) => normalizeSite(site));
  const decide = (mode) => new Set(sites.filter((site) => blog.localBlogAutoPostsEnabled(site, { settings: settingsFor(mode) })).map((site) => site.site_key));
  const legacyGate = baseBlog ? baseBlog.localBlogAutoPostsEnabled : blog.legacyLocalBlogAutoPostsEnabled;
  const legacy = new Set(sites.filter((site) => legacyGate(site)).map((site) => site.site_key));
  gating.resetDecisionDiffStateForTests();
  const off = decide('off');
  const shadow = decide('shadow');
  await gating.flushDecisionDiff();
  const auto = decide('auto');
  assert.deepEqual(sorted(off), sorted(legacy), 'off equals the base release');
  assert.deepEqual(sorted(shadow), sorted(legacy), 'shadow equals the base release');
  assert.ok(legacy.size > 0 && legacy.size < sites.length, 'the fleet has sites on both sides');
  const differing = sites.filter((site) => off.has(site.site_key) !== auto.has(site.site_key)).map((site) => site.site_key).sort();
  assert.ok(differing.length > 0, 'the feature-key gate does decide some sites differently');
  const rows = Object.values(gating.readDecisionDiff()).filter((row) => row.job === 'blog-scheduler');
  assert.deepEqual(rows.map((row) => row.siteKey).sort(), differing, 'shadow logged exactly the differing sites');
  for (const row of rows) assert.equal(row.legacy, off.has(row.siteKey));
  // Auto never posts on a site whose blog module is off, as the old gate never did.
  const blogOff = sites.filter((site) => site.features?.blog !== true).map((site) => site.site_key);
  assert.ok(blogOff.length > 0);
  assert.deepEqual(blogOff.filter((key) => auto.has(key)), [], 'auto: no automatic posts with the blog off');
  if (!baseBlog) console.log(`# ${BASE_REF} not available: compared with this tree's old gate only`);
});

// ---------------------------------------------------------------- Maps ranking

test('Maps ranking: off and shadow rank the base release\'s set of profiles; no request leaves', { timeout: 300_000 }, () => {
  const baseRun = base ? runMaps(base, 'base') : null;
  const off = runMaps(root, 'off');
  const shadow = runMaps(root, 'shadow');
  const auto = runMaps(root, 'auto');
  const reference = baseRun ? baseRun.ranked : off.ranked;
  assert.deepEqual(off.ranked, reference, 'off equals the base release');
  assert.deepEqual(shadow.ranked, reference, 'shadow equals the base release');
  assert.ok(reference.length > 0 && reference.length < fleet.profiles.length, 'the fleet has profiles on both sides');
  assert.equal(off.decisionDiff && Object.keys(off.decisionDiff).length, 0, 'off writes no decision diff');
  const rows = Object.values(shadow.decisionDiff || {}).filter((row) => row.job === 'rank-tracker.maps');
  const autoSet = new Set(auto.ranked);
  const offSet = new Set(off.ranked);
  const differing = [...new Set([...autoSet, ...offSet])].filter((id) => autoSet.has(id) !== offSet.has(id));
  assert.ok(differing.length > 0, 'the feature-key gate does decide some profiles differently');
  const keyOf = (businessId) => {
    const n = /^biz-(\d+)$/.exec(businessId)?.[1];
    return n ? `fleet-${n}` : `profile:${businessId}`;
  };
  const rowKeys = new Set(rows.map((row) => row.siteKey));
  for (const id of differing) assert.ok(rowKeys.has(keyOf(id)), `shadow logged ${id}`);
  if (!baseRun) console.log(`# ${BASE_REF} not available: compared with this tree's old gate only`);
});

// ---------------------------------------------------------------- the lead's diff script

test('seo-gating-diff.mjs prints both decisions per site for a data copy and never writes to it', () => {
  const { readdirSync, readFileSync, statSync } = fsModule;
  const snapshot = () => readdirSync(fleetDir, { recursive: true }).sort().map((name) => {
    const path = join(fleetDir, String(name));
    return statSync(path).isFile() ? `${name}:${readFileSync(path, 'utf8').length}:${statSync(path).mtimeMs}` : String(name);
  });
  const before = snapshot();
  const script = join(root, 'scripts', 'seo-gating-diff.mjs');
  const json = JSON.parse(execFileSync(process.execPath, [script, '--data', fleetDir, '--json', '--all'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.equal(json.rows.filter((row) => row.job === 'blog-scheduler').length, fleet.sites.length);
  assert.equal(json.rows.filter((row) => row.job === 'rank-tracker.maps').length, fleet.profiles.length);
  // The script's old and new decisions are the ones the gates use.
  const sites = new Map(fleet.sites.map((site) => [site.site_key, normalizeSite(site)]));
  for (const row of json.rows.filter((entry) => entry.job === 'blog-scheduler')) {
    assert.equal(row.old, blog.legacyLocalBlogAutoPostsEnabled(sites.get(row.siteKey)), row.siteKey);
    assert.equal(row.new, blog.localBlogAutoPostsEnabled(sites.get(row.siteKey), { settings: settingsFor('auto') }), row.siteKey);
  }
  assert.ok(json.differing > 0);
  const text = execFileSync(process.execPath, [script, '--data', fleetDir], { encoding: 'utf8' });
  assert.match(text, /^job\s+site\s+tier\s+old\s+new/m);
  assert.match(text, /blog-scheduler: \d+ sites, \d+ differ/);
  assert.match(text, /rank-tracker\.maps: \d+ sites, \d+ differ/);
  assert.doesNotMatch(text, /Flåtebedrift|Solobedrift/, 'no business names in the output');
  assert.deepEqual(snapshot(), before, 'the data dir is unchanged');
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
