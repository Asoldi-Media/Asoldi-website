// Negative controls for the privacy switches against the base commit (PRIVACY_DARK_REF, default
// 9fceb2d, the live release this branch builds on: it stores two meeting fields on the sales card
// that 859429c lacks), extracted with `git archive` into build/ (ignored):
//   1. With every switch off, the Fireflies link and unlink paths (admin link, automatic link, purpose
//      pick, admin unlink, move, exclude, backfill) and the ingest store paths (list page, full fetch,
//      media write, failed fetch) write byte-identical data to the base commit and return the same.
//      Positive controls show the comparison notices the archive once privacy.archive is on, and an
//      erased recording once an erase has put it on the erased list.
//   2. The client portal upload sections (media, staff, products, logos and affiliations) render
//      byte-identical markup to the base commit while the rights checkbox is off, and no line added to
//      the onboarding and settings pages since then carries rights checkbox code.
// Skipped (with a note) when git or the base commit is not available, e.g. in a plain file export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = String(process.env.PRIVACY_DARK_REF || '9fceb2d').trim();
const flow = join(root, 'scripts', 'fixtures', 'privacy-link-flow.mjs');

function baseSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', `${REF}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

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

const SHA = baseSha();
const skip = SHA ? false : `base commit ${REF} is not available here`;
let baseRoot = '';

test.before(() => {
  if (!SHA) return;
  baseRoot = join(root, 'build', `privacy-dark-${SHA}`);
  rmSync(baseRoot, { recursive: true, force: true });
  mkdirSync(baseRoot, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', SHA, 'data', 'lib', 'packages', 'app'], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  untar(tar, baseRoot);
});

test.after(() => {
  if (baseRoot) rmSync(baseRoot, { recursive: true, force: true });
});

function seed(dataDir, settings = null, erasedIds = []) {
  const at = '2026-10-01T10:00:00.000Z';
  writeFileSync(join(dataDir, 'sales-clients.json'), JSON.stringify([
    { id: 'flow-a', product: 'asoldi', businessName: 'Flyt A AS', contactEmail: 'a@example.com', status: 'active', createdAt: at, updatedAt: at, progression: { meetingHeld: true } },
    { id: 'flow-b', product: 'asoldi', businessName: 'Flyt B AS', contactEmail: 'b@example.com', status: 'active', createdAt: at, updatedAt: at, progression: {} },
  ], null, 2));
  writeFileSync(join(dataDir, 'fireflies-meetings.json'), JSON.stringify({
    'flow-rec-1': { meetingId: 'flow-rec-1', title: 'Salgsmøte', startedAt: '2026-10-20T10:00:00.000Z', transcript: 'A: Hei.\nB: Hei.', summary: 'Kort.', at, firstSeenAt: at, final: true },
    'flow-rec-2': { meetingId: 'flow-rec-2', title: 'Workshop', startedAt: '2026-10-25T10:00:00.000Z', transcript: 'A: Workshop.\nB: Ja.', at, firstSeenAt: at, final: true },
  }, null, 2));
  if (settings) writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify(settings, null, 2));
  if (erasedIds.length) {
    mkdirSync(join(dataDir, 'privacy'), { recursive: true });
    const meetings = Object.fromEntries(erasedIds.map((id) => [id, { erasedAt: '2026-10-31T10:00:00.000Z' }]));
    writeFileSync(join(dataDir, 'privacy', 'erased-meetings.json'), JSON.stringify({ kind: 'asoldi.erased-meetings/1', meetings }, null, 2));
  }
}

function tree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runFlow(codeRoot, settings = null, { erasedIds = [], withOutput = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-privacy-dark-'));
  try {
    seed(dataDir, settings, erasedIds);
    const env = { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: '', DATA_BACKUP_KEEP: '5' };
    const out = execFileSync(process.execPath, [flow, '--code-root', codeRoot], { cwd: root, env, encoding: 'utf8' });
    assert.match(out, /"backfill"/);
    assert.match(out, /"ingest"/);
    return withOutput ? { files: tree(dataDir), out: out.trim().split('\n').pop() } : tree(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('with every switch off the link, unlink and ingest paths write byte-identical data to the base commit', { skip }, () => {
  const base = runFlow(baseRoot, null, { withOutput: true });
  const ours = runFlow(root, null, { withOutput: true });
  // A stamped backup (<file>.<time>.json) is named to the millisecond. Writes of one file inside the
  // same millisecond now keep one backup each, where the base commit kept only the last, so the number of
  // stamped backups may differ; the data files and the .latest.json copies must still be byte-identical.
  const withoutStamped = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => !/^backups\/.+\.\d{4}-\d\d-\d\dT[\d-]+Z\.json$/.test(name)));
  base.files = withoutStamped(base.files);
  ours.files = withoutStamped(ours.files);
  assert.deepEqual(Object.keys(ours.files).sort(), Object.keys(base.files).sort(), 'the same files');
  for (const [name, body] of Object.entries(base.files)) assert.equal(ours.files[name], body, `${name} is byte-identical`);
  assert.ok(Object.keys(base.files).includes('sales-clients.json'));
  assert.equal(ours.out, base.out, 'the ingest paths return the same');
  assert.match(base.out, /"flow-rec-3",true,true/, 'the run stored a new recording');
});

test('positive control: an erased recording is not stored again where the base commit stores it (the comparison sees it)', { skip }, () => {
  const base = runFlow(baseRoot, null, { erasedIds: ['flow-rec-3', 'flow-rec-4'] });
  const ours = runFlow(root, null, { erasedIds: ['flow-rec-3', 'flow-rec-4'] });
  const baseMeetings = JSON.parse(base['fireflies-meetings.json']);
  const ourMeetings = JSON.parse(ours['fireflies-meetings.json']);
  assert.ok(baseMeetings['flow-rec-3'] && baseMeetings['flow-rec-4'], 'the base commit stores them');
  assert.equal(ourMeetings['flow-rec-3'], undefined);
  assert.equal(ourMeetings['flow-rec-4'], undefined);
  assert.ok(ourMeetings['flow-rec-1'] && ourMeetings['flow-rec-2'], 'the other recordings are untouched');
});

test('positive control: with privacy.archive on the same flow writes the archive (the comparison sees it)', { skip }, () => {
  const base = runFlow(baseRoot);
  const ours = runFlow(root, { privacy: { archive: { enabled: true } } });
  const extra = Object.keys(ours).filter((name) => !(name in base));
  assert.ok(extra.some((name) => name.startsWith('transcript-archive/flow-b/')), extra.join(', '));
});

async function renderSections(codeRoot, data) {
  const esbuild = await import('esbuild');
  const dir = join(codeRoot, 'app', 'components', 'client', 'settings');
  const entry = [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    "import { MediaSection } from './MediaSection';",
    "import { StaffSection } from './StaffSection';",
    "import { ProductsSection } from './ProductsSection';",
    "import { GeneralInfoSection } from './GeneralInfoSection';",
    "import { MemoryRouter } from 'react-router-dom';",
    `const data = ${JSON.stringify(data)};`,
    "const props = { token: 'client-token', clientData: data, setClientData: () => {}, onError: () => {} };",
    'export const html = {',
    '  media: renderToStaticMarkup(React.createElement(MediaSection, props)),',
    '  staff: renderToStaticMarkup(React.createElement(StaffSection, props)),',
    '  products: renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(ProductsSection, props))),',
    '  general: renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(GeneralInfoSection, props))),',
    '};',
  ].join('\n');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: dir, loader: 'tsx', sourcefile: 'render-entry.tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    packages: 'external',
    logLevel: 'silent',
    define: { 'import.meta.env': '{}' },
  });
  // Written under build/ (ignored) so the external packages resolve from this repo's node_modules.
  const outDir = mkdtempSync(join(root, 'build', 'privacy-render-'));
  const file = join(outDir, 'render.mjs');
  writeFileSync(file, result.outputFiles[0].text);
  try {
    const mod = await import(`${new URL(`file:///${file.replace(/\\/g, '/')}`).href}?t=${Date.now()}`);
    return mod.html;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

test('the portal upload sections render byte-identical markup while the rights checkbox is off', { skip }, async () => {
  const data = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'privacy-client-bank.json'), 'utf8'));
  const base = await renderSections(baseRoot, data);
  const ours = await renderSections(root, data);
  for (const key of ['media', 'staff', 'products', 'general']) {
    assert.ok(base[key].length > 100, `${key} rendered`);
    assert.equal(ours[key], base[key], `${key} section markup is byte-identical`);
  }
  // Other features may change these pages after the base commit (a legal card on the settings page,
  // for example); none of the lines added since may carry the rights checkbox or its route.
  const RIGHTS_CODE = /MediaRights|mediaRights|media-rights|rightsConfirm/;
  for (const page of ['app/pages/client/ClientOnboarding.tsx', 'app/pages/client/ClientSettings.tsx']) {
    const baseLines = new Map();
    for (const line of readFileSync(join(baseRoot, page), 'utf8').split(/\r?\n/)) baseLines.set(line, (baseLines.get(line) || 0) + 1);
    const added = [];
    for (const line of readFileSync(join(root, page), 'utf8').split(/\r?\n/)) {
      const left = baseLines.get(line) || 0;
      if (left) baseLines.set(line, left - 1);
      else added.push(line);
    }
    assert.deepEqual(added.filter((line) => RIGHTS_CODE.test(line)), [], `${page}: no rights checkbox code added`);
  }
  assert.ok(existsSync(join(root, 'app', 'components', 'client', 'settings', 'MediaRightsCheckbox.tsx')));
});
