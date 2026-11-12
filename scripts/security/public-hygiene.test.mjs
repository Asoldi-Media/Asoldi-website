// Public-repo hygiene: the planning-word rule, names, profiles, fixture values, the --commits,
// --workspace and --redact modes, the offender-list ratchet, the hooks, and the two cleanup
// scripts (planning words in comments, docs and test titles; client data in tests and docs).
// Every repo and folder here is a temp copy; nothing touches this checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as lib from './secret-scan-lib.mjs';
import { listRepoFiles, loadProfileConfig, main as scanMain, ratchetReport } from './secret-scan.mjs';
import { HOOKS } from './install-git-hooks.mjs';
import * as codemod from './neutralize-plan-ids.mjs';
import * as scrub from './scrub-client-data.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// Planning words are built at run time, so this file holds none of them as text.
const P = String.fromCharCode(87, 83);
const id = (area, task) => (task === undefined ? `${P}${area}` : `${P}${area}.${task}`);
const BATCH = ['Wa', 've 2'].join('');
const BRANCH = ['wf', '/w3-something'].join('');
const STREAM = ['work', 'stream'].join('');
const PLAN_FILE = ['MASTER', '-PLAN.md'].join('');
// Built at run time too, so a copy of this file elsewhere holds no key-shaped text.
const FAKE_ANTHROPIC = ['sk-ant-', 'api03-FAKEfakeFAKE1234567890abcdefTEST'].join('');

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = tempDir('asoldi-hygiene-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Hygiene Test']);
  git(dir, ['config', 'user.email', 'hygiene@example.com']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const NO_ENV = (dir) => ({ SECRET_SCAN_ENV_FILES: '', ASOLDI_RETIRED_SECRETS: join(dir, 'none.json'), SECRET_SCAN_NAMES: join(dir, 'no-names.txt') });

async function runScan(argv, { cwd, env, stdinText } = {}) {
  const lines = [];
  const saved = { log: console.log, error: console.error, write: process.stdout.write };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const code = await scanMain(argv, { cwd, env, stdinText });
    return { code, out: lines.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
  }
}

function quiet(fn) {
  const saved = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = saved;
  }
}

const planRules = (text, path = 'a.js') => lib.scanLines(path, lib.splitLines(text), { profile: { secrets: false, pii: false, plan: true } }).map((f) => `${f.line}:${f.rule}`);

// ------------------------------------------------------------------------- rules

test('planning words: task and area ids, batch and branch names, the streams word and planning file names', () => {
  const text = [
    `// ${id(8, 3)} and ${id(0, '27b')} and ${id(6)}`,
    `${BATCH} lands`,
    `merged ${BRANCH}`,
    `other ${STREAM}s`,
    `see ${PLAN_FILE} and the ${['K-PHASE', 'TASKS'].join('-')}.md list`,
    `const ${P}_TOTAL = 1; const x${P}8 = 2; /* ${P}2812B led */ wave of updates; workflow; microwave 2`,
  ].join('\n');
  assert.deepEqual(planRules(text), ['1:plan-id', '1:plan-id', '1:plan-id', '2:plan-batch', '3:plan-branch', '4:plan-word', '5:plan-file', '5:plan-file']);
});

test('every file of the scan tools, their lists and their tests holds no planning word as text', () => {
  const dir = join(repoRoot, 'scripts', 'security');
  const files = readdirSync(dir).filter((name) => /\.(?:[cm]?js|json|md|txt)$/.test(name));
  assert.ok(files.includes('secret-scan.test.mjs') && files.includes('probe-hub.test.mjs') && files.includes('plan-id-offenders.json'));
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.deepEqual(planRules(text, file), [], file);
  }
});

test('a names file: whole words in any case, the names-file line in the finding and never the name', async () => {
  const matcher = lib.buildNamesMatcher('# client names\nFjordbakeriet\nOla  Strandvik\nab\n');
  const findings = lib.scanLines('docs/a.md', lib.splitLines('Hei fra FJORDBAKERIET.\nola strandvik ringte\nfjordbakerietene og Fjordbakeriet2'), { names: matcher });
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}:${f.hint}`), ['1:listed-name:names file line 2', '2:listed-name:names file line 3']);
  assert.equal(JSON.stringify(findings).toLowerCase().includes('fjordbakeriet'), false);

  const dir = makeRepo();
  write(dir, 'names.txt', 'Fjordbakeriet\n');
  write(dir, 'a.md', 'Fjordbakeriet\n');
  git(dir, ['add', 'names.txt', 'a.md']);
  await assert.rejects(runScan(['--tracked', '--names', 'names.txt'], { cwd: dir, env: NO_ENV(dir) }), /tracked in this repo/);
  const outside = join(tempDir('asoldi-names-'), 'names.txt');
  writeFileSync(outside, 'Fjordbakeriet\n');
  const result = await runScan(['--tracked', '--names', outside], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(result.code, 1);
  assert.match(result.out, /a\.md:1 {2}listed-name {2}\(names file line 1\)/);
  assert.equal(result.out.includes('Fjordbakeriet'), false);
});

test('the private profile reports secrets and secret paths only; the public profile also client data, planning words and every blocked path', () => {
  const text = `const k = '${FAKE_ANTHROPIC.replace('FAKEfakeFAKE', 'Q7x')}';\n// ${id(8, 3)} ola.nordmann@kunde-firma.no +47 958 61 302`;
  const pub = lib.scanLines('src/a.js', lib.splitLines(text), { profile: 'public' }).map((f) => f.rule).sort();
  const priv = lib.scanLines('src/a.js', lib.splitLines(text), { profile: 'private' }).map((f) => f.rule).sort();
  assert.deepEqual(pub, ['anthropic-key', 'email', 'phone', 'plan-id']);
  assert.deepEqual(priv, ['anthropic-key']);
  assert.equal(lib.blockedPathRule('docs/daily-logs/a.md', 'private'), '');
  assert.equal(lib.blockedPathRule('fixtures-private/a.json', 'private'), '');
  assert.equal(lib.blockedPathRule('.env', 'private'), 'env-file');
  assert.equal(lib.blockedPathRule('config/x.pem', 'private'), 'key-file');
  assert.equal(lib.blockedPathRule('notes.txt.bak-redact', 'private'), 'redact-backup');
  assert.equal(lib.blockedPathRule('docs/daily-logs/a.md', 'public'), 'daily-log');
  assert.throws(() => lib.resolveProfile('loose'), /unknown scan profile/);
});

test('fixture values: one exact value passes by its hash, any other value in the same file is still reported', () => {
  const fixture = 'legacy-first-admin-pw-17Qz';
  const other = `Q${randomBytes(12).toString('hex')}9z`;
  const allowlist = lib.normalizeAllowlist({
    fixtureValues: [
      { path: 'test/*.test.js', rule: 'secret-assignment', sha256: lib.sha256Hex(fixture), reason: 'the password a legacy sign-in test signs in with' },
      { path: 'test/*.test.js', rule: 'known-value', sha256: lib.sha256Hex(fixture), reason: 'never allowed' },
      { path: 'test/*.test.js', rule: 'secret-assignment', sha256: 'abc', reason: 'not a sha256' },
    ],
  });
  assert.equal(allowlist.fixtureValues.length, 1);
  const lines = lib.splitLines(`const LEGACY_PASSWORD = '${fixture}';\nconst ADMIN_PASSWORD = '${other}';`);
  assert.deepEqual(lib.scanLines('test/a.test.js', lines, { allowlist }).map((f) => `${f.line}:${f.rule}`), ['2:secret-assignment']);
  assert.deepEqual(lib.scanLines('src/a.js', lines, { allowlist }).map((f) => `${f.line}:${f.rule}`), ['1:secret-assignment', '2:secret-assignment']);
});

test("a '*' entry covers secrets only; client data and planning words need an entry naming the rule, and one contact can be allowed by value in one file", () => {
  const text = `const k = '${FAKE_ANTHROPIC}';\n// ${id(8, 3)} ola.nordmann@kunde-firma.no +47 958 61 302`;
  const star = lib.normalizeAllowlist({ entries: [{ path: 'tests/*.test.mjs', rule: '*', reason: 'scanner fixtures' }] });
  assert.deepEqual(lib.scanLines('tests/a.test.mjs', lib.splitLines(text), { allowlist: star }).map((f) => f.rule).sort(), ['email', 'phone', 'plan-id']);
  const named = lib.normalizeAllowlist({
    entries: [
      { path: 'tests/*.test.mjs', rule: '*', reason: 'scanner fixtures' },
      { path: 'tests/a.test.mjs', rule: 'email', reason: 'made-up addresses' },
      { path: 'tests/a.test.mjs', rule: 'phone', reason: 'made-up numbers' },
      { path: 'tests/a.test.mjs', rule: 'plan-id', reason: 'rule samples' },
    ],
  });
  assert.deepEqual(lib.scanLines('tests/a.test.mjs', lib.splitLines(text), { allowlist: named }), []);

  const contact = lib.normalizeAllowlist({
    fixtureValues: [
      { path: 'lib/booker.js', rule: 'email', sha256: lib.sha256Hex('kari.booker@kundepost.no'), reason: 'the address the booker code matches' },
      { path: 'lib/booker.js', rule: 'phone', sha256: lib.sha256Hex('95861302'), reason: 'the number the booker code prints' },
    ],
  });
  const source = "const BOOKER = 'Kari.Booker@Kundepost.no'; // tlf +47 958 61 302\nconst OTHER = 'per.booker@kundepost.no';";
  assert.deepEqual(lib.scanLines('lib/booker.js', lib.splitLines(source), { allowlist: contact }).map((f) => `${f.line}:${f.rule}`), ['2:email']);
  assert.deepEqual(lib.scanLines('scripts/booker.test.mjs', lib.splitLines(source), { allowlist: contact }).map((f) => `${f.line}:${f.rule}`), ['1:email', '1:phone', '2:email'], 'only in its own file');

  assert.deepEqual(lib.broadDataEntries(lib.normalizeAllowlist({
    entries: [
      { path: 'docs/*.md', rule: 'email', reason: 'x' },
      { path: 'docs/a.md', rule: 'email', reason: 'x' },
      { path: '**', rule: '*', reason: 'x' },
      { path: 'notes/**', rule: 'plan-id', reason: 'x' },
    ],
  })), [{ path: 'docs/*.md', rule: 'email' }, { path: 'notes/**', rule: 'plan-id' }]);

  const base = { entries: [{ path: 'tests/*.test.mjs', rule: '*', reason: 'x' }], emails: ['a@kunde.no'] };
  assert.deepEqual(lib.allowlistWidening(base, base), []);
  assert.deepEqual(lib.allowlistWidening(base, {
    ...base,
    emails: ['a@kunde.no', 'b@kunde.no'],
    entries: [...base.entries, { path: 'src/a.js', rule: 'secret-assignment', reason: 'one file, values must look fake' }],
    fixtureValues: [{ path: 'lib/*.js', rule: 'email', sha256: lib.sha256Hex('c@kunde.no'), reason: 'one value' }],
  }), [], 'exact values and one-file secret entries are not broader');
  assert.deepEqual(lib.allowlistWidening(base, {
    ...base,
    entries: [...base.entries, { path: '**', rule: '*', reason: 'x' }, { path: 'docs/*.md', rule: 'email', reason: 'x' }, { path: 'src/a.js', rule: 'plan-id', reason: 'x' }],
    emailDomains: ['kunde.no'],
  }), ['new entry: rule * on **', 'new entry: rule email on docs/*.md', 'new entry: rule plan-id on src/a.js', '1 new allowed e-mail domain(s)']);
});

// ------------------------------------------------------------------------- git modes

test('--commits reads the message of every commit in the range, merge commits included', async () => {
  const dir = makeRepo();
  write(dir, 'a.js', 'export const a = 1;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-b', 'side']);
  write(dir, 'b.js', 'export const b = 1;\n');
  git(dir, ['add', 'b.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'Add b']);
  git(dir, ['checkout', '-q', 'main']);
  write(dir, 'c.js', 'export const c = 1;\n');
  git(dir, ['add', 'c.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'Add c']);
  const clean = await runScan(['--commits', `${base}..HEAD`], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(clean.code, 0, clean.out);
  git(dir, ['merge', '-q', '--no-ff', '--no-verify', '-m', `Merge side into ${BATCH} (${id(8, 3)})`, 'side']);
  const merge = git(dir, ['rev-parse', 'HEAD']).trim();
  const dirty = await runScan(['--commits', `${base}..HEAD`], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, new RegExp(`${merge.slice(0, 10)}:commit-message:1 {2}plan-batch`));
  assert.match(dirty.out, new RegExp(`${merge.slice(0, 10)}:commit-message:1 {2}plan-id`));
  // The private profile has no planning rule.
  const priv = await runScan(['--commits', `${base}..HEAD`, '--profile', 'private'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(priv.code, 0, priv.out);
});

test('--pre-push: planning words count in every pushed commit unless the net-diff switch is set, which lists what it lets through', async () => {
  const dir = makeRepo();
  write(dir, 'a.js', 'export const a = 1;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  write(dir, 'a.js', `export const a = 1; // ${id(8, 3)}\n`);
  git(dir, ['commit', '-q', '--no-verify', '-am', 'note']);
  const noted = git(dir, ['rev-parse', 'HEAD']).trim();
  write(dir, 'a.js', 'export const a = 1; // site plan\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'reword the note']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const stdin = (sha) => `refs/heads/main ${sha} refs/heads/main ${base}\n`;
  // A word one pushed commit adds and a later one rewords is still published in history: refused.
  const reworded = await runScan(['--pre-push'], { cwd: dir, env: NO_ENV(dir), stdinText: stdin(head) });
  assert.equal(reworded.code, 1, reworded.out);
  assert.match(reworded.out, new RegExp(`${noted.slice(0, 10)}:a\\.js:1 {2}plan-id`));
  // Only when the switch is set on purpose does the pushed result count, and the scan says what it let through.
  const net = await runScan(['--pre-push'], { cwd: dir, env: { ...NO_ENV(dir), SECRET_SCAN_PLAN_NET_DIFF: '1' }, stdinText: stdin(head) });
  assert.equal(net.code, 0, net.out);
  assert.match(net.out, new RegExp(`let through by SECRET_SCAN_PLAN_NET_DIFF.*${noted.slice(0, 10)}:a\\.js:1 plan-id`));
  assert.equal((await runScan(['--pre-push', '--plan-net-diff'], { cwd: dir, env: NO_ENV(dir), stdinText: stdin(head) })).code, 0);

  write(dir, 'b.js', `export const b = 2; // ${id(6, 7)}\n`);
  git(dir, ['add', 'b.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'add b']);
  const kept = await runScan(['--pre-push'], { cwd: dir, env: NO_ENV(dir), stdinText: stdin(git(dir, ['rev-parse', 'HEAD']).trim()) });
  assert.equal(kept.code, 1);
  assert.match(kept.out, /:b\.js:1 {2}plan-id/);
  git(dir, ['reset', '-q', '--hard', head]);

  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `Finish ${id(9, 46)}`]);
  const message = await runScan(['--pre-push'], { cwd: dir, env: NO_ENV(dir), stdinText: stdin(git(dir, ['rev-parse', 'HEAD']).trim()) });
  assert.equal(message.code, 1);
  assert.match(message.out, /:commit-message:1 {2}plan-id/);
  git(dir, ['reset', '-q', '--hard', head]);

  write(dir, 'c.js', `export const k = '${FAKE_ANTHROPIC}';\n`);
  git(dir, ['add', 'c.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'add c']);
  git(dir, ['rm', '-q', 'c.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'remove c']);
  const secret = await runScan(['--pre-push'], { cwd: dir, env: NO_ENV(dir), stdinText: stdin(git(dir, ['rev-parse', 'HEAD']).trim()) });
  assert.equal(secret.code, 1);
  assert.match(secret.out, /:c\.js:1 {2}anthropic-key/);
  assert.equal(secret.out.includes(FAKE_ANTHROPIC), false);
});

test('--pre-push: a tag or a new branch at a commit already on a remote passes, and an annotated tag message is scanned', async () => {
  const dir = makeRepo();
  // Older history that is already public and still has a planning word in a file.
  write(dir, 'old.js', `// ${id(8, 3)}\nexport const a = 1;\n`);
  git(dir, ['add', 'old.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'old']);
  const pushed = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', pushed]);
  const zero = '0'.repeat(40);
  for (const env of [NO_ENV(dir), { ...NO_ENV(dir), SECRET_SCAN_PLAN_NET_DIFF: '1' }]) {
    git(dir, ['tag', '-f', '-a', 'v1.0.0', '-m', 'Release 1.0.0 with the new booking page', pushed]);
    const tag = git(dir, ['rev-parse', 'v1.0.0']).trim();
    const tagPush = await runScan(['--pre-push'], { cwd: dir, env, stdinText: `refs/tags/v1.0.0 ${tag} refs/tags/v1.0.0 ${zero}\n` });
    assert.equal(tagPush.code, 0, tagPush.out);
    const branchPush = await runScan(['--pre-push'], { cwd: dir, env, stdinText: `refs/heads/release ${pushed} refs/heads/release ${zero}\n` });
    assert.equal(branchPush.code, 0, branchPush.out);

    git(dir, ['tag', '-f', '-a', 'v1.0.1', '-m', `Release 1.0.1\n\nShips ${id(8, 3)} and ${BATCH}.`, pushed]);
    const dirtyTag = git(dir, ['rev-parse', 'v1.0.1']).trim();
    const refused = await runScan(['--pre-push'], { cwd: dir, env, stdinText: `refs/tags/v1.0.1 ${dirtyTag} refs/tags/v1.0.1 ${zero}\n` });
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`${dirtyTag.slice(0, 10)}:tag-message:3 {2}plan-id`));
    assert.match(refused.out, new RegExp(`${dirtyTag.slice(0, 10)}:tag-message:3 {2}plan-batch`));
  }
  // A lightweight tag has no message of its own.
  git(dir, ['tag', 'light', pushed]);
  assert.equal((await runScan(['--pre-push'], { cwd: dir, env: NO_ENV(dir), stdinText: `refs/tags/light ${pushed} refs/tags/light ${zero}\n` })).code, 0);
});

test('--staged: a repo whose committed profile is public keeps the public rules, and a staged weaker profile is refused', async () => {
  const dir = makeRepo();
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'public' }));
  write(dir, 'a.js', 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'private' }));
  write(dir, 'b.js', `// ${id(8, 3)}\nexport const b = 1;\n`);
  git(dir, ['add', '-A']);
  const weakened = await runScan(['--staged'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(weakened.code, 1, weakened.out);
  assert.match(weakened.out, /scripts\/security\/scan-profile\.json {2}path:profile-weakened/);
  assert.match(weakened.out, /b\.js:1 {2}plan-id/, 'the public rules still apply to the commit that changes the profile');

  // A repo whose committed profile is private keeps its own rules.
  const priv = makeRepo();
  write(priv, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'private' }));
  git(priv, ['add', '-A']);
  git(priv, ['commit', '-q', '--no-verify', '-m', 'base']);
  write(priv, 'b.js', `// ${id(8, 3)}\nexport const b = 1;\n`);
  git(priv, ['add', '-A']);
  assert.equal((await runScan(['--staged'], { cwd: priv, env: NO_ENV(priv) })).code, 0);
});

const ALLOW_FILE = '.secret-scan-allowlist.json';
const allowJson = (extra = {}) => JSON.stringify({ entries: [{ path: 'tests/*.test.mjs', rule: '*', reason: 'scanner fixtures' }], ...extra });

test('--staged in a public repo: the staged allowlist counts, not the working tree, and a broader allowlist is refused unless the switch lists it', async () => {
  const dir = makeRepo();
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'public' }));
  write(dir, ALLOW_FILE, allowJson());
  write(dir, 'a.js', 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const env = NO_ENV(dir);

  // An allowlist changed in the working tree only lets nothing through.
  write(dir, ALLOW_FILE, allowJson({ emails: ['ola.nordmann@kunde-firma.no'] }));
  write(dir, 'b.js', "export const b = 'ola.nordmann@kunde-firma.no';\n");
  git(dir, ['add', 'b.js']);
  const unstaged = await runScan(['--staged'], { cwd: dir, env });
  assert.equal(unstaged.code, 1, unstaged.out);
  assert.match(unstaged.out, /^b\.js:1 {2}email$/m);
  // Staged with the value: one exact value is not broader, so it passes.
  git(dir, ['add', ALLOW_FILE]);
  const exact = await runScan(['--staged'], { cwd: dir, env });
  assert.equal(exact.code, 0, exact.out);
  // An entry for a client-data rule hides every such finding in its file: refused, even on one file.
  write(dir, ALLOW_FILE, JSON.stringify({ entries: [{ path: 'tests/*.test.mjs', rule: '*', reason: 'scanner fixtures' }, { path: 'b.js', rule: 'email', reason: 'one file' }] }));
  git(dir, ['add', ALLOW_FILE]);
  const oneFile = await runScan(['--staged'], { cwd: dir, env });
  assert.equal(oneFile.code, 1, oneFile.out);
  assert.match(oneFile.out, /^\.secret-scan-allowlist\.json {2}path:allowlist-widened {2}\(new entry: rule email on b\.js\)$/m);
  assert.doesNotMatch(oneFile.out, /^b\.js:1 {2}email$/m, 'the staged allowlist still applies to the staged lines');

  // A new '*' entry, a glob for a client-data rule and a new domain are refused; the '*' entry does not hide client data or planning words either.
  write(dir, ALLOW_FILE, JSON.stringify({
    entries: [
      { path: 'tests/*.test.mjs', rule: '*', reason: 'scanner fixtures' },
      { path: '**', rule: '*', reason: 'everything' },
      { path: 'docs/*.md', rule: 'email', reason: 'docs' },
    ],
    emails: ['ola.nordmann@kunde-firma.no'],
    emailDomains: ['kunde-firma.no'],
  }));
  write(dir, 'c.js', `// ${id(8, 3)}\nexport const c = 'kari@annen-kunde.no';\n`);
  git(dir, ['add', '-A']);
  const widened = await runScan(['--staged'], { cwd: dir, env });
  assert.equal(widened.code, 1, widened.out);
  assert.match(widened.out, /^\.secret-scan-allowlist\.json {2}path:allowlist-widened {2}\(new entry: rule \* on \*\*\)$/m);
  assert.match(widened.out, /^\.secret-scan-allowlist\.json {2}path:allowlist-widened {2}\(new entry: rule email on docs\/\*\.md\)$/m);
  assert.match(widened.out, /^\.secret-scan-allowlist\.json {2}path:allowlist-widened {2}\(1 new allowed e-mail domain\(s\)\)$/m);
  assert.match(widened.out, /^c\.js:1 {2}plan-id$/m);
  assert.match(widened.out, /^c\.js:2 {2}email$/m);
  // The switch lets the broader allowlist through and says so; the rules still apply to the lines.
  const switched = await runScan(['--staged'], { cwd: dir, env: { ...env, SECRET_SCAN_ALLOWLIST_WIDEN: '1' } });
  assert.equal(switched.code, 1);
  assert.doesNotMatch(switched.out, /allowlist-widened/);
  assert.match(switched.out, /a broader allowlist let through by SECRET_SCAN_ALLOWLIST_WIDEN: \.secret-scan-allowlist\.json: new entry: rule \* on \*\*/);
  assert.match(switched.out, /^c\.js:1 {2}plan-id$/m);

  // The commit that adds the allowlist file adopts the scan: there is nothing to compare it with.
  const fresh = makeRepo();
  write(fresh, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'public' }));
  write(fresh, 'a.js', 'export const a = 1;\n');
  git(fresh, ['add', '-A']);
  git(fresh, ['commit', '-q', '--no-verify', '-m', 'base']);
  write(fresh, ALLOW_FILE, allowJson());
  git(fresh, ['add', ALLOW_FILE]);
  const adopted = await runScan(['--staged'], { cwd: fresh, env: NO_ENV(fresh) });
  assert.equal(adopted.code, 0, adopted.out);
});

test('--pre-push takes the profile and the allowlist from the pushed commit, not the working tree, and refuses a weaker profile or a broader allowlist', async () => {
  const dir = makeRepo();
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'public' }));
  write(dir, ALLOW_FILE, allowJson());
  write(dir, 'a.js', 'export const a = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
  const env = NO_ENV(dir);
  const stdin = (sha) => `refs/heads/main ${sha} refs/heads/main ${base}\n`;

  // A pushed commit that widens the allowlist and adds client data and a planning word.
  write(dir, ALLOW_FILE, JSON.stringify({ entries: [{ path: 'tests/*.test.mjs', rule: '*', reason: 'x' }, { path: 'src/*.js', rule: 'email', reason: 'x' }] }));
  write(dir, 'src/d.js', `// ${id(8, 3)}\nexport const d = 'kari@annen-kunde.no';\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'add d']);
  const wide = git(dir, ['rev-parse', 'HEAD']).trim();
  // The working tree says private and allows everything; neither is committed, so neither counts.
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'private' }));
  write(dir, ALLOW_FILE, JSON.stringify({ entries: [{ path: '**', rule: 'plan-id', reason: 'x' }], emailDomains: ['annen-kunde.no'] }));
  const pushed = await runScan(['--pre-push'], { cwd: dir, env, stdinText: stdin(wide) });
  assert.equal(pushed.code, 1, pushed.out);
  assert.match(pushed.out, new RegExp(`^${wide.slice(0, 10)}:\\.secret-scan-allowlist\\.json {2}path:allowlist-widened {2}\\(new entry: rule email on src/\\*\\.js\\)$`, 'm'));
  assert.match(pushed.out, new RegExp(`^${wide.slice(0, 10)}:src/d\\.js:1 {2}plan-id$`, 'm'));
  assert.doesNotMatch(pushed.out, /src\/d\.js:2 {2}email/, 'the pushed allowlist itself still applies to its own commit');
  const switched = await runScan(['--pre-push'], { cwd: dir, env: { ...env, SECRET_SCAN_ALLOWLIST_WIDEN: '1' }, stdinText: stdin(wide) });
  assert.doesNotMatch(switched.out, /allowlist-widened/);
  assert.match(switched.out, /let through by SECRET_SCAN_ALLOWLIST_WIDEN/);
  git(dir, ['checkout', '-q', '--', '.']);

  // A pushed commit that weakens the profile is refused, and the public rules still apply to it.
  git(dir, ['reset', '-q', '--hard', base]);
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'private' }));
  write(dir, 'e.js', `// ${id(8, 3)}\nexport const e = 1;\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'add e']);
  const weak = git(dir, ['rev-parse', 'HEAD']).trim();
  const weakened = await runScan(['--pre-push'], { cwd: dir, env, stdinText: stdin(weak) });
  assert.equal(weakened.code, 1, weakened.out);
  assert.match(weakened.out, new RegExp(`^${weak.slice(0, 10)}:scripts/security/scan-profile\\.json {2}path:profile-weakened`, 'm'));
  assert.match(weakened.out, new RegExp(`^${weak.slice(0, 10)}:e\\.js:1 {2}plan-id$`, 'm'));

  // Remote history without a profile file pins nothing: a private repo that adopts the file keeps its own rules.
  const priv = makeRepo();
  write(priv, 'a.js', 'export const a = 1;\n');
  git(priv, ['add', '-A']);
  git(priv, ['commit', '-q', '--no-verify', '-m', 'base']);
  const privBase = git(priv, ['rev-parse', 'HEAD']).trim();
  git(priv, ['update-ref', 'refs/remotes/origin/main', privBase]);
  write(priv, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'private' }));
  write(priv, 'fixture.json', JSON.stringify({ client: 'kari@kunde-firma.no', note: id(8, 3) }));
  git(priv, ['add', '-A']);
  git(priv, ['commit', '-q', '--no-verify', '-m', 'adopt the scan']);
  const adopted = await runScan(['--pre-push'], { cwd: priv, env: NO_ENV(priv), stdinText: `refs/heads/main ${git(priv, ['rev-parse', 'HEAD']).trim()} refs/heads/main ${privBase}\n` });
  assert.equal(adopted.code, 0, adopted.out);
});

test('this public repo pins the public profile', () => {
  assert.equal(loadProfileConfig(repoRoot).profile.name, 'public');
});

// ------------------------------------------------------------------------- folders without git

test('--workspace scans a folder without git, and prints paths relative to it and no values', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-workspace-');
  write(dir, 'notes/a.md', `kontakt ola.nordmann@kunde-firma.no\n${id(8, 3)}\n`);
  write(dir, 'deep/b.json', `{"key": "${FAKE_ANTHROPIC}"}\n`);
  write(dir, 'node_modules/x/c.js', `const k = '${FAKE_ANTHROPIC}';\n`);
  write(dir, '.env', 'X=1\n');
  const result = await runScan(['--workspace', dir], { cwd, env: NO_ENV(cwd) });
  assert.equal(result.code, 1);
  assert.match(result.out, /^notes\/a\.md:1 {2}email$/m);
  assert.match(result.out, /^notes\/a\.md:2 {2}plan-id$/m);
  assert.match(result.out, /^deep\/b\.json:1 {2}anthropic-key$/m);
  assert.match(result.out, /^\.env {2}path:env-file$/m);
  assert.doesNotMatch(result.out, /node_modules\/x/, 'node_modules is listed as not scanned, never read');
  assert.match(result.out, /^node_modules\/ {2}not scanned: installed dependencies$/m);
  assert.equal(result.out.includes(FAKE_ANTHROPIC), false);
  const priv = await runScan(['--workspace', dir, '--profile', 'private'], { cwd, env: NO_ENV(cwd) });
  assert.doesNotMatch(priv.out, /email|plan-id/);
  assert.match(priv.out, /anthropic-key/);
});

test('--redact is a dry run by default; --apply keeps each original once outside the folder and removes private keys whole', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-redact-');
  const backups = tempDir('asoldi-redact-backups-');
  const envFile = join(tempDir('asoldi-redact-env-'), 'a.env');
  const known = randomBytes(18).toString('base64url');
  writeFileSync(envFile, `MY_SERVICE_API_KEY=${known}\n`);
  const pemHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const pemFooter = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const body = randomBytes(48).toString('base64');
  const original = [
    'line one',
    `token=${known} and again ${known}`,
    `key: ${FAKE_ANTHROPIC}`,
    pemHeader,
    body,
    body,
    pemFooter,
    `inline "${pemHeader}\\n${body}${body}${body}\\n${pemFooter}\\n" end`,
    'mail ola.nordmann@kunde-firma.no stays',
  ].join('\r\n');
  write(dir, 'chat/export.txt', original);
  const env = { ...NO_ENV(cwd), SECRET_SCAN_ENV_FILES: envFile, ASOLDI_REDACT_BACKUPS: backups };

  const dry = await runScan(['--redact', dir], { cwd, env });
  assert.equal(dry.code, 1);
  assert.match(dry.out, /would replace 5 value\(s\) in 1 file\(s\)/);
  assert.equal(readFileSync(join(dir, 'chat/export.txt'), 'utf8'), original, 'a dry run writes nothing');
  assert.deepEqual(readdirSync(backups), [], 'a dry run keeps no backup');
  for (const value of [known, FAKE_ANTHROPIC, body]) assert.equal(dry.out.includes(value), false);

  const applied = await runScan(['--redact', dir, '--apply'], { cwd, env });
  assert.equal(applied.code, 0, applied.out);
  const text = readFileSync(join(dir, 'chat/export.txt'), 'utf8');
  const [backupFolder] = readdirSync(backups);
  assert.match(backupFolder, /^asoldi-redact-.+-[0-9a-f]{10}$/);
  const backup = join(backups, backupFolder, 'chat', 'export.txt.bak-redact');
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.equal(existsSync(join(dir, 'chat/export.txt.bak-redact')), false, 'no original is left inside the folder');
  for (const value of [known, FAKE_ANTHROPIC, body, pemHeader]) assert.equal(text.includes(value), false, 'value left');
  const lines = text.split('\r\n');
  assert.equal(lines.length, 9, 'line count and CRLF kept');
  assert.equal(lines[1], 'token=<redacted:MY_SERVICE_API_KEY> and again <redacted:MY_SERVICE_API_KEY>');
  assert.equal(lines[2], 'key: <redacted:anthropic-key>');
  assert.deepEqual(lines.slice(3, 7), ['<redacted:private-key>', '', '', '']);
  assert.equal(lines[7], 'inline "<redacted:private-key>\\n" end');
  assert.equal(lines[8], 'mail ola.nordmann@kunde-firma.no stays', 'client data is not a secret: never redacted');
  for (const value of [known, FAKE_ANTHROPIC, body]) assert.equal(applied.out.includes(value), false);

  // A second run finds nothing, and the first backup is never overwritten.
  writeFileSync(join(dir, 'chat/export.txt'), `${text}\r\nnew ${FAKE_ANTHROPIC}`);
  await runScan(['--redact', dir, '--apply'], { cwd, env });
  assert.equal(readFileSync(backup, 'utf8'), original);
  const again = await runScan(['--redact', dir], { cwd, env });
  assert.equal(again.code, 0, again.out);
  // A backup holds the values: the scan reports one as a path that must not be committed.
  write(dir, 'old/copy.txt.bak-redact', 'x\n');
  const ws = await runScan(['--workspace', dir, '--profile', 'private'], { cwd, env });
  assert.match(ws.out, /old\/copy\.txt\.bak-redact {2}path:redact-backup/);
});

test('--redact refuses a folder that holds an env file the known values come from, or the backup folder', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-redact-env-inside-');
  const known = randomBytes(18).toString('base64url');
  write(dir, 'repo/.env', `MY_SERVICE_API_KEY=${known}\n`);
  write(dir, 'notes.txt', `key ${known}\n`);
  const env = { ...NO_ENV(cwd), SECRET_SCAN_ENV_FILES: join(dir, 'repo', '.env'), ASOLDI_REDACT_BACKUPS: tempDir('asoldi-redact-b-') };
  await assert.rejects(runScan(['--redact', dir, '--apply'], { cwd, env }), /holds 1 env file/);
  assert.equal(readFileSync(join(dir, 'repo/.env'), 'utf8'), `MY_SERVICE_API_KEY=${known}\n`, 'the env file keeps its value');
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), `key ${known}\n`);

  const plain = tempDir('asoldi-redact-plain-');
  write(plain, 'a.txt', `key ${FAKE_ANTHROPIC}\n`);
  await assert.rejects(runScan(['--redact', plain, '--apply', '--backup-dir', join(plain, 'backups')], { cwd, env: NO_ENV(cwd) }), /backup folder is inside/);
  assert.equal(readFileSync(join(plain, 'a.txt'), 'utf8'), `key ${FAKE_ANTHROPIC}\n`);

  // Any other env file (a copy in an archive, a live one in a checkout) is listed, never changed.
  write(plain, 'old/.env.production', `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`);
  const backupEnv = { ...NO_ENV(cwd), ASOLDI_REDACT_BACKUPS: tempDir('asoldi-redact-b2-') };
  const applied = await runScan(['--redact', plain, '--apply'], { cwd, env: backupEnv });
  assert.equal(applied.code, 3, `an env file left as it was keeps the folder from counting as clean\n${applied.out}`);
  assert.match(applied.out, /^old\/\.env\.production {2}not scanned: an env file is never changed by a redaction/m);
  assert.equal(readFileSync(join(plain, 'old/.env.production'), 'utf8'), `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`);
  assert.equal(readFileSync(join(plain, 'a.txt'), 'utf8'), 'key <redacted:anthropic-key>\n');
});

const utf16le = (text, bom = true) => Buffer.concat([Buffer.from(bom ? [0xff, 0xfe] : []), Buffer.from(text, 'utf16le')]);
const utf16be = (text) => {
  const body = Buffer.from(text, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
};

/** A junction (Windows) or a directory symlink to `target` at `path`; false when the system refuses one. */
function linkDir(target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('--workspace reads UTF-16 text (as PowerShell writes it) with or without a byte-order mark', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-workspace-utf16-');
  writeFileSync(join(dir, 'ps-out.txt'), utf16le(`first\r\ntoken ${FAKE_ANTHROPIC}\r\n`));
  writeFileSync(join(dir, 'be.txt'), utf16be(`key ${FAKE_ANTHROPIC}\n`));
  writeFileSync(join(dir, 'no-bom.txt'), utf16le(`key ${FAKE_ANTHROPIC}\n`, false));
  write(dir, 'bom-utf8.txt', `﻿key ${FAKE_ANTHROPIC}\n`);
  const result = await runScan(['--workspace', dir, '--profile', 'private'], { cwd, env: NO_ENV(cwd) });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /^ps-out\.txt:2 {2}anthropic-key$/m);
  assert.match(result.out, /^be\.txt:1 {2}anthropic-key$/m);
  assert.match(result.out, /^no-bom\.txt:1 {2}anthropic-key$/m);
  assert.match(result.out, /^bom-utf8\.txt:1 {2}anthropic-key$/m);
  assert.doesNotMatch(result.out, /not scanned/);
  assert.equal(result.out.includes(FAKE_ANTHROPIC), false);
  for (const sample of [Buffer.from([0, 1, 2, 3]), Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]), utf16le('odd').subarray(0, 5)]) {
    assert.equal(lib.decodeText(sample), null, 'binary, UTF-32 and a cut UTF-16 file are not read as text');
  }
  const round = lib.decodeText(utf16be('abæ'));
  assert.deepEqual(round, { text: 'abæ', encoding: 'utf16be', bom: true });
  assert.deepEqual(lib.encodeText(round.text, round), utf16be('abæ'));
});

test('--workspace lists every file or folder it did not read, and exits 3 instead of 0 when it found nothing but did not read everything', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-workspace-unread-');
  writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(FAKE_ANTHROPIC)]));
  write(dir, 'big.log', `${'y'.repeat(300)}\nkey ${FAKE_ANTHROPIC}\n`);
  write(dir, 'node_modules/p/index.js', `k = '${FAKE_ANTHROPIC}';\n`);
  write(dir, '.git/config', `[remote "origin"]\n\turl = https://u:${FAKE_ANTHROPIC}@git.example.invalid/r.git\n`);
  write(dir, 'notes.md', 'nothing here\n');
  const target = tempDir('asoldi-workspace-link-target-');
  write(target, 'k.txt', `key ${FAKE_ANTHROPIC}\n`);
  const linked = linkDir(target, join(dir, 'linked'));
  const env = NO_ENV(cwd);

  const result = await runScan(['--workspace', dir, '--max-file-bytes', '200'], { cwd, env });
  assert.equal(result.code, 3, result.out);
  assert.match(result.out, /^blob\.bin {2}not scanned: binary/m);
  assert.match(result.out, /^big\.log {2}not scanned: larger than the size limit/m);
  assert.match(result.out, /^node_modules\/ {2}not scanned: installed dependencies$/m);
  assert.match(result.out, /^\.git\/ {2}not scanned: git metadata/m);
  if (linked) assert.match(result.out, /^linked {2}not scanned: a symbolic link or junction/m);
  assert.match(result.out, /secret-scan \(workspace\): no finding in the files it read/);
  assert.match(result.out, /not proven clean/);
  assert.doesNotMatch(result.out, /clean \(/);
  assert.equal(result.out.includes(FAKE_ANTHROPIC), false);

  const json = await runScan(['--workspace', dir, '--max-file-bytes', '200', '--json'], { cwd, env });
  assert.equal(json.code, 3);
  const report = JSON.parse(json.out);
  assert.equal(report.counts.notScanned, linked ? 5 : 4);
  assert.deepEqual(report.notScanned.map((row) => row.reason).sort(), [...(linked ? ['link'] : []), 'binary', 'dependencies', 'git-metadata', 'too-large'].sort());

  const accepted = await runScan(['--workspace', dir, '--max-file-bytes', '200', '--allow-skipped'], { cwd, env });
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /Accepted with --allow-skipped/);
  // Read in full, the large file's key is found; findings decide the exit status.
  const full = await runScan(['--workspace', dir], { cwd, env });
  assert.equal(full.code, 1);
  assert.match(full.out, /^big\.log:2 {2}anthropic-key$/m);
  // A folder that is not there is an error, never a clean result.
  await assert.rejects(runScan(['--workspace', join(dir, 'missing')], { cwd, env }), /no folder at/);
  await assert.rejects(runScan(['--redact', join(dir, 'notes.md')], { cwd, env }), /is not a folder/);
});

test('--redact writes a UTF-16 file back as UTF-16 and lists the binary files and old backups it left (exit 3 unless accepted)', async () => {
  const cwd = makeRepo();
  const dir = tempDir('asoldi-redact-utf16-');
  const backups = tempDir('asoldi-redact-utf16-b-');
  const original = utf16le(`line one\r\nkey: ${FAKE_ANTHROPIC}\r\nlast`);
  writeFileSync(join(dir, 'ps-out.txt'), original);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(FAKE_ANTHROPIC)]);
  writeFileSync(join(dir, 'blob.bin'), blob);
  write(dir, 'old/copy.txt.bak-redact', `key ${FAKE_ANTHROPIC}\n`);
  const env = { ...NO_ENV(cwd), ASOLDI_REDACT_BACKUPS: backups };

  const dry = await runScan(['--redact', dir], { cwd, env });
  assert.equal(dry.code, 1, dry.out);
  assert.match(dry.out, /would replace 1 value\(s\) in 1 file\(s\)/);
  assert.match(dry.out, /^blob\.bin {2}not scanned: binary/m);
  assert.match(dry.out, /^old\/copy\.txt\.bak-redact {2}not scanned: an original kept by an older redaction run/m);

  const applied = await runScan(['--redact', dir, '--apply'], { cwd, env });
  assert.equal(applied.code, 3, applied.out);
  assert.match(applied.out, /replaced 1 value\(s\) in 1 file\(s\)/);
  const after = readFileSync(join(dir, 'ps-out.txt'));
  assert.deepEqual([...after.subarray(0, 2)], [0xff, 0xfe], 'the byte-order mark stays');
  assert.equal(after.subarray(2).toString('utf16le'), 'line one\r\nkey: <redacted:anthropic-key>\r\nlast');
  const [folder] = readdirSync(backups);
  assert.deepEqual(readFileSync(join(backups, folder, 'ps-out.txt.bak-redact')), original);
  assert.deepEqual(readFileSync(join(dir, 'blob.bin')), blob, 'a file it cannot read is never changed');
  const json = JSON.parse((await runScan(['--redact', dir, '--json'], { cwd, env })).out);
  assert.deepEqual(json.notScanned, [{ path: 'blob.bin', reason: 'binary' }, { path: 'old/copy.txt.bak-redact', reason: 'redaction-backup' }]);
  assert.equal((await runScan(['--redact', dir, '--apply', '--allow-skipped'], { cwd, env })).code, 0);
});

// ------------------------------------------------------------------------- ratchet

test('offender lists: a new file or a higher count fails, a lower count passes, and --shrink only lowers', async () => {
  const list = { files: { 'a.js': 2, 'b.js': 1 } };
  assert.equal(lib.ratchetProblems(list, { 'a.js': 2 }).ok, true);
  assert.deepEqual(lib.ratchetProblems(list, { 'a.js': 1 }).shrunk.map((r) => r.path), ['a.js', 'b.js']);
  assert.deepEqual(lib.ratchetProblems(list, { 'a.js': 3 }).grown, [{ path: 'a.js', count: 3, allowed: 2 }]);
  assert.deepEqual(lib.ratchetProblems(list, { 'c.js': 1 }).unlisted, [{ path: 'c.js', count: 1 }]);
  assert.deepEqual(lib.shrinkRatchet(list, { 'a.js': 5, 'c.js': 4 }).files, { 'a.js': 2 });

  const dir = makeRepo();
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({ profile: 'public', ratchets: { plan: 'plan.json', pii: 'pii.json' } }));
  write(dir, 'plan.json', JSON.stringify({ kind: 'plan', files: { 'a.js': 2 } }));
  write(dir, 'pii.json', JSON.stringify({ kind: 'pii', files: {} }));
  write(dir, 'a.js', `// ${id(8, 3)} ${id(8, 9)}\n`);
  git(dir, ['add', '-A']);
  assert.equal((await runScan(['--tracked', '--ratchet'], { cwd: dir, env: NO_ENV(dir) })).code, 0);
  write(dir, 'b.md', `${id(6, 7)}\n`);
  git(dir, ['add', 'b.md']);
  const unlisted = await runScan(['--tracked', '--ratchet'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(unlisted.code, 1);
  assert.match(unlisted.out, /b\.md {2}plan: 1 finding\(s\), not in plan\.json/);
  git(dir, ['rm', '-q', '--cached', 'b.md']);
  write(dir, 'a.js', `// ${id(8, 3)}\n`);
  const lower = await runScan(['--tracked', '--ratchet', '--shrink'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(lower.code, 0, lower.out);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).files, { 'a.js': 1 });
  write(dir, 'docs/daily-logs/x.md', 'note\n');
  git(dir, ['add', '-f', 'docs/daily-logs/x.md']);
  const blocked = await runScan(['--tracked', '--ratchet'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /docs\/daily-logs\/x\.md {2}path:daily-log/);
  git(dir, ['rm', '-q', '--cached', 'docs/daily-logs/x.md']);

  // An allowlist entry for client data on a glob would hide findings from the lists: it fails; on one file it passes.
  write(dir, 'docs/a.md', 'kari@annen-kunde.no\n');
  write(dir, ALLOW_FILE, JSON.stringify({ entries: [{ path: 'docs/*.md', rule: 'email', reason: 'docs' }] }));
  git(dir, ['add', 'docs/a.md', ALLOW_FILE]);
  const broad = await runScan(['--tracked', '--ratchet'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(broad.code, 1, broad.out);
  assert.match(broad.out, /^\.secret-scan-allowlist\.json {2}path:allowlist-broad {2}\(rule email on docs\/\*\.md; name one file\)$/m);
  write(dir, ALLOW_FILE, JSON.stringify({ entries: [{ path: 'docs/a.md', rule: 'email', reason: 'docs' }] }));
  const one = await runScan(['--tracked', '--ratchet'], { cwd: dir, env: NO_ENV(dir) });
  assert.equal(one.code, 0, one.out);
});

// ------------------------------------------------------------------------- hooks (negative controls)

function copyTooling(dir) {
  mkdirSync(join(dir, 'scripts', 'security'), { recursive: true });
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  for (const file of ['secret-scan.mjs', 'secret-scan-lib.mjs', 'install-git-hooks.mjs', 'scan-profile.json']) {
    copyFileSync(join(repoRoot, 'scripts', 'security', file), join(dir, 'scripts', 'security', file));
  }
  for (const hook of HOOKS) {
    writeFileSync(join(dir, '.githooks', hook), readFileSync(join(repoRoot, '.githooks', hook), 'utf8').replace(/\r\n/g, '\n'));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hygiene-hook-test', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
}

test('installed hooks refuse a staged task id, a staged fake key and a commit message with a task id', { timeout: 120_000 }, () => {
  const dir = makeRepo();
  copyTooling(dir);
  const env = { ...process.env, ...NO_ENV(dir) };
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' });
  assert.equal(run(process.execPath, ['scripts/security/install-git-hooks.mjs']).status, 0);
  run('git', ['add', '-A']);
  const init = run('git', ['commit', '-q', '-m', 'Add the scan tooling']);
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);

  write(dir, 'note.js', `// ${id(8, 3)}: the plan in force\nexport const x = 1;\n`);
  run('git', ['add', 'note.js']);
  const staged = run('git', ['commit', '-q', '-m', 'Add a note']);
  assert.notEqual(staged.status, 0, 'pre-commit must refuse a task id');
  assert.match(`${staged.stdout}${staged.stderr}`, /note\.js:1 {2}plan-id/);

  write(dir, 'note.js', `export const k = '${FAKE_ANTHROPIC}';\n`);
  run('git', ['add', 'note.js']);
  const key = run('git', ['commit', '-q', '-m', 'Add a key']);
  assert.notEqual(key.status, 0, 'pre-commit must refuse a fake key');
  assert.match(`${key.stdout}${key.stderr}`, /note\.js:1 {2}anthropic-key/);
  assert.equal(`${key.stdout}${key.stderr}`.includes(FAKE_ANTHROPIC), false);

  write(dir, 'note.js', '// the plan in force\nexport const x = 1;\n');
  run('git', ['add', 'note.js']);
  const message = run('git', ['commit', '-q', '-m', `Add the note for ${id(8, 3)}`]);
  assert.notEqual(message.status, 0, 'commit-msg must refuse a task id');
  assert.match(`${message.stdout}${message.stderr}`, /commit-message:1 {2}plan-id/);
  const ok = run('git', ['commit', '-q', '-m', 'Add a note about the plan in force']);
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
});

// ------------------------------------------------------------------------- the planning-word cleanup

function treeWithProfile(extra = {}) {
  const dir = tempDir('asoldi-cleanup-');
  write(dir, 'scripts/security/scan-profile.json', JSON.stringify({
    profile: 'public',
    ratchets: { plan: 'scripts/security/plan.json', pii: 'scripts/security/pii.json' },
    codemodSkip: ['lib/copied.js'],
    scrubExclude: ['scripts/wip.test.mjs', 'lib/wip/**'],
    ...extra,
  }));
  return dir;
}


test('the planning-word cleanup: --check fails on a task id in a comment and leaves identifiers, string values and quoted examples alone', () => {
  const dir = treeWithProfile();
  const source = [
    `// ${id(8, 56)}: stored only when true.`,
    `const ${P}_TOTAL = 3;`,
    `export const owner = '${id(9)}';`,
    `export function total() { return ${P}_TOTAL; } /* ${id(8, 44)}, batch 0 */`,
    `// Example: owner: '${id(4, 18)}' marks the task.`,
    `// ${id(8)}: delivery spine notes`,
    '',
  ].join('\n');
  write(dir, 'lib/a.js', source);
  const check = quiet(() => codemod.main(['--check', '--root', dir], { env: { PLAN_WORDS_FILE: join(dir, 'none.json') } }));
  assert.equal(check, 1);
  assert.equal(readFileSync(join(dir, 'lib/a.js'), 'utf8'), source, '--check writes nothing');
  assert.equal(quiet(() => codemod.main(['--write', '--root', dir], { env: { PLAN_WORDS_FILE: join(dir, 'none.json') } })), 0);
  const text = readFileSync(join(dir, 'lib/a.js'), 'utf8');
  assert.equal(text, [
    '// Delivery: stored only when true.',
    `const ${P}_TOTAL = 3;`,
    `export const owner = '${id(9)}';`,
    `export function total() { return ${P}_TOTAL; } /* Delivery, batch 0 */`,
    `// Example: owner: '${id(4, 18)}' marks the task.`,
    '// Delivery spine notes',
    '',
  ].join('\n'), 'area words only, a quoted example kept, and an id whose word follows it dropped');
  const report = codemod.run({ root: dir });
  assert.deepEqual(report.changed, [], 'a second run changes nothing');
  assert.deepEqual(report.left.map((f) => `${f.path}:${f.line}`), ['lib/a.js:3', 'lib/a.js:5'], 'the string value and the quoted example are reported, not changed');
});

test('the planning-word cleanup holds no task words: they come from a words file outside the repo, and a tracked one is refused', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(codemod, 'TASK_WORDS'), false);
  const source = readFileSync(join(repoRoot, 'scripts', 'security', 'neutralize-plan-ids.mjs'), 'utf8');
  assert.equal(/'\d{1,2}\.\d{1,2}[a-z]?'\s*:/.test(source), false, 'no task-number table in the public script');

  const words = { tasks: { '7.91': 'notice routing', '7.92': 'mail keys', '7.93': 'opt-out page', '7.94': 'mail store', '8.91': 'plan source', '8.92': 'worker heartbeat' } };
  const wordsFile = join(tempDir('asoldi-words-'), 'plan-words.json');
  writeFileSync(wordsFile, JSON.stringify(words));
  const dir = treeWithProfile();
  write(dir, 'app/Card.tsx', [
    'export function Card() {',
    `  // ${id(7, 91)}: where notices go`,
    `  return <p title="${id(7, 91)}">See // ${id(7, 91)} {/* ${id(7, 92)} */} {\`${id(7, 94)}\`}</p>;`,
    '}',
    '',
  ].join('\n'));
  write(dir, 'scripts/a.test.mjs', [
    "import test from 'node:test';",
    `test('${id(7, 93)}: the page records an opt-out', () => {});`,
    `test(\`${id(7, 94)}: \${'x'} on a data file\`, () => {});`,
    `const re = /${id(1)}/; re.test('${id(1, 13)}');`,
    '',
  ].join('\n'));
  write(dir, 'docs/a.md', [
    `## Email keys (${id(7, 92)})`,
    `Services come from \`planSource\` (${id(8, 91)}) and \`owner: '${id(9)}'\`, see ${PLAN_FILE} §3.2.`,
    '```js',
    `const owner = '${id(9)}';`,
    '```',
    `The ${STREAM} owners and the ${id(6)} §3.3.1 bundles; ${id(8, 92)} heartbeat.`,
    '',
  ].join('\n'));
  write(dir, 'data/tree.json', `{"owner": "${id(6)}"}\n`);
  write(dir, 'lib/copied.js', `// ${id(6, 7)}\n`);
  assert.equal(quiet(() => codemod.main(['--write', '--root', dir, '--words', wordsFile])), 0);
  assert.equal(readFileSync(join(dir, 'app/Card.tsx'), 'utf8'), [
    'export function Card() {',
    '  // Notice routing: where notices go',
    `  return <p title="${id(7, 91)}">See // ${id(7, 91)} {/* Mail keys */} {\`${id(7, 94)}\`}</p>;`,
    '}',
    '',
  ].join('\n'));
  assert.equal(readFileSync(join(dir, 'scripts/a.test.mjs'), 'utf8'), [
    "import test from 'node:test';",
    "test('The page records an opt-out', () => {});",
    "test(`Mail store: ${'x'} on a data file`, () => {});",
    `const re = /${id(1)}/; re.test('${id(1, 13)}');`,
    '',
  ].join('\n'), 'a title whose words follow the id drops the id');
  assert.equal(readFileSync(join(dir, 'docs/a.md'), 'utf8'), [
    '## Email keys',
    `Services come from \`planSource\` (plan source) and \`owner: '${id(9)}'\`, see the internal notes.`,
    '```js',
    `const owner = '${id(9)}';`,
    '```',
    'The area owners and the CMS bundles; worker heartbeat.',
    '',
  ].join('\n'));
  assert.equal(readFileSync(join(dir, 'data/tree.json'), 'utf8'), `{"owner": "${id(6)}"}\n`);
  assert.equal(readFileSync(join(dir, 'lib/copied.js'), 'utf8'), `// ${id(6, 7)}\n`, 'a skipped copy is never changed');
  const report = codemod.run({ root: dir, words: codemod.loadWords(wordsFile, dir) });
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.skipped, [{ path: 'lib/copied.js', count: 1 }]);
  assert.deepEqual([...new Set(report.left.map((f) => f.path))].sort(), ['app/Card.tsx', 'data/tree.json', 'docs/a.md', 'scripts/a.test.mjs']);

  // A words file inside the repo it rewrites is refused; a missing --words file is an error.
  const repo = makeRepo();
  write(repo, 'plan-words.json', JSON.stringify(words));
  git(repo, ['add', 'plan-words.json']);
  assert.throws(() => quiet(() => codemod.main(['--check', '--root', repo, '--words', join(repo, 'plan-words.json')])), /tracked in this repo/);
  assert.throws(() => quiet(() => codemod.main(['--check', '--root', repo, '--words', join(repo, 'missing.json')])), /does not exist/);
  // The public profile also refuses the words file as a path.
  assert.equal(lib.blockedPathRule('scripts/plan-words.json', 'public'), 'plan-words');
  assert.equal(lib.blockedPathRule('scripts/plan-words.json', 'private'), '');
});

test('the planning-word cleanup lowers the offender list after --write and never raises it', () => {
  const dir = treeWithProfile();
  write(dir, 'lib/a.js', `// ${id(8, 3)}\nexport const owner = '${id(9)}';\n`);
  write(dir, 'lib/copied.js', `// ${id(6, 7)}\n`);
  write(dir, 'scripts/security/plan.json', JSON.stringify({ kind: 'plan', files: { 'lib/a.js': 2, 'lib/copied.js': 1, 'lib/gone.js': 4 } }));
  write(dir, 'scripts/security/pii.json', JSON.stringify({ kind: 'pii', files: {} }));
  quiet(() => codemod.main(['--write', '--root', dir], { env: { PLAN_WORDS_FILE: join(dir, 'none.json') } }));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'scripts/security/plan.json'), 'utf8')).files, { 'lib/a.js': 1, 'lib/copied.js': 1 });
});

// ------------------------------------------------------------------------- the client-data cleanup

test('the client-data cleanup: neutral company words, role mailboxes kept, the same address the same way everywhere, layouts kept, and a second run changes nothing', () => {
  const dir = treeWithProfile();
  write(dir, '.secret-scan-allowlist.json', JSON.stringify({ emails: ['kari@firma.no'] }));
  const fixture = [
    "export const client = { name: 'Fjordbakeriet AS', email: 'post@fjordbakeriet.no', website: 'https://www.fjordbakeriet.no/meny',",
    "  owner: 'Kari.Strandvik@fjordbakeriet.no', backup: 'kari.strandvik@fjordbakeriet.no', gmail: 'ola.n@gmail.com',",
    "  social: 'https://x.com/fjordbakeriet', phone: '+47 958 61 302', mobile: '95861302', tlf: '958 61 302', contact: 'Kari Strandvik' };",
    '',
  ].join('\n');
  write(dir, 'scripts/fixtures/client.mjs', fixture);
  write(dir, 'scripts/client.test.mjs', [
    "const fjordbakeriet = 1; assert.equal(view.email, 'post@fjordbakeriet.no'); assert.equal(digits, '95861302'); // phone",
    "assert.match(ics, /UID:bk_1@fjordbakeriet\\.no/); const text = 'Hei\\npost@fjordbakeriet.no';",
    "const sales = 'sales@firma.no'; const kari = 'kari@firma.no'; const host = 'https://firma.no';",
    '',
  ].join('\n'));
  write(dir, 'scripts/other.test.mjs', "const site = 'https://fjordbakeriet.no'; const kari = 'kari@firma.no';\n");
  write(dir, 'docs/notes.md', 'Ring +4795861302 or write to post@fjordbakeriet.no.\n');
  write(dir, 'docs/security.md', 'Example: post@fjordbakeriet.no\n');
  write(dir, 'lib/runtime.js', "export const CONTACT = 'post@fjordbakeriet.no';\n");
  write(dir, 'scripts/wip.test.mjs', "const a = 'post@fjordbakeriet.no';\n");
  write(dir, 'scripts/security/pii.json', JSON.stringify({ kind: 'pii', files: { 'scripts/fixtures/client.mjs': 6, 'scripts/client.test.mjs': 4, 'docs/notes.md': 2, 'docs/security.md': 1, 'lib/runtime.js': 1, 'scripts/wip.test.mjs': 1 } }));
  write(dir, 'scripts/security/plan.json', JSON.stringify({ kind: 'plan', files: {} }));

  assert.equal(quiet(() => scrub.main(['--check', '--root', dir])), 1);
  assert.equal(readFileSync(join(dir, 'scripts/fixtures/client.mjs'), 'utf8'), fixture, '--check writes nothing');
  const report = quiet(() => scrub.run({ root: dir, write: true }));

  const words = scrub.assignWords(['fjordbakeriet.no', 'firma.no']);
  const word = words.get('fjordbakeriet.no');
  const firma = words.get('firma.no');
  assert.ok(scrub.NEUTRAL_WORDS.includes(word) && scrub.NEUTRAL_WORDS.includes(firma) && word !== firma);
  const Word = word[0].toUpperCase() + word.slice(1);
  const out = readFileSync(join(dir, 'scripts/fixtures/client.mjs'), 'utf8');
  assert.match(out, new RegExp(`name: '${Word} AS', email: 'post@${word}\\.test', website: 'https://www\\.${word}\\.test/meny'`), 'the company name and website follow the contact domain');
  assert.match(out, new RegExp(`owner: 'person-[0-9a-f]{6}@${word}\\.test', backup: 'person-[0-9a-f]{6}@${word}\\.test'`));
  const owner = out.match(/owner: '(person-[0-9a-f]{6})@/)[1];
  assert.equal(out.match(/backup: '(person-[0-9a-f]{6})@/)[1], owner, 'one address, one replacement, any case');
  assert.match(out, /gmail: 'person-[0-9a-f]{6}@example\.com'/);
  assert.match(out, new RegExp(`social: 'https://x\\.com/${word}'`), 'a platform domain stays; the handle follows the company name');
  const phone = out.match(/phone: '\+47 (\d{3}) (\d{2}) (\d{3})'/);
  assert.ok(phone, 'the +47 layout stays');
  const fixtureDigits = phone.slice(1).join('');
  assert.match(fixtureDigits, /^90000\d{3}$/);
  assert.match(out, new RegExp(`mobile: '${fixtureDigits}', tlf: '${fixtureDigits.slice(0, 3)} ${fixtureDigits.slice(3, 5)} ${fixtureDigits.slice(5)}'`));
  assert.equal(out.includes('fjordbakeriet'), false);

  assert.equal(readFileSync(join(dir, 'scripts/client.test.mjs'), 'utf8'), [
    `const fjordbakeriet = 1; assert.equal(view.email, 'post@${word}.test'); assert.equal(digits, '${fixtureDigits}'); // phone`,
    `assert.match(ics, /UID:bk_1@${word}\\.test/); const text = 'Hei\\npost@${word}.test';`,
    `const sales = 'sales@${firma}.test'; const kari = 'kari@firma.no'; const host = 'https://${firma}.test';`,
    '',
  ].join('\n'), 'names in code, an escape before an address and an allowlisted placeholder are kept; a regular expression follows');
  assert.equal(readFileSync(join(dir, 'scripts/other.test.mjs'), 'utf8'), "const site = 'https://fjordbakeriet.no'; const kari = 'kari@firma.no';\n", 'a file without a flagged address is not changed');
  assert.equal(readFileSync(join(dir, 'docs/notes.md'), 'utf8'), `Ring +47${fixtureDigits} or write to post@${word}.test.\n`);
  assert.equal(readFileSync(join(dir, 'docs/security.md'), 'utf8'), 'Example: post@fjordbakeriet.no\n', 'the scan docs are never changed');
  assert.equal(readFileSync(join(dir, 'lib/runtime.js'), 'utf8'), "export const CONTACT = 'post@fjordbakeriet.no';\n", 'production code is never changed');
  assert.equal(readFileSync(join(dir, 'scripts/wip.test.mjs'), 'utf8'), "const a = 'post@fjordbakeriet.no';\n", 'an excluded file is never changed');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'scripts/security/pii.json'), 'utf8')).files, { 'docs/security.md': 1, 'lib/runtime.js': 1, 'scripts/wip.test.mjs': 1 });

  // What a person still has to look at, by path and line only.
  const review = report.review.map((row) => `${row.path}:${row.line} ${row.reason}`);
  assert.ok(review.includes('scripts/fixtures/client.mjs:3 name part of a replaced address'), review.join('\n'));
  assert.ok(review.includes('scripts/client.test.mjs:1 company name from a replaced domain'), review.join('\n'));
  assert.ok(review.includes('scripts/other.test.mjs:1 a replaced company domain, used here unchanged'), review.join('\n'));
  assert.ok(review.includes('lib/runtime.js:1 a replaced company domain, used here unchanged'), review.join('\n'));
  assert.equal(JSON.stringify(report).includes('fjordbakeriet'), false, 'the report holds paths and lines, never values');

  const again = scrub.run({ root: dir });
  assert.deepEqual(again.changed, [], 'a second run changes nothing');
  assert.deepEqual(again.left, []);

  // Role mailboxes and one-letter placeholders keep their local part; a person's does not.
  assert.equal(scrub.mappedLocal('post', 'post@a.no'), 'post');
  assert.equal(scrub.mappedLocal('post2', 'post2@a.no'), 'post2');
  assert.equal(scrub.mappedLocal('b', 'b@a.no'), 'b');
  assert.match(scrub.mappedLocal('kari', 'kari@a.no'), /^person-[0-9a-f]{6}$/);
  // Two companies with the same name on different domains never share a word.
  const maps = scrub.buildMaps([{ rule: 'email', value: 'post@kafe.no' }, { rule: 'email', value: 'Post@Kafe.com' }]);
  assert.notEqual(maps.domains.get('kafe.no'), maps.domains.get('kafe.com'));
  for (const domain of maps.domains.values()) assert.match(domain, /^[a-z]+\.test$/);
});

test('the client-data cleanup never gives a new company a word an earlier cleanup left in the tree', () => {
  const first = 'kunde-0.no';
  const word = scrub.assignWords([first]).get(first);
  // Another company whose hashed start is the same word.
  const second = Array.from({ length: 400 }, (_, i) => `kunde-${i + 1}.no`).find((domain) => scrub.assignWords([domain]).get(domain) === word);
  assert.ok(second, 'a domain with the same start word');
  assert.deepEqual(scrub.wordsInUse([`post@${word}.test and https://www.${word}-2.test/x`, `not${word}.test`, 'x.TANSY.test']), [word, `${word}-2`, 'tansy'].sort());
  assert.equal(scrub.assignWords(['x.no'], { taken: scrub.NEUTRAL_WORDS }).get('x.no').replace(/-\d+$/, '-n'), `${scrub.assignWords(['x.no']).get('x.no')}-n`);

  const dir = treeWithProfile();
  write(dir, '.secret-scan-allowlist.json', JSON.stringify({}));
  write(dir, 'scripts/security/pii.json', JSON.stringify({ kind: 'pii', files: {} }));
  write(dir, 'scripts/security/plan.json', JSON.stringify({ kind: 'plan', files: {} }));
  // An earlier cleanup already moved one company to the word; a later merge brings the other company.
  write(dir, 'scripts/old.test.mjs', `const a = 'post@${word}.test';\n`);
  write(dir, 'scripts/new.test.mjs', `const b = 'post@${second}';\n`);
  quiet(() => scrub.run({ root: dir, write: true }));
  const out = readFileSync(join(dir, 'scripts/new.test.mjs'), 'utf8');
  const moved = out.match(/post@([a-z-]+)\.test/);
  assert.ok(moved, out);
  assert.notEqual(moved[1], word, 'two companies never share one .test domain');
  assert.ok(scrub.NEUTRAL_WORDS.includes(moved[1]));
  assert.equal(readFileSync(join(dir, 'scripts/old.test.mjs'), 'utf8'), `const a = 'post@${word}.test';\n`);
});
// ------------------------------------------------------------------------- this repo, end to end

/** Export names of a module, read from its syntax (never run): ESM exports and CommonJS assignments. */
function exportNames(path, text) {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const names = [];
  const exported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
  const isDefault = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0;
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) names.push(`*:${statement.moduleSpecifier?.text}`);
      else if (ts.isNamespaceExport(statement.exportClause)) names.push(statement.exportClause.name.text);
      else for (const element of statement.exportClause.elements) names.push(element.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push('default');
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) names.push(declaration.name.getText(source));
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && exported(statement)) {
      names.push(isDefault(statement) ? 'default' : statement.name?.text);
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const left = statement.expression.left.getText(source);
      if (left === 'module.exports') names.push(`cjs:${statement.expression.right.getText(source).replace(/\s+/g, ' ')}`);
      else if (/^(?:module\.)?exports\.\w+$/.test(left)) names.push(`cjs:${left.split('.').pop()}`);
    }
  }
  return names.sort();
}

// Quoted ids in comments stand for values ("owner: '<id>'"); the cleanup leaves and lists them.
const QUOTED_ID = new RegExp(`(['"\`])${P}\\d{1,2}(?:\\.\\d{1,2}[a-z]?)?\\1`, 'g');

/**
 * Both cleanups on `dir`, checked against `baseline` (the tree before this pass): what is left,
 * that a second run changes nothing, and that every changed module keeps its names and structure.
 * Passes on a tree that is already clean, where nothing changes.
 */
function cleanupPass(dir, baseline) {
  const config = loadProfileConfig(dir);
  const plan = quiet(() => codemod.run({ root: dir, write: true }));
  const client = quiet(() => scrub.run({ root: dir, write: true }));
  assert.deepEqual(plan.errors, []);

  // A second run of each changes nothing.
  assert.deepEqual(codemod.run({ root: dir }).changed, []);
  assert.deepEqual(scrub.run({ root: dir }).changed, []);

  // Planning words left: only in the skipped copies, or outside every comment, doc prose and test title.
  for (const path of new Set(plan.left.map((finding) => finding.path))) {
    const text = readFileSync(join(dir, path), 'utf8');
    const regions = /\.(?:md|mdc|markdown)$/.test(path)
      ? codemod.markdownRegions(text)
      : /\.[cm]?[jt]sx?$/.test(path) ? codemod.jsRegions(path, text) : [];
    for (const region of regions) {
      assert.deepEqual(planRules(text.slice(region.start, region.end).replace(QUOTED_ID, ''), path), [], `${path}: a planning word is left in a ${region.kind}`);
    }
  }
  for (const row of plan.skipped) assert.ok(config.codemodSkip.includes(row.path), row.path);

  // Client data left: only in the excluded files. No blocked path, no secret.
  const report = ratchetReport(dir);
  assert.deepEqual(report.hard.map(lib.formatFinding), []);
  const excluded = config.scrubExclude.map(scrub.globToRegExp);
  const piiPaths = Object.keys(report.lists.pii.counts);
  assert.deepEqual(piiPaths.filter((path) => !excluded.some((re) => re.test(path))), [], 'client data outside the excluded files');
  assert.equal(report.ok, true, 'the lowered offender lists hold');

  // Every module either cleanup changed keeps its export names, and its names and structure.
  const changed = [...new Set([...plan.changed, ...client.changed].map((row) => row.path))].filter((path) => /\.[cm]?[jt]sx?$/.test(path));
  for (const path of changed) {
    const now = readFileSync(join(dir, path), 'utf8');
    const before = readFileSync(join(baseline, path), 'utf8');
    assert.deepEqual(exportNames(path, now), exportNames(path, before), path);
    assert.deepEqual(codemod.codeTokens(path, now, undefined, { literals: false }), codemod.codeTokens(path, before, undefined, { literals: false }), `${path}: names or structure changed`);
  }
  // The planning-word cleanup changed comments and test titles only.
  for (const { path } of plan.changed.filter((row) => /\.[cm]?[jt]sx?$/.test(row.path) && !client.changed.some((c) => c.path === row.path))) {
    assert.deepEqual(codemod.codeTokens(path, readFileSync(join(dir, path), 'utf8')), codemod.codeTokens(path, readFileSync(join(baseline, path), 'utf8')), path);
  }
  return { plan, client };
}

test('on a copy of this repo both cleanups leave planning words only in skipped copies and code, client data only in excluded files, and every export as it was; a second pass on the cleaned copy also holds', { timeout: 600_000 }, () => {
  const dir = tempDir('asoldi-repo-copy-');
  for (const path of listRepoFiles(repoRoot)) {
    if (!existsSync(join(repoRoot, path))) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(dir, path));
  }
  cleanupPass(dir, repoRoot);
  // The tree as the integrator commits it: both cleanups find nothing left to do, and every check still holds.
  const second = cleanupPass(dir, dir);
  assert.deepEqual(second.plan.changed, []);
  assert.deepEqual(second.client.changed, []);
});
