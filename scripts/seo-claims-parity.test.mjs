// Claims data and checks (lib/seo-ops/claims). The JSON files are pinned by hash. When
// CLAIMS_PARITY_DIR points at the Maker's claims directory, those files and check.js (import
// lines aside) must match. Invented products only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIMS_DATA_FILES,
  checkClaims,
  checkPlanCompliance,
  defaultExtract,
  isRegulatedIndustry,
  screenKeywords,
  signOffPlanCompliance,
} from '../lib/seo-ops/claims/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const claimsDir = join(root, '..', 'lib', 'seo-ops', 'claims');
const hashes = JSON.parse(readFileSync(join(root, 'fixtures', 'seo-claims', 'data-hashes.json'), 'utf8'));

const NB_CREATINE = 'Kreatin øker fysisk prestasjon ved gjentatte korte perioder med høyintensiv trening';
const stub = (claims) => async () => ({ claims: claims.map((text) => ({ text })) });
const SUPP = 'kosttilskudd';
const SIGNED = {
  asoldi: { name: 'A. Reviewer', at: '2026-11-08T10:00:00.000Z' },
  client: { name: 'C. Owner', at: '2026-11-08T11:00:00.000Z' },
};

function lf(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** check.js logic, with import lines and the hub LLM adapter removed. */
function checkLogic(source) {
  let text = source.replace(/\r\n/g, '\n');
  text = text.replace(/async function hubClaimsDeps\(\) \{\n[\s\S]*?\n\}\n\n/, '');
  text = text.replace(/await hubClaimsDeps\(\)/g, 'await import("LLM")');
  text = text.replace(/await import\([^)]*\)/g, 'await import("LLM")');
  return text.split('\n').filter((line) => !/^\s*import\b/.test(line)).join('\n');
}

test('each claims JSON file matches its pinned hash', () => {
  assert.deepEqual(Object.keys(hashes).sort(), [...CLAIMS_DATA_FILES].sort());
  for (const name of CLAIMS_DATA_FILES) {
    assert.equal(sha256(lf(join(claimsDir, name))), hashes[name], name);
  }
});

test('CLAIMS_PARITY_DIR: JSON files match and check.js matches aside from its imports', { skip: !process.env.CLAIMS_PARITY_DIR && 'CLAIMS_PARITY_DIR is not set' }, () => {
  const dir = process.env.CLAIMS_PARITY_DIR;
  for (const name of CLAIMS_DATA_FILES) {
    assert.equal(lf(join(claimsDir, name)), lf(join(dir, name)), name);
  }
  assert.equal(checkLogic(lf(join(claimsDir, 'check.js'))), checkLogic(lf(join(dir, 'check.js'))));
});

test('melatonin keyword candidates are blocked', () => {
  const { kept, blocked } = screenKeywords(['melatonin tabletter', 'søvnrutine tips', { keyword: 'beste melatonin 3 mg' }]);
  assert.deepEqual(kept, ['søvnrutine tips']);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.every((row) => row.hits[0].kind === 'substance'));
});

test('a draft calling melatonin harmless is rejected, even when the extractor finds no claim', async () => {
  const result = await checkClaims('Melatonin er helt ufarlig for alle.', { industry: SUPP, extract: stub([]) });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((row) => row.code === 'regulated-substance'));
});

test('a creatine-against-dementia draft is rejected', async () => {
  const text = 'Kreatin hjelper mot demens.';
  const result = await checkClaims(text, { industry: SUPP, productFacts: { dailyDoseG: 5 }, extract: stub([text]) });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((row) => row.code === 'disease-claim' && row.detail === 'demens'));
});

test('a creatine performance statement passes only with the authorised wording and a dose of at least 3 g', async () => {
  const ok = await checkClaims(`${NB_CREATINE}.`, { industry: SUPP, productFacts: { dailyDoseG: 3 }, extract: stub([NB_CREATINE]) });
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
  assert.equal(ok.claims[0].status, 'authorised');

  const lowDose = await checkClaims(NB_CREATINE, { industry: SUPP, productFacts: { dailyDoseG: 2 }, extract: stub([NB_CREATINE]) });
  assert.equal(lowDose.ok, false);
  assert.equal(lowDose.reasons[0].code, 'condition-unmet');

  const reworded = 'Kreatin gir deg enorm styrke og store muskler';
  const bad = await checkClaims(reworded, { industry: SUPP, productFacts: { dailyDoseG: 5 }, extract: stub([reworded]) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasons[0].code, 'unauthorised-claim');
});

test('an extractor that throws rejects (fail closed)', async () => {
  const result = await checkClaims('Vi selger kaffe.', { industry: 'kafe', extract: async () => { throw new Error('down'); } });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.at(-1).code, 'extractor-error');
  const clean = await checkClaims('Vi selger kaffe.', { industry: 'kafe', extract: stub([]) });
  assert.equal(clean.ok, true);
});

test('defaultExtract stays fail-closed for an injected pipeline and for the hub facade', async () => {
  const deps = (pipelineJson) => ({ pipelineAvailable: () => true, pipelineJson });
  await assert.rejects(() => defaultExtract('Hei.', { pipelineAvailable: () => false, pipelineJson: async () => { throw new Error('should not be called'); } }));
  await assert.rejects(() => defaultExtract('Hei.', deps(async () => ({ provider: '', text: '{"claims":[]}' }))));
  await assert.rejects(() => defaultExtract('Hei.', deps(async () => ({ provider: 'example', text: 'not json' }))));
  await assert.rejects(() => defaultExtract('Hei.', deps(async () => ({ provider: 'example', stopReason: 'max_tokens', text: '{"claims":[]}' }))));
  const parsed = await defaultExtract('Hei.', deps(async () => ({ provider: 'example', stopReason: 'end_turn', text: '```json\n{"claims":[{"text":"Hei"}]}\n```' })));
  assert.deepEqual(parsed, { claims: [{ text: 'Hei' }] });
  await assert.rejects(() => defaultExtract('Hei.'), /no provider for the claims extractor/);
});

test('a plan with a regulated substance is rejected, and a regulated industry needs both sign-offs', () => {
  const substance = { seeds: ['melatonin'], compliance: SIGNED };
  assert.equal(checkPlanCompliance(substance, { industry: SUPP }).ok, false);
  assert.ok(checkPlanCompliance(substance, { industry: SUPP }).reasons.some((row) => row.code === 'regulated-substance'));

  assert.equal(isRegulatedIndustry(SUPP), true);
  const plan = { seeds: ['protein'] };
  assert.equal(checkPlanCompliance(plan, { industry: SUPP }).ok, false);
  assert.equal(checkPlanCompliance(plan, { industry: SUPP }).reasons[0].code, 'compliance-signoff-missing');
  assert.equal(checkPlanCompliance({ ...plan, compliance: { asoldi: SIGNED.asoldi } }, { industry: SUPP }).ok, false);
  assert.equal(checkPlanCompliance({ ...plan, compliance: SIGNED }, { industry: SUPP }).ok, true);
  assert.equal(checkPlanCompliance({ seeds: ['frisør'] }, { industry: 'frisør' }).ok, true);
});

test('signOffPlanCompliance writes one party and leaves the other intact', () => {
  const plan = { seeds: ['protein'], compliance: { client: { ...SIGNED.client } } };
  const next = signOffPlanCompliance(plan, { party: 'asoldi', name: '  A. Reviewer  ', at: '2026-11-08T10:00:00Z' });
  assert.equal(plan.compliance.asoldi, undefined, 'the input plan is not changed');
  assert.deepEqual(next.compliance.client, SIGNED.client);
  assert.deepEqual(next.compliance.asoldi, { name: 'A. Reviewer', at: '2026-11-08T10:00:00.000Z' });
  assert.equal(next.seeds, plan.seeds);
  assert.equal(checkPlanCompliance(next, { industry: SUPP }).ok, true);

  const again = signOffPlanCompliance(next, { party: 'client', name: 'C. Owner', at: '2026-11-08T11:00:00.000Z' });
  assert.deepEqual(again.compliance.asoldi, next.compliance.asoldi);
  assert.equal(again.compliance.client.at, '2026-11-08T11:00:00.000Z');

  assert.throws(() => signOffPlanCompliance(plan, { party: 'other', name: 'A. Reviewer', at: '2026-11-08T10:00:00Z' }));
  assert.throws(() => signOffPlanCompliance(plan, { party: 'asoldi', name: '   ', at: '2026-11-08T10:00:00Z' }));
  assert.throws(() => signOffPlanCompliance(plan, { party: 'asoldi', name: 'A'.repeat(121), at: '2026-11-08T10:00:00Z' }));
  assert.throws(() => signOffPlanCompliance(plan, { party: 'asoldi', name: 'A. Reviewer', at: 'not a time' }));
  assert.throws(() => signOffPlanCompliance(plan, { party: 'asoldi', name: 'A. Reviewer', at: '2026-11-08' }));
  assert.equal(signOffPlanCompliance(plan, { party: 'client', name: 'C'.repeat(120), at: '2026-11-08T11:00:00Z' }).compliance.client.name.length, 120);
});

test('a reworded claim that reverses or changes the register wording is not authorised', async () => {
  const facts = { dailyDoseG: 3 };
  const run = (s) => checkClaims(s, { industry: SUPP, productFacts: facts, extract: stub([s]) });
  assert.equal((await run(NB_CREATINE)).ok, true);
  for (const s of [
    'Kreatin reduserer fysisk prestasjon ved gjentatte korte perioder med høyintensiv trening',
    'Kreatin øker fysisk prestasjon ved gjentatte korte perioder med lavintensiv trening',
    'Kreatin øker mental prestasjon ved gjentatte korte perioder med høyintensiv trening',
    'Creatine decreases physical performance in successive bursts of short-term, high intensity exercise',
    'Magnesium bidrar til å øke tretthet og utmattelse',
  ]) {
    const out = await run(s);
    assert.equal(out.ok, false, s);
    assert.equal(out.claims[0].status, 'unauthorised', s);
  }
});

test('format characters and full-width letters do not hide a regulated substance', async () => {
  for (const s of ['mela\u00adtonin er trygt', 'mela\u200btonin er trygt', '\uff4d\uff45\uff4c\uff41\uff54\uff4f\uff4e\uff49\uff4e er trygt']) {
    const out = await checkClaims(s, { industry: SUPP, extract: async () => ({ claims: [] }) });
    assert.equal(out.ok, false, s);
  }
});

test('a plan with a string field or object entries does not throw', () => {
  const out = checkPlanCompliance({ primary: 'melatonin kosttilskudd', byRole: { a: [{ keyword: 'melatonin' }] } }, { industry: SUPP });
  assert.equal(out.ok, false);
  assert.ok(out.reasons.some((r) => r.code === 'regulated-substance'));
});
