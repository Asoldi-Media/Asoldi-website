// WS8.45: the shared delivery vocabulary (packages/suite/core/delivery/vocab.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vocab from '../packages/suite/core/delivery/vocab.js';
import { featuresFromPlan } from '../data/hub-model.js';
import { WEBSITE_TIERS } from '../lib/website-tiers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'packages', 'suite', 'core', 'delivery', 'vocab.js');
const makerFile = join(root, '..', 'website-maker', 'lib', 'suite', 'core', 'delivery', 'vocab.js');

function sha(file) {
  return createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

function assertUnique(list, label) {
  assert.equal(new Set(list).size, list.length, `${label} has duplicates`);
}

test('every list is unique and frozen', () => {
  for (const [label, list] of Object.entries({
    SERVICE_IDS: vocab.SERVICE_IDS,
    ONE_TIME_ADDON_IDS: vocab.ONE_TIME_ADDON_IDS,
    JOB_KINDS: vocab.JOB_KINDS,
    BLOCKING_CODES: vocab.BLOCKING_CODES,
    WARNING_CODES: vocab.WARNING_CODES,
    STAGES: vocab.STAGES,
    STAGE_OVERLAYS: vocab.STAGE_OVERLAYS,
    GATE_LINE_IDS: vocab.GATE_LINE_IDS,
    GATE_INFO_LINES: vocab.GATE_INFO_LINES,
    EMAIL_KIND_IDS: vocab.EMAIL_KIND_IDS,
    RELEASE_GATED_SWITCHES: vocab.RELEASE_GATED_SWITCHES,
  })) {
    assertUnique(list, label);
    assert.ok(Object.isFrozen(list), `${label} is not frozen`);
  }
  assert.ok(Object.isFrozen(vocab.SERVICE_CATALOG[0]));
  assert.ok(Object.isFrozen(vocab.TIER_SERVICES['tier-2-seo']));
  assertUnique(Object.values(vocab.SETTINGS_KEYS), 'SETTINGS_KEYS');
  assert.deepEqual(
    vocab.BLOCKING_CODES.filter((code) => vocab.WARNING_CODES.includes(code)),
    [],
    'a code is either blocking or a warning',
  );
});

test('job kinds: only JOB_KINDS pass; other spellings are rejected', () => {
  for (const kind of vocab.JOB_KINDS) assert.equal(vocab.assertJobKind(kind), kind);
  for (const bad of ['change-request', 'dev-accept', 'materials-sync', 'seo', '', null, undefined, 'CONTINUE']) {
    assert.equal(vocab.isJobKind(bad), false, String(bad));
    assert.throws(() => vocab.assertJobKind(bad), (error) => error.code === 'unknown-job-kind');
  }
});

test('blocking and warning codes, including the parametric step-failed:<target>', () => {
  assert.equal(vocab.isBlockingCode('needs-language'), true);
  assert.equal(vocab.isBlockingCode('step-failed:3'), true);
  assert.equal(vocab.isBlockingCode('step-failed:maps-embed-sync'), true);
  assert.equal(vocab.isBlockingCode('step-failed'), false, 'step-failed needs its target');
  assert.equal(vocab.isBlockingCode('step-failed:'), false);
  assert.equal(vocab.isBlockingCode('step-failed:../x'), false);
  assert.equal(vocab.isBlockingCode('needs-language:x'), false, 'only parametric codes take a target');
  assert.equal(vocab.codeBase('step-failed:2.5'), 'step-failed');
  // Owner decision Q6: a soft budget never blocks; only a runaway or a loop does.
  assert.equal(vocab.isBlockingCode('budget-exceeded'), false);
  assert.equal(vocab.isBlockingCode('budget-runaway'), true);
  assert.equal(vocab.isBlockingCode('loop-detected'), true);
  assert.equal(vocab.isWarningCode('budget-soft-limit'), true);
  assert.equal(vocab.isWarningCode('seo-deferred-no-domain'), true);
  assert.equal(vocab.isWarningCode('needs-language'), false);
});

test('services: aliases resolve, unknown ids drop, order follows the catalog', () => {
  assert.deepEqual(vocab.normalizeServices(['shop', 'site', 'ecommerce', 'Nettbutikk', 'bogus', 'site']), ['site', 'ecom']);
  assert.deepEqual(vocab.normalizeServices(['epost', 'katalog', 'timebestilling', 'lenkenettverk']), ['email', 'catalog', 'booking', 'backlinks']);
  assert.deepEqual(vocab.unknownServices(['shop', 'bogus', '', 'site']), ['bogus']);
  assert.deepEqual(vocab.normalizeServices('site'), []);
  assert.equal(vocab.canonicalServiceId(' ECOMMERCE '), 'ecom');
  for (const target of Object.values(vocab.SERVICE_ALIASES)) assert.ok(vocab.isServiceId(target), target);
  assert.deepEqual(vocab.normalizeOneTimeAddOns(['POS', 'thirdpartyhost', 'standalone']), ['pos', 'thirdpartyhost']);
});

test('tier matrix: every tier builds on the one below and uses known ids', () => {
  const [t1, t2, t3] = ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce'].map((id) => vocab.servicesForTier(id));
  for (const list of [t1, t2, t3]) for (const id of list) assert.ok(vocab.isServiceId(id), id);
  for (const id of t1) assert.ok(t2.includes(id), `tier 2 lacks ${id}`);
  for (const id of t2) assert.ok(t3.includes(id), `tier 3 lacks ${id}`);
  assert.deepEqual(vocab.servicesForTier('custom'), []);
  assert.deepEqual(vocab.servicesForTier('nope'), []);
  for (const tier of WEBSITE_TIERS) assert.ok(vocab.TIER_IDS.includes(tier.id), `${tier.id} missing from TIER_IDS`);
  assert.equal(vocab.CHANGES_PER_MONTH, 4);
});

test('owner decisions: blog on all tiers, auto posts and backlinks in tier 2+, no standalone mode', () => {
  for (const tier of ['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce']) {
    assert.ok(vocab.servicesForTier(tier).includes('blog'), `${tier} must include blog`);
  }
  assert.equal(vocab.servicesForTier('tier-1-standard').includes('backlinks'), false);
  assert.equal(vocab.servicesForTier('tier-1-standard').includes('seo'), false);
  for (const tier of ['tier-2-seo', 'tier-3-ecommerce']) {
    assert.ok(vocab.servicesForTier(tier).includes('backlinks'), `${tier} must include backlinks`);
    assert.ok(vocab.servicesForTier(tier).includes('seo'));
  }
  // A custom plan with a site still gets the blog.
  assert.ok(vocab.expandServices(['site', 'changes', 'ecom']).includes('blog'));
  // WS6 registry names: the client-written blog is `blog` (every tier); automatic posts are
  // `blog.localPosts` and belong to `seo` only. WS6.4 must move blog.localPosts out of its `blog`
  // bundle into the `seo` bundle, otherwise blog on every tier would give tier 1 auto posts.
  assert.deepEqual(vocab.SERVICE_FEATURE_ANCHORS.blog, ['blog']);
  assert.deepEqual(vocab.SERVICE_FEATURE_ANCHORS.seo, ['blog.localPosts']);
  assert.deepEqual(vocab.SERVICE_FEATURE_ANCHORS.backlinks, ['seo.linkNetwork']);
  assert.deepEqual(vocab.SERVICE_EXCLUSIVE_FEATURES['blog.localPosts'], ['seo']);
  for (const id of Object.keys(vocab.SERVICE_FEATURE_ANCHORS)) assert.ok(vocab.isServiceId(id));
  // No auto-post key may be anchored to a service that tier 1 has.
  const tier1 = vocab.servicesForTier('tier-1-standard');
  for (const [feature, owners] of Object.entries(vocab.SERVICE_EXCLUSIVE_FEATURES)) {
    for (const [service, anchors] of Object.entries(vocab.SERVICE_FEATURE_ANCHORS)) {
      if (anchors.includes(feature)) assert.ok(owners.includes(service), `${feature} anchored to ${service}`);
    }
    assert.equal(owners.some((service) => tier1.includes(service)), false, `${feature} must stay out of tier 1`);
  }
  // The plan's names resolve to the registry keys; there is one key per concept.
  assert.equal(vocab.canonicalFeatureKey('blog.posts'), 'blog');
  assert.equal(vocab.canonicalFeatureKey('blog.autoPosts'), 'blog.localPosts');
  assert.equal(vocab.canonicalFeatureKey('seo.linkNetwork'), 'seo.linkNetwork');
  const anchored = Object.values(vocab.SERVICE_FEATURE_ANCHORS).flat();
  for (const alias of Object.keys(vocab.FEATURE_KEY_ALIASES)) assert.equal(anchored.includes(alias), false, alias);
  const everyId = [
    ...vocab.SERVICE_IDS, ...vocab.ONE_TIME_ADDON_IDS, ...vocab.JOB_KINDS, ...vocab.STAGES,
    ...vocab.STAGE_OVERLAYS, ...vocab.EMAIL_KIND_IDS, ...Object.values(vocab.SETTINGS_KEYS),
    ...vocab.CANCELLATION_EFFECTS,
  ];
  assert.deepEqual(everyId.filter((id) => /standalone/i.test(id)), []);
  assert.equal(vocab.CANCELLATION_GRACE_DAYS, 30);
  assert.ok(vocab.CANCELLATION_EFFECTS.includes('backlink-network'));
  assert.ok(vocab.CANCELLATION_EFFECTS.includes('auto-posts'));
});

test('legacy flags from services match today for tier 2 and 3; tier 1 gains only the blog (owner Q19)', () => {
  assert.deepEqual(vocab.legacyFlagsForServices(vocab.servicesForTier('tier-2-seo')), featuresFromPlan('tier-2-seo'));
  assert.deepEqual(vocab.legacyFlagsForServices(vocab.servicesForTier('tier-3-ecommerce')), featuresFromPlan('tier-3-ecommerce'));
  assert.deepEqual(
    vocab.legacyFlagsForServices(vocab.servicesForTier('tier-1-standard')),
    { ...featuresFromPlan('tier-1-standard'), blog: true },
  );
  assert.deepEqual(vocab.legacyFlagsForServices([]), { ...featuresFromPlan('custom') });
  assert.equal(vocab.legacyFlagsForServices(['site', 'ecom']).ecommerce, true);
  assert.equal(vocab.legacyFlagsForServices(['catalog']).ecommerce, true);
  assert.deepEqual(Object.keys(vocab.legacyFlagsForServices(['site'])), [...vocab.LEGACY_FEATURE_FLAGS]);
});

test('stages, overlays and labels', () => {
  assert.equal(vocab.STAGES[0], 'lead');
  assert.ok(vocab.STAGES.indexOf('gate') < vocab.STAGES.indexOf('developing'));
  assert.ok(vocab.STAGES.indexOf('approved') < vocab.STAGES.indexOf('publishing'));
  for (const stage of [...vocab.STAGES, ...vocab.STAGE_OVERLAYS]) {
    assert.ok(vocab.STAGE_LABELS_NB[stage], `${stage} has no Norwegian label`);
  }
  assert.equal(vocab.isStage('paused'), false);
  assert.equal(vocab.isStageOverlay('paused'), true);
});

test('gate lines reference known services and carry no client-facing info lines', () => {
  for (const line of vocab.GATE_SERVICE_LINES) {
    for (const service of line.services) assert.ok(vocab.isServiceId(service), `${line.id}: ${service}`);
  }
  for (const line of vocab.GATE_PAGE_KIND_LINES) assert.ok(line.pageKinds.length > 0, line.id);
  assert.ok(vocab.isGateLineId('booking-services'));
  assert.ok(vocab.isGateLineId('blog-topics'));
  for (const info of vocab.GATE_INFO_LINES) assert.equal(vocab.isGateLineId(info), false, info);
  assert.deepEqual([...vocab.GATE_COLUMNS], ['dev', 'ready']);
  assert.deepEqual([...vocab.GATE_LINE_STATUSES], ['have', 'missing', 'waived', 'declined']);
});

test('email kinds and modes: no approve mode, legacy kinds are not release gated', () => {
  for (const kind of vocab.EMAIL_KINDS) assert.ok(['scheduling', 'service'].includes(kind.sender), kind.id);
  assert.deepEqual([...vocab.AUTOMATION_MODES], ['shadow', 'auto']);
  assert.equal(vocab.normalizeAutomationMode('approve'), 'shadow');
  assert.equal(vocab.normalizeAutomationMode('Manual'), 'shadow');
  assert.equal(vocab.normalizeAutomationMode('auto'), 'auto');
  assert.equal(vocab.normalizeAutomationMode('yolo'), '');
  for (const kind of vocab.EMAIL_KINDS.filter((entry) => entry.legacy)) {
    assert.equal(vocab.RELEASE_GATED_SWITCHES.includes(`emails.${kind.id}`), false, kind.id);
  }
  for (const kind of vocab.EMAIL_KINDS.filter((entry) => !entry.legacy)) {
    assert.ok(vocab.RELEASE_GATED_SWITCHES.includes(`emails.${kind.id}`), kind.id);
  }
  assert.ok(vocab.RELEASE_GATED_SWITCHES.includes('development.autoQueue'));
  assert.equal(vocab.emailSettingsPath('siteLive', 'mode'), 'emails.siteLive.mode');
});

test('the Maker imports the same vocabulary module (synced suite copy)', { skip: !existsSync(makerFile) && 'website-maker not checked out next to this repo' }, async () => {
  assert.equal(sha(makerFile), sha(sourceFile), 'run node scripts/sync-suite.mjs');
  const maker = await import(pathToFileURL(makerFile).href);
  assert.deepEqual(Object.keys(maker).sort(), Object.keys(vocab).sort());
  for (const key of Object.keys(vocab)) {
    if (typeof vocab[key] === 'function') continue;
    assert.deepEqual(maker[key], vocab[key], key);
  }
  assert.throws(() => maker.assertJobKind('change-request'), (error) => error.code === 'unknown-job-kind');
});

// WS8.45 deferred criterion: enqueueJob (WS8.26) and registerJobHandler (WS8.29) do not exist yet.
// Whichever file defines them must reject kinds outside JOB_KINDS with assertJobKind. This test
// stays green while nothing defines them and turns red when a definition skips the check.
const JOB_API_DEFINITION = /function\s*\*?\s*(?:enqueueJob|registerJobHandler)\s*\(|(?:const|let|var)\s+(?:enqueueJob|registerJobHandler)\s*=|^\s*(?:async\s+)?(?:enqueueJob|registerJobHandler)\s*\([^)]*\)\s*\{/m;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'build', 'dist', '.generated-runs']);

function sourceFiles(entry, out = []) {
  if (!existsSync(entry)) return out;
  if (statSync(entry).isFile()) {
    out.push(entry);
    return out;
  }
  for (const item of readdirSync(entry, { withFileTypes: true })) {
    if (SKIP_DIRS.has(item.name)) continue;
    const full = join(entry, item.name);
    if (item.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:m|c)?[jt]sx?$/.test(item.name) && !/\.test\.(?:m|c)?[jt]sx?$/.test(item.name)) out.push(full);
  }
  return out;
}

test('every definition of enqueueJob or registerJobHandler checks the kind with assertJobKind', () => {
  assert.ok(JOB_API_DEFINITION.test('export async function enqueueJob(kind, payload) {'));
  assert.ok(JOB_API_DEFINITION.test('const registerJobHandler = (kind, handler) => {}'));
  assert.ok(JOB_API_DEFINITION.test('  registerJobHandler(kind, handler) {'));
  assert.equal(JOB_API_DEFINITION.test('await enqueueJob("continue", {})'), false, 'a call is not a definition');
  assert.equal(JOB_API_DEFINITION.test('  enqueueJob("continue", payload);'), false, 'a call is not a definition');
  const files = ['lib', 'data', 'app', 'src', 'packages', 'scripts', 'server.js']
    .flatMap((entry) => sourceFiles(join(root, entry)))
    .filter((file) => file !== sourceFile);
  assert.ok(files.length > 20, `scanned ${files.length} files`);
  const missing = files.filter((file) => {
    const text = readFileSync(file, 'utf8');
    return JOB_API_DEFINITION.test(text) && !text.includes('assertJobKind');
  });
  assert.deepEqual(missing, []);
});
