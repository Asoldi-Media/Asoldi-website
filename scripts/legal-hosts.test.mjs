// Every outbound host the hub, Maker and CMS code can reach has a row in the subprocessor register,
// the snapshots are current, and every AI provider allowed personal data is named in the privacy
// policy and the DPA appendix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

const SIBLING_DIRS = Object.freeze({ maker: 'website-maker', cms: 'website-cms' });

function isGitRepo(dir) {
  return Boolean(dir) && existsSync(join(dir, '.git'));
}

/**
 * The sibling repository for a snapshot check: LEGAL_HOSTS_<NAME>_REPO when set, else the
 * website-maker or website-cms checkout next to this repository (or next to its main checkout when
 * this is a worktree). The checks read it through git only (cat-file at a commit), never its
 * working tree.
 */
function siblingRepo(name) {
  const fromEnv = String(process.env[`LEGAL_HOSTS_${name.toUpperCase()}_REPO`] || '').trim();
  if (fromEnv) return isGitRepo(fromEnv) ? fromEnv : '';
  const candidates = [resolve(repoRoot, '..', SIBLING_DIRS[name])];
  try {
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const mainCheckout = dirname(isAbsolute(common) ? common : resolve(repoRoot, common));
    candidates.push(resolve(mainCheckout, '..', SIBLING_DIRS[name]));
  } catch {
    // not a git checkout (an export): only the plain sibling path
  }
  return candidates.find(isGitRepo) || '';
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

test('the hub snapshot matches a fresh scan of the committed code (HEAD)', async (t) => {
  if (!existsSync(join(repoRoot, '.git'))) {
    t.skip('no git checkout');
    return;
  }
  const committed = snapshot('hub');
  assert.equal(committed.ref, 'HEAD', 'the hub snapshot is taken from the committed code, never from local changes');
  const fresh = await scan.scanRepoHosts(repoRoot, { name: 'hub', ref: 'HEAD', egress: true });
  assert.deepEqual(scan.diffSnapshots(committed, fresh), { added: [], removed: [] }, 'run node scripts/legal/scan-hosts.mjs . --name hub --ref HEAD --egress --out scripts/legal/hosts-hub.json');
});

for (const name of ['maker', 'cms']) {
  const NAME = name.toUpperCase();
  const regenerate = `node scripts/legal/scan-hosts.mjs ../${SIBLING_DIRS[name]} --name ${name} --ref main --out scripts/legal/hosts-${name}.json`;

  test(`the ${name} snapshot names the commit it was taken from`, () => {
    const committed = snapshot(name);
    assert.match(String(committed.commit || ''), /^[0-9a-f]{40}$/, `${name}: record the source commit (${regenerate})`);
    assert.ok(committed.ref && committed.ref !== 'HEAD', `${name}: the snapshot names a branch or tag, not HEAD`);
  });

  test(`the ${name} snapshot matches its recorded commit in the ${name} repository`, async (t) => {
    const dir = siblingRepo(name);
    if (!dir) {
      t.skip(`no ${SIBLING_DIRS[name]} checkout found; set LEGAL_HOSTS_${NAME}_REPO to check it`);
      return;
    }
    const committed = snapshot(name);
    const ref = String(process.env[`LEGAL_HOSTS_${NAME}_REF`] || '').trim() || committed.commit;
    if (!scan.resolveCommit(dir, ref)) {
      t.skip(`${dir} does not have ${ref}; fetch it, or set LEGAL_HOSTS_${NAME}_REF to a ref it has`);
      return;
    }
    const fresh = await scan.scanRepoHosts(dir, { name, ref });
    assert.deepEqual(scan.diffSnapshots(committed, fresh), { added: [], removed: [] }, `scripts/legal/hosts-${name}.json differs from ${ref}: ${regenerate}`);
  });

  test(`every host the ${name} repository's branch reaches has a register row`, async (t) => {
    const dir = siblingRepo(name);
    const committed = snapshot(name);
    const branch = committed.ref || 'main';
    if (!dir || !scan.resolveCommit(dir, branch)) {
      t.skip(dir ? `${dir} has no ${branch}` : `no ${SIBLING_DIRS[name]} checkout found`);
      return;
    }
    const fresh = await scan.scanRepoHosts(dir, { name, ref: branch });
    assert.deepEqual(subprocessors.hostsWithoutRow(scan.snapshotHosts(fresh)), [], `${name} ${branch} reaches hosts without a register row: add rows to lib/legal/hosts-register.json and run ${regenerate}`);
    const { added, removed } = scan.diffSnapshots(committed, fresh);
    if (added.length || removed.length) t.diagnostic(`${name} ${branch} (${fresh.commit}) is newer than the snapshot (${committed.commit}): new ${added.join(', ') || 'none'}, gone ${removed.join(', ') || 'none'}. Run ${regenerate}.`);
  });
}

test('every host app/index.html loads is in the hub snapshot with a register row', () => {
  const html = readFileSync(join(repoRoot, 'app', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const loaded = new Set();
  for (const tag of html.matchAll(/<(script|iframe|img)\b[^>]*\bsrc\s*=\s*["']https?:\/\/([^/"']+)/gi)) loaded.add(tag[2].toLowerCase());
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?(stylesheet|preconnect|preload|dns-prefetch|modulepreload)/i.test(tag[0])) continue;
    const href = /\bhref\s*=\s*["']https?:\/\/([^/"']+)/i.exec(tag[0]);
    if (href) loaded.add(href[1].toLowerCase());
  }
  assert.ok(loaded.size >= 3, 'the page loads scripts and fonts from other hosts');
  const hub = new Set(scan.snapshotHosts(snapshot('hub')));
  for (const host of loaded) {
    assert.ok(hub.has(host), `${host} (app/index.html) is in scripts/legal/hosts-hub.json`);
    assert.ok(subprocessors.registerRowForHost(host), `${host} has a register row`);
  }
  assert.deepEqual([...scan.hostsInHtml(html)].filter((host) => !hub.has(host)), [], 'the scanner finds the same hosts');
});

test('the meeting booking widget is a processor named in the privacy policy', () => {
  const hub = new Set(scan.snapshotHosts(snapshot('hub')));
  const privacy = render.documentPlainText(render.renderDocument('personvern', { retentionText: null }));
  for (const host of ['calendly.com', 'assets.calendly.com']) {
    assert.ok(hub.has(host), host);
    assert.equal(subprocessors.registerRowForHost(host)?.row?.processor, 'calendly', host);
  }
  assert.match(privacy, /Calendly \(Calendly LLC, USA/);
});

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
  assert.equal(scan.isScannedPath('app/index.html'), true);
  assert.equal(scan.isScannedPath('scratch/page.html'), false, 'scratch pages are not served');
  assert.equal(scan.isScannedPath('template-import/shop/pages/home.html'), false, 'imported template sources are not served');
  assert.equal(scan.isScannedPath('.tmp-preview.html'), false);
  assert.deepEqual(scan.sdkHostsForPackage(JSON.stringify({ dependencies: { stripe: '1', express: '4' } })), ['api.stripe.com']);
});

test('the scanner counts what React pages load: images, media, styles and widget URLs, not links', () => {
  const tsx = [
    "{ name: 'Kafe', image: 'https://images.photo-cdn.io/a.jpg', websiteUrl: 'https://kafe-site.io' },",
    "dashboardImageUrl: 'https://shots.cdn-two.io/d.png',",
    "const PROMO_EMBED_URL = 'https://player.video-host.io/embed/1';",
    "style={{ backgroundImage: 'url(https://bg.cdn-three.io/b.png)' }}",
    "description: 'https://described.only.io/page',",
    "logoutUrl: 'https://account.logout-only.io',",
    "const homepage = 'https://not-a-widget.io/x';",
  ].join('\n');
  assert.deepEqual([...scan.hostsInSource(tsx, 'app/x.tsx')].sort(), ['bg.cdn-three.io', 'images.photo-cdn.io', 'player.video-host.io', 'shots.cdn-two.io']);
  const widget = [
    "const bookingUrl = useMemo(() => {",
    "  const base = 'https://booking.widget-host.io/team/30-min';",
    "  return base;",
    "}, []);",
    "window.Booker.initInlineWidget({ url: bookingUrl, parentElement: el });",
  ].join('\n');
  assert.deepEqual([...scan.hostsInSource(widget, 'app/Booking.tsx')], ['booking.widget-host.io'], 'a URL constant in a file that starts a widget');
  assert.deepEqual([...scan.hostsInSource(widget.replace('initInlineWidget', 'open'), 'app/Booking.tsx')], [], 'negative control: the same constant without a widget');
  assert.equal(scan.isAssetKey('backgroundImageUrl'), true);
  assert.equal(scan.isAssetKey('transcriptUrl'), false);
});

test('the scanner reads pages: sources, loading links, form actions, styles and inline scripts, not links or comments', () => {
  const html = [
    '<link rel="canonical" href="https://canonical-only.io/">',
    '<link rel="preconnect" href="https://fonts.pre-host.io">',
    '<link href="https://styles.css-host.io/a.css" rel="stylesheet">',
    '<script src="https://widget.js-host.io/w.js" async></script>',
    '<!-- <script src="https://commented.js-host.io/x.js"></script> -->',
    '<a href="https://clicked-link.io">x</a>',
    '<img src="https://img.image-host.io/a.png" alt="">',
    '<iframe src="https://frame.embed-host.io/v/1"></iframe>',
    '<form action="https://forms.post-host.io/submit" method="post"></form>',
    '<div style="background:url(https://bg.style-host.io/b.png)"></div>',
    '<style>@import "https://imported.style-host.io/i.css"; .x { background: url("https://inline.style-host.io/c.png") }</style>',
    '<script>fetch("https://api.inline-host.io/v1");</script>',
    '<script type="application/ld+json">{"url":"https://jsonld-only.io/"}</script>',
  ].join('\n');
  assert.deepEqual([...scan.hostsInHtml(html)].sort(), [
    'api.inline-host.io',
    'bg.style-host.io',
    'fonts.pre-host.io',
    'forms.post-host.io',
    'frame.embed-host.io',
    'img.image-host.io',
    'imported.style-host.io',
    'inline.style-host.io',
    'styles.css-host.io',
    'widget.js-host.io',
  ]);
  assert.deepEqual([...scan.hostsInSource(html, 'public/page.html')].sort(), [...scan.hostsInHtml(html)].sort());
});

test('with a ref, the egress allowlist is read from that commit, not the working tree', async (t) => {
  if (!existsSync(join(repoRoot, '.git'))) {
    t.skip('no git checkout');
    return;
  }
  const atHead = await scan.egressAllowlistHosts(repoRoot, { ref: 'HEAD' });
  assert.ok(atHead.includes('api.anthropic.com'));
  const fromSnapshot = snapshot('hub').hosts.filter((entry) => entry.via.includes('egress')).map((entry) => entry.host).sort();
  assert.deepEqual([...atHead].sort(), fromSnapshot);
  assert.deepEqual(await scan.egressAllowlistHosts(repoRoot, { ref: 'no-such-ref-for-this-test' }).catch(() => []), [], 'an unknown ref yields nothing');
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
  for (const name of ['Myphoner', 'Deepgram', 'Luca Regnskap', 'Fireflies.ai', 'Brevo', 'Resend', 'Stripe', 'Hostinger', 'GitHub', 'PayPal']) {
    assert.ok(privacy.includes(`${name} (`), name);
  }
});

test('every processor in the register that gets personal data is named in the privacy policy, whatever its scope', () => {
  const privacy = render.documentPlainText(render.renderDocument('personvern', { retentionText: null }));
  const seen = new Set();
  for (const scope of ['asoldi', 'client']) {
    for (const entry of subprocessors.subprocessorList({ scope })) {
      if (!entry.personalData || entry.id === 'thirdPartyContent' || seen.has(entry.id)) continue;
      seen.add(entry.id);
      assert.ok(privacy.includes(`${entry.name} (`), `${entry.name} (${scope}) in the privacy policy`);
    }
  }
  assert.ok(seen.size >= 10);
  // Negative control: a client-only processor with personal data added to the register shows up too.
  const register = JSON.parse(JSON.stringify(subprocessors.HOSTS_REGISTER));
  register.processors.extra = { name: 'Ekstra Lagring', entity: 'Ekstra Lagring AS', region: 'EØS', role: 'lagrer filer for kunder', scopes: ['client'] };
  register.hosts['files.extra-lagring.example'] = { processor: 'extra', purpose: 'filer', dataCategories: ['filer'], region: 'EØS' };
  const withExtra = render.documentPlainText(render.renderDocument('personvern', { retentionText: null, register }));
  assert.ok(withExtra.includes('Ekstra Lagring ('));
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
