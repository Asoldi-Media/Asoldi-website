// WS0.10 / WS0.27b / WS0.32: secret and client-data scan, retired hashes, allowlist, git hooks.
// Every "secret" below is fake or generated at run time. Temp repos only; nothing is pushed anywhere
// except a bare repo inside the temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './secret-scan-lib.mjs';
import { messageLinesForScan, parsePatch, prePushRevArgs, main as scanMain } from './secret-scan.mjs';
import { addRetiredValues, main as retireMain } from './retire-secret.mjs';
import { HOOKS } from './install-git-hooks.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_ANTHROPIC = 'sk-ant-api03-FAKEfakeFAKE1234567890abcdefTEST';
const FAKE_PEM_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = tempDir('asoldi-scan-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Scan Test']);
  git(dir, ['config', 'user.email', 'scan@example.com']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

/** Runs the scanner's main() and returns { code, out } with all console output captured. */
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

function luhnComplete(prefix15) {
  for (let d = 0; d <= 9; d += 1) {
    const candidate = `${prefix15}${d}`;
    let sum = 0;
    let dbl = false;
    for (let i = candidate.length - 1; i >= 0; i -= 1) {
      let n = Number(candidate[i]);
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
}

function validNationalId() {
  // Brute-force the individual number until both control digits are valid (deterministic).
  for (let individual = 100; individual < 999; individual += 1) {
    const base = `150790${individual}`;
    for (let k = 0; k < 100; k += 1) {
      const candidate = `${base}${String(k).padStart(2, '0')}`;
      if (lib.isNorwegianNationalId(candidate)) return candidate;
    }
  }
  throw new Error('no id');
}

// ------------------------------------------------------------------------- rules

test('credential patterns are found, and fixture-looking values in allowlisted paths are let through', () => {
  const lines = lib.splitLines([
    `const a = '${FAKE_ANTHROPIC}';`,
    `const pem = '${FAKE_PEM_HEADER}\\nMIIB\\n-----END PRIVATE KEY-----\\n';`,
    'const ok = "sk_live_connect_key";',
    `const stripe = "sk_live_${'51HfakeAbCdEfGhIjKlMnOpQrStUv0123'}";`,
  ].join('\n'));
  const plain = lib.scanLines('src/app.js', lines);
  assert.deepEqual(plain.map((f) => f.rule).sort(), ['anthropic-key', 'private-key', 'stripe-key']);
  const allow = lib.normalizeAllowlist({
    entries: [
      { path: 'scripts/*.test.mjs', rule: 'private-key', reason: 'fixture' },
      { path: 'scripts/*.test.mjs', rule: 'anthropic-key', reason: 'fixture' },
    ],
  });
  const allowed = lib.scanLines('scripts/x.test.mjs', lines, { allowlist: allow });
  assert.deepEqual(allowed.map((f) => f.rule), ['stripe-key']);
});

test('an allowlisted path does not hide a real-looking key', () => {
  const real = `sk-ant-api03-${randomBytes(30).toString('base64url').replace(/[^A-Za-z0-9]/g, 'Q')}`;
  const allow = lib.normalizeAllowlist({ entries: [{ path: 'scripts/*.test.mjs', rule: 'anthropic-key', reason: 'fixture' }] });
  const findings = lib.scanLines('scripts/x.test.mjs', lib.splitLines(`const k = '${real}';`), { allowlist: allow });
  assert.equal(findings.length, 1);
  assert.match(findings[0].hint, /does not look like a test fixture/);
  assert.equal(JSON.stringify(findings).includes(real), false);
});

test('allowlist entries need a reason', () => {
  const allow = lib.normalizeAllowlist({ entries: [{ path: 'a.js', rule: 'email' }, { path: 'b.js', rule: 'email', reason: 'ok' }] });
  assert.equal(allow.entries.length, 1);
});

test('client personal data: e-mail, +47 phone, fødselsnummer, card number', () => {
  const id = validNationalId();
  const card = luhnComplete('523456781234567');
  const text = [
    'kontakt: ola.nordmann@kunde-firma.no',
    'ok: post@asoldi.com, test@example.com, bot@users.noreply.github.com, logo@2x.png',
    `tlf +47 ${['958', '61', '302'].join(' ')} og +47 48 33 91 91 og +47 00 00 00 00 og +47 412 34 567`,
    `fnr ${id} og ugyldig 15079012345`,
    `kort ${card.replace(/(\d{4})(?=\d)/g, '$1 ')} og test 4242 4242 4242 4242 og cid=12345678901234567890`,
    'ms 1700000000000',
  ].join('\n');
  const findings = lib.scanLines('docs/x.md', lib.splitLines(text), { allowlist: lib.normalizeAllowlist({ phones: ['+47 48 33 91 91'] }) });
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`), ['1:email', '3:phone', '4:national-id', '5:card-number']);
});

test('paths that must never be committed to a public repo', () => {
  const blocked = ['.env', 'config/.env.production', 'production.env', 'certs/server.pem', 'gen-lang-client-123.json',
    'secrets/admin-secret', 'data/users.json', 'sales-clients.json', 'docs/daily-logs/2026-10-23.md',
    'meetings/sales-transcript.txt', 'fixtures-private/a.json', 'tmp-test.mjs', 'tmp/a.json', 'inbox/mail.eml'];
  for (const path of blocked) assert.ok(lib.blockedPathRule(path), path);
  for (const path of ['.env.example', 'server.js', 'data/hub.js', 'docs/ADMIN-AND-OTP.md', 'scripts/sales-offers.test.mjs']) {
    assert.equal(lib.blockedPathRule(path), '', path);
  }
});

test('known values from .env files: secret-like names, 12+ characters, never URLs', () => {
  const values = lib.knownValuesFromEnv(lib.parseEnvText([
    'STRIPE_SECRET_KEY=abc123def456ghi789',
    'APP_URL=https://asoldi.com',
    'ADMIN_USERNAME=asoldi.com-admin-user',
    'SHORT_TOKEN=abc',
    'INBOX_IMAP_DAMIAN_PASS="pass word with space"',
    'GOOGLE_REDIRECT_TOKEN_URL=https://example.com/callback',
    'FIREFLIES_API=ffapi0fake0value0123456789',
    'SERP_API=serp0fake0value0123456789',
    'GOOGLE_CALENDAR_TIMEZONE=Europe/Oslo-Zone',
  ].join('\n')));
  assert.deepEqual(values.map((v) => v.key), ['STRIPE_SECRET_KEY', 'INBOX_IMAP_DAMIAN_PASS', 'FIREFLIES_API', 'SERP_API']);
});

test('patch parsing: added lines that look like file headers stay content of their own file', () => {
  const patch = [
    'diff --git a/notes.md b/notes.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/notes.md',
    '@@ -0,0 +1,5 @@',
    '+first line',
    '+++ /dev/null',
    `+const key = '${FAKE_ANTHROPIC}';`,
    '+++ b/scripts/security/x.test.mjs',
    '+contact ola@kunde-firma.no',
    'diff --git "a/we\\"ird \\303\\270.md" "b/we\\"ird \\303\\270.md"',
    '--- "a/we\\"ird \\303\\270.md"',
    '+++ "b/we\\"ird \\303\\270.md"',
    '@@ -2,2 +2,2 @@',
    '-old',
    '--- also old',
    '+new',
    '+++ ++ still content',
    '\\ No newline at end of file',
    'diff --git a/docs/daily-logs/a b.md b/docs/daily-logs/a b.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/daily-logs/a b.md\t',
    '@@ -0,0 +1 @@',
    '+x',
  ].join('\n');
  const files = parsePatch(patch);
  assert.deepEqual(files.map((f) => f.path), ['notes.md', 'we"ird ø.md', 'docs/daily-logs/a b.md']);
  assert.deepEqual(files[0].lines, [
    { line: 1, text: 'first line' },
    { line: 2, text: '++ /dev/null' },
    { line: 3, text: `const key = '${FAKE_ANTHROPIC}';` },
    { line: 4, text: '++ b/scripts/security/x.test.mjs' },
    { line: 5, text: 'contact ola@kunde-firma.no' },
  ]);
  assert.deepEqual(files[1].lines, [{ line: 2, text: 'new' }, { line: 3, text: '++ ++ still content' }]);
});

test('--staged: a line "++ /dev/null" or "++ b/<allowlisted path>" cannot hide the lines after it', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, '.secret-scan-allowlist.json'), JSON.stringify({
    version: 1,
    entries: [{ path: 'scripts/security/x.test.mjs', rule: '*', reason: 'scanner fixtures' }],
  }));
  writeFileSync(join(dir, 'clean.md'), 'start\n');
  git(dir, ['add', '.secret-scan-allowlist.json', 'clean.md']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  writeFileSync(join(dir, 'clean.md'), [
    'start',
    '++ /dev/null',
    `export const key = '${FAKE_ANTHROPIC}';`,
    '++ b/scripts/security/x.test.mjs',
    'kontakt: ola@kunde-firma.no',
    '',
  ].join('\n'));
  git(dir, ['add', 'clean.md']);
  const result = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /clean\.md:3 {2}anthropic-key/);
  assert.match(result.out, /clean\.md:5 {2}email/);
  assert.equal(/x\.test\.mjs/.test(result.out), false, 'no line re-attributed to the allowlisted path');
});

test('retired hashes match a rotated value inside quotes, URLs and assignments', () => {
  const salt = randomBytes(16).toString('hex');
  const retiredValue = `Rot@ted-${randomBytes(6).toString('hex')}`;
  const matcher = lib.buildRetiredMatcher({
    salt,
    entries: [{ label: 'old admin password', length: retiredValue.length, hash: lib.retiredHash(salt, retiredValue) }],
  });
  for (const line of [`password: '${retiredValue}'`, `curl https://x.test/hook?token=${retiredValue}&a=1`, `PASS=${retiredValue}`, `"${retiredValue}",`]) {
    assert.deepEqual(lib.retiredHitsInLine(line, matcher), ['old admin password'], line);
  }
  assert.deepEqual(lib.retiredHitsInLine(`password: '${retiredValue.slice(0, -1)}X'`, matcher), []);
});

// ------------------------------------------------------------------------- CLI on temp repos

function scanEnv(dir, extra = {}) {
  return { SECRET_SCAN_ENV_FILES: join(dir, '.scan-test.env'), ASOLDI_RETIRED_SECRETS: join(dir, '.scan-retired.json'), ...extra };
}

test('--staged blocks a staged fake key, a .env value and a retired secret, and prints none of them', async () => {
  const dir = makeRepo();
  const envFile = join(dir, '.scan-test.env');
  const knownValue = randomBytes(18).toString('base64url');
  writeFileSync(envFile, `MY_SERVICE_API_KEY=${knownValue}\n`);
  const retiredValue = `old-${randomBytes(8).toString('hex')}`;
  addRetiredValues(join(dir, '.scan-retired.json'), 'old webhook token', [retiredValue]);
  writeFileSync(join(dir, '.gitignore'), '.scan-test.env\n.scan-retired.json\n');
  writeFileSync(join(dir, 'clean.js'), 'export const x = 1;\n');
  git(dir, ['add', '.gitignore', 'clean.js']);
  const clean = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(clean.code, 0, clean.out);

  writeFileSync(join(dir, 'config.js'), [
    'export const a = 1;',
    `export const key = '${FAKE_ANTHROPIC}';`,
    `export const fromEnv = '${knownValue}';`,
    `export const hook = 'https://hub.test/api?token=${retiredValue}';`,
  ].join('\n'));
  git(dir, ['add', 'config.js']);
  const dirty = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /config\.js:2 {2}anthropic-key/);
  assert.match(dirty.out, /config\.js:3 {2}known-value {2}\(MY_SERVICE_API_KEY/);
  assert.match(dirty.out, /config\.js:4 {2}retired-secret {2}\(old webhook token\)/);
  for (const value of [FAKE_ANTHROPIC, knownValue, retiredValue]) assert.equal(dirty.out.includes(value), false, 'value printed');

  const json = await runScan(['--staged', '--json'], { cwd: dir, env: scanEnv(dir) });
  for (const value of [FAKE_ANTHROPIC, knownValue, retiredValue]) assert.equal(json.out.includes(value), false, 'value in JSON');
});

test('--staged blocks client-data paths and only scans added lines', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'notes.md'), 'old line ola@kunde-firma.no\n');
  git(dir, ['add', 'notes.md']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'legacy']);
  writeFileSync(join(dir, 'notes.md'), 'old line ola@kunde-firma.no\nnew line without data\n');
  git(dir, ['add', 'notes.md']);
  assert.equal((await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) })).code, 0, 'legacy lines are not rescanned');

  mkdirSync(join(dir, 'docs', 'daily-logs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'daily-logs', '2026-10-23.md'), 'nothing\n');
  writeFileSync(join(dir, '.env'), 'X=1\n');
  git(dir, ['add', '-f', 'docs/daily-logs/2026-10-23.md', '.env']);
  const result = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(result.code, 1);
  assert.match(result.out, /docs\/daily-logs\/2026-10-23\.md {2}path:daily-log/);
  assert.match(result.out, /\.env {2}path:env-file/);
});

test('--pre-push scans every pushed commit, so a secret added and removed again is still caught', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  git(dir, ['add', 'a.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'one']);
  writeFileSync(join(dir, 'a.js'), `export const a = '${FAKE_ANTHROPIC}';\n`);
  git(dir, ['commit', '-q', '--no-verify', '-am', 'leak']);
  writeFileSync(join(dir, 'a.js'), 'export const a = 2;\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'remove again']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const stdinText = `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`;
  const result = await runScan(['--pre-push'], { cwd: dir, env: scanEnv(dir), stdinText });
  assert.equal(result.code, 1);
  assert.match(result.out, /[0-9a-f]{10}:a\.js:1 {2}anthropic-key/);
  assert.equal(result.out.includes(FAKE_ANTHROPIC), false);
  const first = git(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  const onlyFirst = await runScan(['--pre-push'], { cwd: dir, env: scanEnv(dir), stdinText: `refs/heads/main ${first} refs/heads/main ${'0'.repeat(40)}\n` });
  assert.equal(onlyFirst.code, 0, onlyFirst.out);
  assert.deepEqual(prePushRevArgs(`refs/heads/main ${head} refs/heads/main ${first}\nrefs/heads/gone ${'0'.repeat(40)} refs/heads/gone ${head}\n`), [[`${first}..${head}`]]);
});

test('retire-secret stores only salted hashes and never prints the value', () => {
  const dir = tempDir('asoldi-retire-');
  const file = join(dir, 'retired.json');
  const value = `retire-me-${randomBytes(8).toString('hex')}`;
  const printed = [];
  const savedLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    assert.equal(retireMain(['--label', 'test value', '--stdin'], { env: { ASOLDI_RETIRED_SECRETS: file }, stdinText: `${value}\n` }), 0);
    assert.equal(retireMain(['--label', 'test value', '--stdin'], { env: { ASOLDI_RETIRED_SECRETS: file }, stdinText: value }), 0);
    assert.equal(retireMain(['--list'], { env: { ASOLDI_RETIRED_SECRETS: file } }), 0);
  } finally {
    console.log = savedLog;
  }
  const stored = readFileSync(file, 'utf8');
  assert.equal(stored.includes(value), false);
  const data = JSON.parse(stored);
  assert.equal(data.entries.length, 1, 'deduplicated');
  assert.equal(data.entries[0].length, value.length);
  assert.equal(printed.join('\n').includes(value), false);
  assert.match(printed.join('\n'), /skipped \(already-present\)/);
});

// ------------------------------------------------------------------------- long lines, renames, merges, messages

test('lines of any length are scanned, and a long dotted run does not stall the scan', () => {
  const filler = 'x'.repeat(105_000);
  const line = `{"a":"${filler}","key":"${FAKE_ANTHROPIC}","mail":"ola@kunde-firma.no","b":"${filler}"}`;
  assert.ok(line.length > 200_000);
  const findings = lib.scanLines('dump.json', [{ line: 1, text: line }]);
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['anthropic-key', 'email']);

  const started = Date.now();
  const slow = [`${'a.'.repeat(150_000)}@x`, `${'a.'.repeat(150_000)}://`, 'a@b.'.repeat(250_000), 'post@example.com '.repeat(60_000)];
  for (const text of slow) assert.deepEqual(lib.scanLines('x.txt', [{ line: 1, text }]), []);
  assert.ok(Date.now() - started < 10_000, `pathological lines took ${Date.now() - started} ms`);

  // Built at run time so this source line holds no URL credential itself.
  const credentials = ['admin', 'Zq7mW2pLx9'].join(':');
  const many = `${'filler '.repeat(40_000)}user ola@kunde-firma.no and https://${credentials}@db.example.com/x`;
  assert.deepEqual(lib.scanLines('x.txt', [{ line: 1, text: many }]).map((f) => f.rule).sort(), ['email', 'url-credentials']);
});

test('--staged: a single-line dump over 200k characters with a key and an e-mail is refused', async () => {
  const dir = makeRepo();
  const filler = 'y'.repeat(110_000);
  writeFileSync(join(dir, 'bundle.json'), `{"a":"${filler}","k":"${FAKE_ANTHROPIC}","e":"ola@kunde-firma.no","b":"${filler}"}`);
  git(dir, ['add', 'bundle.json']);
  const result = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /bundle\.json:1 {2}anthropic-key/);
  assert.match(result.out, /bundle\.json:1 {2}email/);
});

test('client phone numbers in local format: grouped, or unbroken when quoted or on a phone line', () => {
  // Real-looking numbers are built at run time, so this file holds none.
  const n = (...parts) => parts.join(' ');
  const plain = (...parts) => parts.join('');
  const text = [
    `Kontakt: ${n('958', '61', '302')}`,
    `ring ${n('93', '41', '27', '85')} i morgen`,
    `{"phone": "${plain('4732', '6190')}"}`,
    `mobil: ${plain('9803', '1275')}`,
    `tlf:${n('9312', '4086')}`,
    `id ${plain('9358', '1720')} og ordre ${plain('4719', '3058')}`,
    `org ${plain('9358', '17206')}, dato 2026-10-23, ms 1700000000000, v4.${plain('9358', '1720')}`,
    'kort 4000 1234 5678 9010',
    'Asoldi 48 33 91 91',
    `konto ${plain('9358', '.', '17', '.', '20694')}`,
    'fixtures: 412 34 567, "99887766", tlf 90000000, ring 98 76 54 32',
  ].join('\n');
  const findings = lib.scanLines('docs/x.md', lib.splitLines(text), { allowlist: lib.normalizeAllowlist({ phones: ['+47 48 33 91 91'] }) });
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`), ['1:phone', '2:phone', '3:phone', '4:phone', '5:phone']);
  assert.equal(lib.phoneLooksFake('99887766'), true);
  assert.equal(lib.phoneLooksFake(plain('9358', '1720')), false);
});

test('commit messages: the e-mail of a "-by:" trailer is a git identity, the rest of the line is still scanned', () => {
  const lines = lib.splitLines(['Subject', '', 'Co-authored-by: Someone <someone@kunde-firma.no>', `Reviewed-by: ${FAKE_ANTHROPIC} <a@kunde-firma.no>`, 'mail ola@kunde-firma.no'].join('\n'));
  const findings = lib.scanLines('', messageLinesForScan(lines));
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`), ['4:anthropic-key', '5:email']);
});

test('combined (merge) hunks: only lines new to every parent are scanned', () => {
  const patch = [
    '\u0001commit 1111111111111111111111111111111111111111',
    'Merge branch b',
    '',
    `key ${FAKE_ANTHROPIC}`,
    '\u0001endmsg',
    '',
    'diff --cc config.js',
    'index 1111111,2222222..3333333',
    '--- a/config.js',
    '+++ b/config.js',
    '@@@ -1,2 -1,2 +1,3 @@@',
    '- from parent one',
    ' -from parent two',
    '++resolved line',
    '+ kept from parent two',
    ' +kept from parent one',
  ].join('\n');
  const files = parsePatch(patch);
  const message = files.find((f) => f.message);
  assert.deepEqual(message.lines.map((l) => l.text), ['Merge branch b', '', `key ${FAKE_ANTHROPIC}`]);
  const file = files.find((f) => !f.message);
  assert.equal(file.path, 'config.js');
  assert.deepEqual(file.lines, [{ line: 1, text: 'resolved line' }]);
});

test('--staged: a rename into a blocked path is caught, also with diff.noprefix / mnemonicPrefix set', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'notes.txt'), 'plain\n');
  git(dir, ['add', 'notes.txt']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  mkdirSync(join(dir, 'secrets'));
  git(dir, ['mv', 'notes.txt', 'secrets/users.json']);
  const renamed = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(renamed.code, 1, renamed.out);
  assert.match(renamed.out, /secrets\/users\.json {2}path:secrets-dir/);

  git(dir, ['config', 'diff.noprefix', 'true']);
  git(dir, ['config', 'diff.mnemonicPrefix', 'true']);
  git(dir, ['config', 'diff.renames', 'copies']);
  const configured = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(configured.code, 1, configured.out);
  assert.match(configured.out, /secrets\/users\.json {2}path:secrets-dir/);

  git(dir, ['reset', '-q', '--hard']);
  mkdirSync(join(dir, 'docs', 'daily-logs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'daily-logs', 'a.md'), 'x\n');
  git(dir, ['add', '-f', 'docs/daily-logs/a.md']);
  const prefixed = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(prefixed.code, 1, prefixed.out);
  assert.match(prefixed.out, /docs\/daily-logs\/a\.md {2}path:daily-log/);
});

test('--range and --pre-push scan merge resolutions, evil merges and commit messages', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'config.js'), 'export const value = 1;\n');
  git(dir, ['add', 'config.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(dir, 'config.js'), 'export const value = 2;\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'side change']);
  git(dir, ['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'config.js'), 'export const value = 3;\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'main change']);
  const merge = spawnSync('git', ['merge', '-q', '--no-edit', 'side'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'the merge must conflict');
  writeFileSync(join(dir, 'config.js'), `export const value = '${FAKE_ANTHROPIC}'; // ola@kunde-firma.no\n`);
  git(dir, ['add', 'config.js']);
  git(dir, ['commit', '-q', '--no-verify', '--no-edit']);
  const mergeSha = git(dir, ['rev-parse', 'HEAD']).trim();

  const range = await runScan(['--range', `${base}..HEAD`], { cwd: dir, env: scanEnv(dir) });
  assert.equal(range.code, 1, range.out);
  assert.match(range.out, new RegExp(`${mergeSha.slice(0, 10)}:config\\.js:1 {2}anthropic-key`));
  assert.match(range.out, new RegExp(`${mergeSha.slice(0, 10)}:config\\.js:1 {2}email`));

  // A merge without a conflict that adds a new file (git commit --amend on a merge).
  writeFileSync(join(dir, 'config.js'), 'export const value = 4;\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'clean again']);
  git(dir, ['checkout', '-q', '-b', 'other']);
  writeFileSync(join(dir, 'other.js'), 'export const other = 1;\n');
  git(dir, ['add', 'other.js']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'other']);
  git(dir, ['checkout', '-q', 'main']);
  const cleanHead = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', '--no-verify', 'other']);
  writeFileSync(join(dir, 'evil.js'), 'contact: ola@kunde-firma.no\n');
  git(dir, ['add', 'evil.js']);
  git(dir, ['commit', '-q', '--no-verify', '--amend', '--no-edit']);
  const evil = await runScan(['--range', `${cleanHead}..HEAD`], { cwd: dir, env: scanEnv(dir) });
  assert.equal(evil.code, 1, evil.out);
  assert.match(evil.out, /:evil\.js:1 {2}email/);

  // Commit messages, and a pre-push whose remote sha this clone has never seen.
  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `chore\n\nsee ${FAKE_ANTHROPIC}`]);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const unknownRemote = 'f'.repeat(40);
  assert.deepEqual(prePushRevArgs(`refs/heads/main ${head} refs/heads/main ${unknownRemote}\n`, { hasCommit: () => false }), [[head, '--not', '--remotes']]);
  const pushed = await runScan(['--pre-push'], { cwd: dir, env: scanEnv(dir), stdinText: `refs/heads/main ${head} refs/heads/main ${unknownRemote}\n` });
  assert.equal(pushed.code, 1, pushed.out);
  assert.match(pushed.out, new RegExp(`${head.slice(0, 10)}:commit-message:3 {2}anthropic-key`));
  assert.equal(pushed.out.includes(FAKE_ANTHROPIC), false);
});

/** A value the secret-assignment rule reports: random, and without any fixture marker. */
function realLookingValue() {
  for (;;) {
    const value = `Q${randomBytes(14).toString('base64url').replace(/[^A-Za-z0-9]/g, 'k')}7z`;
    if (lib.looksRandom(value) && !lib.looksFake(value)) return value;
  }
}

test('commit-pinned allowlist entries: exact sha, exact path, a line, a rule and a reason', () => {
  const sha = 'a'.repeat(39) + 'b';
  const good = { commit: sha.toUpperCase(), path: 'scripts\\x.test.mjs', line: 24, rule: 'secret-assignment', reason: 'fake fixture in an old commit' };
  const allow = lib.normalizeAllowlist({
    commitEntries: [
      good,
      { ...good, commit: sha.slice(0, 12) },
      { ...good, path: 'scripts/*.test.mjs' },
      { ...good, line: 0 },
      { ...good, line: '24' },
      { ...good, rule: '*' },
      { ...good, rule: 'known-value' },
      { ...good, rule: 'retired-secret' },
      { ...good, rule: 'path:env-file' },
      { ...good, reason: '  ' },
    ],
  });
  assert.deepEqual(allow.commitEntries, [{ commit: sha, path: 'scripts/x.test.mjs', line: 24, rule: 'secret-assignment', reason: good.reason }]);
  const finding = { path: 'scripts/x.test.mjs', line: 24, rule: 'secret-assignment' };
  assert.ok(lib.commitEntryFor(allow, sha, finding));
  assert.equal(lib.commitEntryFor(allow, sha.replace(/b$/, 'c'), finding), null, 'another commit');
  assert.equal(lib.commitEntryFor(allow, sha, { ...finding, line: 25 }), null, 'another line');
  assert.equal(lib.commitEntryFor(allow, sha, { ...finding, path: 'scripts/y.test.mjs' }), null, 'another file');
  assert.equal(lib.commitEntryFor(allow, sha, { ...finding, rule: 'anthropic-key' }), null, 'another rule');
  assert.equal(lib.commitEntryFor(allow, '', finding), null, 'staged or tracked scans have no commit');
  // Older allowlist files without commitEntries still load.
  assert.deepEqual(lib.normalizeAllowlist({ entries: [] }).commitEntries, []);
});

test('--range: a commit-pinned entry lets exactly that line of that commit through', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, '.gitignore'), '.scan-test.env\n.scan-retired.json\n.secret-scan-allowlist.json\n');
  writeFileSync(join(dir, 'conf.test.mjs'), 'export const a = 1;\n');
  git(dir, ['add', '.gitignore', 'conf.test.mjs']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  const value = realLookingValue();
  const line = `export const env = { ADMIN_SECRET: '${value}' };`;
  writeFileSync(join(dir, 'conf.test.mjs'), `export const a = 1;\n${line}\n`);
  git(dir, ['commit', '-q', '--no-verify', '-am', 'fixture']);
  const pinned = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'conf.test.mjs'), 'export const a = 1;\n');
  git(dir, ['commit', '-q', '--no-verify', '-am', 'fake values only']);
  // The same line again in a later commit, at another line number.
  writeFileSync(join(dir, 'other.test.mjs'), `// copy\n// of\n${line}\n`);
  git(dir, ['add', 'other.test.mjs']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'copy']);
  const copy = git(dir, ['rev-parse', 'HEAD']).trim();
  const range = () => runScan(['--range', `${base}..HEAD`], { cwd: dir, env: scanEnv(dir) });
  const writeAllow = (commitEntries) => writeFileSync(join(dir, '.secret-scan-allowlist.json'), JSON.stringify({ version: 1, entries: [], commitEntries }));

  const before = await range();
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, new RegExp(`${pinned.slice(0, 10)}:conf\\.test\\.mjs:2 {2}secret-assignment`));
  assert.match(before.out, new RegExp(`${copy.slice(0, 10)}:other\\.test\\.mjs:3 {2}secret-assignment`));

  const entry = { commit: pinned, path: 'conf.test.mjs', line: 2, rule: 'secret-assignment', reason: 'fake fixture value in a past commit' };
  writeAllow([entry]);
  const after = await range();
  assert.equal(after.code, 1, 'the copy in a later commit is still reported');
  assert.doesNotMatch(after.out, new RegExp(`${pinned.slice(0, 10)}:conf\\.test\\.mjs:2 {2}secret-assignment`));
  assert.match(after.out, new RegExp(`${copy.slice(0, 10)}:other\\.test\\.mjs:3 {2}secret-assignment`));
  assert.match(after.out, new RegExp(`let through by commit-pinned allowlist entries: ${pinned.slice(0, 10)}:conf\\.test\\.mjs:2 secret-assignment`));
  assert.equal(after.out.includes(value), false, 'value printed');

  writeAllow([entry, { ...entry, commit: copy, path: 'other.test.mjs', line: 3 }]);
  const clean = await range();
  assert.equal(clean.code, 0, clean.out);

  for (const wrong of [{ ...entry, line: 1 }, { ...entry, path: '*.test.mjs' }, { ...entry, commit: pinned.slice(0, 10) }, { ...entry, rule: '*' }]) {
    writeAllow([wrong, { ...entry, commit: copy, path: 'other.test.mjs', line: 3 }]);
    const res = await range();
    assert.equal(res.code, 1, `entry ${JSON.stringify({ ...wrong, commit: wrong.commit.slice(0, 10) })} must not cover the finding`);
  }

  // A value that is also in a local .env file stays a finding in every commit.
  writeAllow([entry, { ...entry, commit: copy, path: 'other.test.mjs', line: 3 }, { ...entry, rule: 'known-value' }]);
  writeFileSync(join(dir, '.scan-test.env'), `SOME_ADMIN_SECRET=${value}\n`);
  const known = await range();
  assert.equal(known.code, 1, known.out);
  assert.match(known.out, new RegExp(`${pinned.slice(0, 10)}:conf\\.test\\.mjs:2 {2}known-value`));
  assert.equal(known.out.includes(value), false, 'value printed');
  rmSync(join(dir, '.scan-test.env'));

  // Staged changes have no commit: the same line is reported there.
  writeFileSync(join(dir, 'staged.test.mjs'), `${line}\n`);
  git(dir, ['add', 'staged.test.mjs']);
  const staged = await runScan(['--staged'], { cwd: dir, env: scanEnv(dir) });
  assert.equal(staged.code, 1, staged.out);
  assert.match(staged.out, /staged\.test\.mjs:1 {2}secret-assignment/);
});

test('--commit-msg skips git comment lines and everything below the scissors line', async () => {
  const dir = makeRepo();
  const file = join(dir, 'MSG');
  writeFileSync(file, ['Clean subject', '', '# Please enter the commit message; ola@kunde-firma.no', '# ------------------------ >8 ------------------------', `+${FAKE_ANTHROPIC}`].join('\n'));
  assert.equal((await runScan(['--commit-msg', file], { cwd: dir, env: scanEnv(dir) })).code, 0);
  writeFileSync(file, `Subject\n\nmail ola@kunde-firma.no\n`);
  const dirty = await runScan(['--commit-msg', file], { cwd: dir, env: scanEnv(dir) });
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /commit-message:3 {2}email/);
});

// ------------------------------------------------------------------------- hooks end to end

function copyTooling(dir, testScript) {
  mkdirSync(join(dir, 'scripts', 'security'), { recursive: true });
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  for (const file of ['secret-scan.mjs', 'secret-scan-lib.mjs', 'install-git-hooks.mjs']) {
    copyFileSync(join(repoRoot, 'scripts', 'security', file), join(dir, 'scripts', 'security', file));
  }
  for (const hook of HOOKS) {
    // Hooks run through sh: keep LF endings whatever the checkout did.
    writeFileSync(join(dir, '.githooks', hook), readFileSync(join(repoRoot, '.githooks', hook), 'utf8').replace(/\r\n/g, '\n'));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scan-hook-test', private: true, scripts: { test: testScript } }, null, 2));
}

test('installed hooks refuse a commit with a secret and a push that fails npm test or carries a secret', { timeout: 180_000 }, () => {
  const dir = makeRepo();
  const remote = tempDir('asoldi-scan-remote-');
  git(remote, ['init', '-q', '--bare']);
  git(dir, ['remote', 'add', 'origin', remote]);
  // The first push's npm test checks that the hook hands it a fresh throwaway data dir, never the
  // default ~/.asoldi-website-data (the operator's local hub data), and no production.env writes.
  writeFileSync(join(dir, 'data-dir-check.cjs'), [
    "const fs = require('fs'); const path = require('path'); const os = require('os');",
    "const d = process.env.APP_DATA_DIR || '';",
    "fs.writeFileSync('data-dir-seen.txt', d);",
    "const ok = d && fs.existsSync(d) && fs.readdirSync(d).length === 0",
    "  && path.resolve(d) !== path.join(os.homedir(), '.asoldi-website-data') && process.env.PERSIST_PRODUCTION_ENV === '0';",
    'process.exit(ok ? 0 : 1);',
    '',
  ].join('\n'));
  copyTooling(dir, 'node data-dir-check.cjs');
  const env = { ...process.env, SECRET_SCAN_ENV_FILES: '', ASOLDI_RETIRED_SECRETS: join(dir, 'none.json'), APP_DATA_DIR: '' };
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8', shell: false });

  const install = run(process.execPath, ['scripts/security/install-git-hooks.mjs']);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(git(dir, ['config', '--get', 'core.hooksPath']).trim(), '.githooks');

  run('git', ['add', '-A']);
  const init = run('git', ['commit', '-q', '-m', 'tooling']);
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);

  writeFileSync(join(dir, 'leak.js'), `export const k = '${FAKE_ANTHROPIC}';\n`);
  run('git', ['add', 'leak.js']);
  const refused = run('git', ['commit', '-q', '-m', 'leak']);
  assert.notEqual(refused.status, 0, 'pre-commit must refuse');
  assert.match(`${refused.stdout}${refused.stderr}`, /anthropic-key/);
  assert.equal(`${refused.stdout}${refused.stderr}`.includes(FAKE_ANTHROPIC), false);
  run('git', ['rm', '-q', '--cached', 'leak.js']);
  rmSync(join(dir, 'leak.js'));

  writeFileSync(join(dir, 'note.md'), 'a clean line\n');
  run('git', ['add', 'note.md']);
  const badMessage = run('git', ['commit', '-q', '-m', `add note\n\nkey ${FAKE_ANTHROPIC}`]);
  assert.notEqual(badMessage.status, 0, 'commit-msg must refuse a message with a key');
  assert.match(`${badMessage.stdout}${badMessage.stderr}`, /commit-message:3 {2}anthropic-key/);
  assert.equal(`${badMessage.stdout}${badMessage.stderr}`.includes(FAKE_ANTHROPIC), false);
  run('git', ['rm', '-q', '--cached', 'note.md']);
  rmSync(join(dir, 'note.md'));

  const pushOk = run('git', ['push', '-q', 'origin', 'main']);
  assert.equal(pushOk.status, 0, `${pushOk.stdout}${pushOk.stderr}`);
  const seenDataDir = readFileSync(join(dir, 'data-dir-seen.txt'), 'utf8').trim();
  assert.ok(seenDataDir, 'npm test ran with APP_DATA_DIR set');
  assert.equal(existsSync(seenDataDir), false, 'the hook removes the throwaway data dir after npm test');

  copyTooling(dir, 'node -e "process.exit(1)"');
  run('git', ['add', 'package.json']);
  assert.equal(run('git', ['commit', '-q', '-m', 'break tests']).status, 0);
  const pushFailingTests = run('git', ['push', '-q', 'origin', 'main']);
  assert.notEqual(pushFailingTests.status, 0, 'pre-push must refuse when npm test fails');
  assert.match(`${pushFailingTests.stdout}${pushFailingTests.stderr}`, /npm test failed; push refused/);

  copyTooling(dir, 'node -e "process.exit(0)"');
  run('git', ['add', 'package.json']);
  run('git', ['commit', '-q', '-m', 'fix tests']);
  writeFileSync(join(dir, 'sneaky.js'), `export const k = '${FAKE_ANTHROPIC}';\n`);
  run('git', ['add', 'sneaky.js']);
  assert.equal(run('git', ['commit', '-q', '--no-verify', '-m', 'bypass pre-commit']).status, 0);
  const pushSecret = run('git', ['push', '-q', 'origin', 'main']);
  assert.notEqual(pushSecret.status, 0, 'pre-push must refuse a pushed secret');
  assert.match(`${pushSecret.stdout}${pushSecret.stderr}`, /secret scan found something; push refused/);
  assert.equal(git(remote, ['rev-parse', 'main']).trim(), git(dir, ['rev-parse', 'HEAD~3']).trim(), 'remote still has only the first good push');
});

// ------------------------------------------------------------------------- this repo

test('this repo: no secret findings in tracked files, so every allowlisted hit is a fake fixture', async () => {
  const result = await runScan(['--tracked', '--secrets-only', '--no-env', '--no-retired'], { cwd: repoRoot, env: {} });
  assert.equal(result.code, 0, result.out);
  const allow = JSON.parse(readFileSync(join(repoRoot, '.secret-scan-allowlist.json'), 'utf8'));
  for (const entry of allow.entries) assert.ok(String(entry.reason || '').length > 10, `reason for ${entry.path}`);
});
