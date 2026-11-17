// Developer board UI: render budget, one poll, the dark switch, and the report panel.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
process.env.APP_DATA_DIR = process.env.APP_DATA_DIR || '/tmp/hubdata';
process.env.HUB_SAFE_MODE = '1';

const loc = {
  hostname: 'hub.example',
  protocol: 'https:',
  pathname: '/developer',
  href: 'https://hub.example/developer',
  search: '',
};
if (!globalThis.location) globalThis.location = loc;
if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}
if (!globalThis.document) {
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement() { return { style: {} }; },
    body: { appendChild() {}, removeChild() {} },
  };
}

const esbuild = (await import('esbuild')).default;
const { createElement, Fragment } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router-dom');
const bundleDir = join(root, 'build', 'board-ui-render');
mkdirSync(bundleDir, { recursive: true });
const bundleFile = join(bundleDir, 'render.mjs');
const bundled = await esbuild.build({
  stdin: {
    sourcefile: 'board-ui-entry.tsx',
    resolveDir: root,
    loader: 'tsx',
    contents: [
      "export { DeliveryBoard } from './app/pages/developer/DeliveryBoard';",
      "export { DeliveryCard } from './app/pages/developer/DeliveryCard';",
      "export { createBoardPollScheduler, BOARD_POLL_MS } from './app/pages/developer/board/useBoardPoll';",
      "export { LANES } from './app/pages/developer/board/lanes';",
      "export { DevReportPanel } from './app/pages/developer/board/DevReportPanel';",
      "export { BlockingFixActions, fixActionElement } from './app/pages/developer/board/BlockingFixActions';",
      "export { DeveloperWorkspace, devBoardEnabled } from './app/pages/developer/DeveloperWorkspace';",
      "export { DevelopmentClientsSection } from './app/pages/Admin/sections/DevelopmentClientsSection';",
      "export { HelmetProvider, Helmet } from 'react-helmet-async';",
    ].join('\n'),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  logLevel: 'silent',
  define: { 'import.meta.env': '{}' },
  external: ['react', 'react-dom', 'react-dom/server', 'react-router-dom', 'lucide-react'],
});
writeFileSync(bundleFile, bundled.outputFiles[0].text);
const ui = await import(pathToFileURL(bundleFile).href);
test.after(() => rmSync(bundleDir, { recursive: true, force: true }));

const {
  DeliveryBoard,
  DeliveryCard,
  createBoardPollScheduler,
  BOARD_POLL_MS,
  LANES,
  DevReportPanel,
  BlockingFixActions,
  fixActionElement,
  DeveloperWorkspace,
  devBoardEnabled,
  DevelopmentClientsSection,
  HelmetProvider,
  Helmet,
} = ui;

const boardFixture = JSON.parse(readFileSync(new URL('./fixtures/delivery-board/board.json', import.meta.url), 'utf8'));
const detailFixture = JSON.parse(readFileSync(new URL('./fixtures/delivery-board/detail.json', import.meta.url), 'utf8'));
const reportFixture = JSON.parse(readFileSync(new URL('./fixtures/delivery-board/dev-report.json', import.meta.url), 'utf8'));

const BUSINESSES = [
  'Solsiden Bakeri', 'Nordlys Tannklinikk', 'Eksempel Fotoatelier', 'Fjordbru Rørlegger',
  'Granli Blomster', 'Havbris Kafé', 'Lund Elektro', 'Myrull Garn', 'Neset Sykkel',
  'Osp Frisør', 'Pilen Bokhandel', 'Revheim Glass', 'Sjøtun Fisk', 'Torv Bakeri',
  'Ullern Optikk', 'Viken Maling', 'Ytre Rens', 'Åsund Verksted', 'Bjørk Tannlege',
  'Dalen Catering', 'Eik Interiør', 'Foss Skilt', 'Gilje Transport', 'Holm Regnskap',
  'Iversen Trykk', 'Jordet Gartneri', 'Klepp Musikk', 'Lien Apotek', 'Moen Flis',
  'Nygård Søm',
];
const STAGES = ['signed', 'gathering', 'workshop_held', 'gate', 'developing', 'dev_review', 'client_preview', 'iterating', 'approved', 'live'];

function syntheticItem(index) {
  const stage = STAGES[index % STAGES.length];
  return {
    id: `sales:example-${index}`,
    salesClientId: `example-${index}`,
    businessName: BUSINESSES[index],
    product: 'asoldi',
    contractSigned: true,
    developerOwnerId: index % 2 ? 'developer:example' : 'developer:other',
    offerTierId: index % 3 === 0 ? 'tier-2-seo' : 'tier-1-standard',
    deliveryStage: stage,
    websiteDue: { dueAt: new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 86_400_000).toISOString() },
    sitePlan: { tierId: index % 3 === 0 ? 'tier-2-seo' : 'tier-1-standard', services: ['site'] },
    delivery: { stage, job: index % 5 === 0 ? { blocking: 'needs-pages', status: 'blocked' } : null },
    hostStatus: { hostId: 'mh_example', online: index % 2 === 0 },
    aiSpendSummary: { totalUsd: index / 10, calls: index },
  };
}

function render(element) {
  return renderToStaticMarkup(element);
}

function wrapped(element) {
  return render(createElement(HelmetProvider, null, createElement(MemoryRouter, null, element)));
}

function boardSources() {
  const dir = join(root, 'app/pages/developer/board');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => ({
      path: `app/pages/developer/board/${name}`,
      source: readFileSync(join(dir, name), 'utf8'),
    }));
  for (const name of ['DeliveryBoard.tsx', 'DeliveryCard.tsx']) {
    files.push({
      path: `app/pages/developer/${name}`,
      source: readFileSync(join(root, 'app/pages/developer', name), 'utf8'),
    });
  }
  return files;
}

/** One hit per offending line. setInterval belongs only in the board poll. */
function scanPollViolations(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    lines.forEach((line, index) => {
      const reasons = [];
      if (/\bsetInterval\s*\(/.test(line) && !file.path.endsWith('useBoardPoll.ts')) reasons.push('setInterval');
      const timer = line.match(/\bset(?:Interval|Timeout)\s*\((?:[^;]|\([^)]*\))*,\s*(\d[\d_]*)/);
      if (timer && Number(String(timer[1]).replace(/_/g, '')) <= 2000) reasons.push('short-timer');
      if (reasons.length) hits.push({ file: file.path, line: index + 1, reasons });
    });
    if (file.path.endsWith('DeliveryCard.tsx')) {
      let cursor = 0;
      while (cursor < file.source.length) {
        const at = file.source.indexOf('useEffect', cursor);
        if (at === -1) break;
        const slice = file.source.slice(at, at + 600);
        if (/fetch\(/.test(slice)) {
          hits.push({ file: file.path, line: file.source.slice(0, at).split('\n').length, reasons: ['mount-fetch'] });
        }
        cursor = at + 'useEffect'.length;
      }
    }
  }
  return hits;
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let soonest = null;
        for (const timer of timers.values()) {
          if (timer.next <= end && (!soonest || timer.next < soonest.next)) soonest = timer;
        }
        if (!soonest) {
          now = end;
          return;
        }
        now = soonest.next;
        soonest.next += soonest.ms;
        await soonest.fn();
      }
    },
  };
}

function maxInMinute(times) {
  let max = 0;
  for (const time of times) {
    const count = times.filter((other) => other > time - 60_000 && other <= time).length;
    if (count > max) max = count;
  }
  return max;
}

test('30 synthetic cards render in under 300 ms', async () => {
  const snapshot = { developmentItems: Array.from({ length: 30 }, (_, index) => syntheticItem(index)) };
  const once = () => {
    const started = performance.now();
    const html = render(createElement(DeliveryBoard, { snapshot, poll: false, pageHostname: 'hub.example' }));
    const elapsed = performance.now() - started;
    const count = (html.match(/data-testid="delivery-card-/g) || []).length;
    assert.ok(count > 0, 'card count');
    assert.equal(count, 30);
    return elapsed;
  };
  once();
  const samples = [];
  for (let index = 0; index < 5; index += 1) samples.push(once());
  samples.sort((a, b) => a - b);
  const median = samples[2];
  assert.ok(median < 300, `median ${median.toFixed(1)} ms from ${samples.map((value) => value.toFixed(1)).join(', ')}`);
});

test('poll budget: at most 4 requests a minute while idle, and none while hidden', async () => {
  async function drive(hidden) {
    const times = [];
    const clock = fakeClock();
    const scheduler = createBoardPollScheduler({
      intervalMs: BOARD_POLL_MS,
      clock,
      hidden: () => hidden,
      poll: async () => {
        times.push(clock.now());
        return { rev: times.length };
      },
    });
    scheduler.start();
    await clock.advance(5 * 60 * 1000);
    scheduler.stop();
    return times;
  }
  const idle = await drive(false);
  const hidden = await drive(true);
  assert.ok(idle.length > 0, 'idle requests');
  assert.equal(idle.length, 20, 'one request each 15 seconds for 5 minutes');
  assert.ok(maxInMinute(idle) <= 4, `peak ${maxInMinute(idle)} in one minute`);
  assert.equal(hidden.length, 0);
});

test('poll scan is clean, and a planted short interval is exactly one hit', () => {
  const files = boardSources();
  assert.ok(files.length > 10);
  assert.deepEqual(scanPollViolations(files), []);
  const planted = files.map((file) => (
    file.path.endsWith('DeliveryCard.tsx')
      ? { ...file, source: `${file.source}\nsetInterval(() => { fetch('/api/card'); }, 2000);\n` }
      : file
  ));
  const hits = scanPollViolations(planted);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file.endsWith('DeliveryCard.tsx'), true);
});

test('preview and SSU stay visible, unknown stages stay visible, and lane titles match', () => {
  const snapshot = {
    ...boardFixture,
    developmentItems: [
      ...boardFixture.developmentItems,
      {
        id: 'sales:unknown-1',
        salesClientId: 'unknown-1',
        businessName: 'Ukjent Verksted',
        product: 'asoldi',
        contractSigned: true,
        deliveryStage: 'not-a-real-stage',
        websiteDue: { dueAt: '2026-12-20T10:00:00.000Z' },
      },
    ],
  };
  const html = render(createElement(DeliveryBoard, { snapshot, poll: false, pageHostname: 'hub.example' }));
  assert.match(html, /data-testid="board-lane-preview"[\s\S]*Nordlys Tannklinikk/);
  assert.match(html, /data-testid="ssu-section"[\s\S]*Eksempel Fotoatelier/);
  assert.match(html, /data-testid="board-lane-unknown"[\s\S]*Ukjent Verksted/);
  assert.match(html, /data-testid="delivery-card-unknown-1"/);
  assert.match(html, /data-stage="not-a-real-stage"/);
  assert.equal(html.includes('Utsatt'), false);
  for (const lane of LANES) {
    assert.match(html, new RegExp(`data-testid="board-lane-${lane.key}"[\\s\\S]*?${lane.title.replace(/[()]/g, '\\$&')}`));
  }
  assert.match(html, /Ukjent steg/);
});

test('switch off matches the legacy tree and adds no board marker', () => {
  assert.equal(devBoardEnabled(undefined), false);
  assert.equal(devBoardEnabled(null), false);
  assert.equal(devBoardEnabled({}), false);
  assert.equal(devBoardEnabled({ devBoardV2: false }), false);
  assert.equal(devBoardEnabled({ devBoardV2: true }), true);

  const off = wrapped(createElement(DeveloperWorkspace, { initialStatus: 'ready', settings: {} }));
  const missing = wrapped(createElement(DeveloperWorkspace, { initialStatus: 'ready' }));
  const legacy = wrapped(createElement(LegacyReady));
  assert.equal(off, legacy);
  assert.equal(missing, legacy);
  assert.equal(off.includes('data-testid="delivery-board"'), false);
  assert.equal(off.includes('data-testid="legacy-view-toggle"'), false);
  assert.equal(off.includes('Gammel visning'), false);

  const on = wrapped(createElement(DeveloperWorkspace, { initialStatus: 'ready', settings: { devBoardV2: true } }));
  assert.match(on, /data-testid="delivery-board"/);
  assert.match(on, /data-testid="legacy-view-toggle"/);
  assert.match(on, /Gammel visning/);
  assert.equal(on.includes('Utviklerterminal</h1>'), false);

  const old = wrapped(createElement(DeveloperWorkspace, { initialStatus: 'ready', settings: { devBoardV2: true }, startLegacy: true }));
  assert.match(old, /data-testid="legacy-view-toggle"/);
  assert.match(old, /Utviklerterminal/);
  assert.equal(old.includes('data-testid="delivery-board"'), false);
});

function LegacyReady() {
  return createElement(
    Fragment,
    null,
    createElement(
      Helmet,
      null,
      createElement('title', null, 'Utviklerterminal – Asoldi'),
      createElement('meta', { name: 'robots', content: 'noindex,nofollow' }),
    ),
    createElement(
      'div',
      { className: 'staff-light developer-fill flex h-dvh w-full flex-col overflow-hidden bg-[#1a1a1a] text-white' },
      createElement(DevelopmentClientsSection, { onLogout: () => {} }),
    ),
  );
}

test('dev report shows stage, gate, brief and counts, and an empty report stays empty', () => {
  const html = render(createElement(DevReportPanel, {
    itemId: 'sales:bakery-1',
    response: reportFixture,
    gate: detailFixture.detail.gate,
  }));
  assert.match(html, /data-testid="dev-report-panel"/);
  assert.match(html, /review/);
  assert.match(html, /sha256:c4c0a5054a09953f/);
  assert.match(html, /4 av 6/);
  assert.match(html, /Forslag/);
  assert.match(html, /ikke en beslutning/);
  assert.match(html, /1 bildefelt uten godkjent bilde/);
  assert.match(html, /data-shot-src="[^"]*dev-report\/shots\/ds_20261201_0900_b1\/thumb_01/);
  assert.doesNotMatch(html, /<img[^>]*src="[^"]*dev-report\/shots/);
  assert.match(html, /Port:/);
  const onCard = render(createElement(DeliveryCard, {
    item: boardFixture.developmentItems[0],
    pageHostname: 'hub.example',
    defaultExpanded: true,
    initialCache: {
      detail: detailFixture.detail,
      report: reportFixture,
      directives: [{ id: 'dir-bakeri01', status: 'open', ask: 'Flytt åpningstiden' }],
    },
  }));
  assert.match(onCard, /data-testid="dev-report-panel"/);
  assert.match(onCard, /data-testid="gate-panel"/);
  assert.match(onCard, /4 av 6/);
  assert.match(onCard, /sha256:c4c0a5054a09953f/);
  const empty = render(createElement(DevReportPanel, { itemId: 'sales:bakery-1', response: null }));
  assert.match(empty, /Ingen rapport ennå/);
  assert.equal(empty.includes('Forslag'), false);
  const blank = render(createElement(DevReportPanel, { itemId: 'sales:bakery-1', response: { report: null } }));
  assert.match(blank, /Ingen rapport ennå/);
});

test('each fix action opens its target in the element tree', () => {
  const item = boardFixture.developmentItems[0];
  const closed = render(createElement(BlockingFixActions, {
    item,
    codes: ['needs-language', 'needs-pages'],
    pageHostname: 'hub.example',
  }));
  assert.match(closed, /data-testid="blocking-fix-needs-language"/);
  assert.match(closed, /data-testid="blocking-fix-needs-pages"/);
  assert.match(closed, /Lås språk/);
  assert.match(closed, /Velg sider/);

  const language = fixActionElement('needs-language', item, 'hub.example', () => {});
  const pages = fixActionElement('needs-pages', item, 'hub.example', () => {});
  assert.equal(language.type.name, 'DeveloperLanguageLockPopup');
  assert.equal(pages.type.name, 'DeveloperPagesPopup');
  assert.throws(() => render(language), /Portal|DOM element/);
  assert.throws(() => render(pages), /Portal|DOM element/);
});

test('safety scan: no raw html, every fetch uses auth headers, no loopback literal', () => {
  const files = [
    ...boardSources(),
    {
      path: 'app/pages/developer/DeveloperWorkspace.tsx',
      source: readFileSync(join(root, 'app/pages/developer/DeveloperWorkspace.tsx'), 'utf8'),
    },
  ];
  assert.ok(files.length > 10);
  let fetches = 0;
  for (const file of files) {
    assert.equal(file.source.includes('dangerouslySetInnerHTML'), false, file.path);
    assert.equal(file.source.includes('127.0.0.1'), false, file.path);
    const fetchCount = (file.source.match(/\bfetch\s*\(/g) || []).length;
    fetches += fetchCount;
    if (fetchCount > 0 && !file.source.includes('Authorization: `Bearer')) {
      assert.match(file.source, /authHeaders\s*\(/, file.path);
      assert.ok((file.source.match(/authHeaders\s*\(/g) || []).length >= 1, file.path);
    }
  }
  assert.ok(fetches > 0, 'fetches scanned');
});

test('every job kind the board posts is one the admin jobs route accepts', () => {
  const route = readFileSync(join(root, 'lib/routes/delivery-jobs-routes.js'), 'utf8');
  const allowed = [...route.match(/ADMIN_ENQUEUE_KINDS = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(allowed.length > 0);
  const posted = [];
  for (const file of boardSources()) {
    for (const m of file.source.matchAll(/'\/admin\/delivery\/jobs'[^)]*kind:\s*'([^']+)'/g)) posted.push(m[1]);
  }
  for (const kind of posted) assert.ok(allowed.includes(kind), `kind ${kind} is not allowed by the route`);
  const jobPanel = boardSources().find((file) => file.path.endsWith('JobPanel.tsx'));
  assert.doesNotMatch(jobPanel.source, /dev_accept|kind: 'continue'/);
});

test('the board switch is seeded server side and round-trips through the settings', async () => {
  const settings = await import(pathToFileURL(join(root, 'data/automation-settings.js')).href);
  const defaults = settings.defaultAutomationSettings();
  assert.equal(defaults.development.boardV2, false);
  const on = settings.validateAutomationSettings({ development: { boardV2: true } }, { current: defaults });
  assert.equal(on.ok, true);
  assert.equal(on.value.development.boardV2, true);
  assert.equal(settings.validateAutomationSettings({ development: { boardV2: 'yes' } }, { current: defaults }).ok, false);
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.match(server, /settings: \{ devBoardV2: developmentBoardV2Enabled\(\) \}/);
  assert.equal(devBoardEnabled({ devBoardV2: true }), true);
});

test('a failed poll reports the error and a slow poll never overlaps', async () => {
  const clock = fakeClock();
  let errors = 0;
  let calls = 0;
  const failing = createBoardPollScheduler({
    intervalMs: BOARD_POLL_MS,
    clock,
    hidden: () => false,
    poll: async () => { throw new Error('board-status'); },
    onError: () => { errors += 1; },
  });
  failing.start();
  await clock.advance(BOARD_POLL_MS * 2);
  failing.stop();
  assert.ok(errors >= 1, 'onError called');
  const slowClock = fakeClock();
  let release;
  const slow = createBoardPollScheduler({
    intervalMs: BOARD_POLL_MS,
    clock: slowClock,
    hidden: () => false,
    poll: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); },
  });
  slow.start();
  await slowClock.advance(BOARD_POLL_MS * 4);
  assert.equal(calls, 1, 'one request in flight at a time');
  release({});
  slow.stop();
});

test('cards refresh their cache after a panel change, and keyword approval reports a result', () => {
  const card = readFileSync(join(root, 'app/pages/developer/DeliveryCard.tsx'), 'utf8');
  assert.match(card, /<GatePanel[^>]*onUpdated=\{refresh\}/);
  assert.match(card, /<DirectiveList[^>]*onChanged=\{refresh\}/);
  assert.match(card, /<JobPanel[^>]*onChanged=\{refresh\}/);
  assert.match(card, /data-testid="keywords-msg"/);
  assert.doesNotMatch(card, /\.find\(\(row\) => row\.status === 'proposed'\)\?\.phrase/);
});
