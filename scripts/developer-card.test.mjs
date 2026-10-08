import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWorkshopNeeds } from '../lib/workshop-needs.js';
import { scoreClientMaterials } from '../lib/client-material-dots.js';
import { asoldiLocalMakerPayload, editorMakerOrigin, makerOriginsMatch, makerUnreachableIsLocal } from '../lib/maker-editor-origin.js';
import {
  DEVELOPER_PROGRESS_CHIPS,
  DEVELOPER_QA_LABELS,
  WORKSHOP_NOT_HELD_MESSAGE,
  developerCardTimeline,
  developerMaterialsView,
  developerMediaLibraryView,
  developerSummaryView,
  developerChipVisual,
  draftPhaseView,
  makerCustomEditPath,
  makerHandoffFromLiveRun,
  makerHandoffNeedsPersist,
  makerLatestPreviewPath,
  makerProgressPatchFromHandoff,
  mergeDeveloperPipelineStatus,
  normalizeDeveloperQa,
  currentPipelineStage,
  pipelineStatusFromMakerRun,
  resolveDeveloperProgressClick,
  resolveLatestMakerPreviewStep,
  scoreMakerRunProgress,
} from '../lib/developer-card.js';

const here = dirname(fileURLToPath(import.meta.url));

function emptyBank(overrides = {}) {
  return {
    brandIdentity: { logos: { normal: '', favicon: '' } },
    media: {
      mainHeroImages: [],
      galleryImages: [],
      logos: [],
      icons: [],
      teamImages: [],
      aboutImages: [],
      locationImages: [],
      illustrationImages: [],
      offeringImages: [],
      uncategorized: [],
    },
    products: [],
    productCatalogs: [],
    websiteCreatorQuestions: { websiteDomain: '' },
    ...overrides,
  };
}

function catalogWithProducts(count) {
  return [{
    layout: 'normal',
    label: 'Produkter',
    categories: [{
      name: 'Katalog',
      products: Array.from({ length: count }, (_, index) => ({
        title: `Vare ${index + 1}`,
        price: '100',
      })),
    }],
  }];
}

function baseClient(overrides = {}) {
  return {
    id: 'client-1',
    businessName: 'Test Bakeri',
    websiteDomain: '',
    details: { meetingQuote: { selected: ['hosting'], productNotes: '', productGoal: '', customSections: '' } },
    ...overrides,
  };
}

function markFor(view, key) {
  return view.binaries.find((row) => row.key === key)?.mark || '';
}

function countFor(view, key) {
  return view.counts.find((row) => row.key === key)?.value;
}

test('summary text renders the four T07 sections', () => {
  const view = developerSummaryView({
    heldAt: '2026-10-01T10:00:00.000Z',
    summary: {
      intro: 'Intro om bakeriet.',
      voice: 'Rolig stemme.',
      whatTheyWant: 'Meny og booking.',
      functionality: 'Nettsiden skal ta imot bordbestilling.',
    },
  });
  assert.equal(view.ready, true);
  assert.equal(view.intro, 'Intro om bakeriet.');
  assert.equal(view.voice, 'Rolig stemme.');
  assert.equal(view.whatTheyWant, 'Meny og booking.');
  assert.equal(view.functionality, 'Nettsiden skal ta imot bordbestilling.');
  assert.equal(view.message, '');
});

test('empty summary shows workshop-not-done copy and no generated prose', () => {
  const empty = developerSummaryView(null);
  assert.equal(empty.ready, false);
  assert.equal(empty.message, WORKSHOP_NOT_HELD_MESSAGE);
  assert.equal(empty.intro, '');
  assert.equal(empty.voice, '');
  assert.equal(empty.whatTheyWant, '');
  assert.equal(empty.functionality, '');

  const heldWithoutText = developerSummaryView({ heldAt: '2026-10-01T10:00:00.000Z', summary: null });
  assert.equal(heldWithoutText.ready, false);
  assert.equal(heldWithoutText.message, WORKSHOP_NOT_HELD_MESSAGE);
});

test('missing Kundedata logo is red; product count stays a number', () => {
  const missing = evaluateWorkshopNeeds({
    client: baseClient(),
    bank: emptyBank(),
  });
  const missingView = developerMaterialsView(missing);
  assert.equal(markFor(missingView, 'logo'), 'red');
  assert.equal(countFor(missingView, 'products'), 0);

  const present = evaluateWorkshopNeeds({
    client: baseClient(),
    bank: emptyBank({
      brandIdentity: { logos: { normal: '/client-media/u/logo.png' } },
      productCatalogs: catalogWithProducts(12),
    }),
  });
  const presentView = developerMaterialsView(present);
  assert.equal(markFor(presentView, 'logo'), 'green');
  assert.equal(countFor(presentView, 'products'), 12);
});

test('domain is green only when Maker or Kundedata has one; sales domain is unmarked', () => {
  const makerOnly = evaluateWorkshopNeeds({
    client: baseClient({ websiteDomain: 'ignore-sales.no' }),
    bank: emptyBank(),
    maker: { run: { metadata: { productionDomain: 'bakeri.no' }, answers: { websiteDomain: '' } } },
  });
  assert.equal(markFor(developerMaterialsView(makerOnly), 'domain'), 'green');

  const kundeOnly = evaluateWorkshopNeeds({
    client: baseClient({ websiteDomain: 'ignore-sales.no' }),
    bank: emptyBank({ websiteCreatorQuestions: { websiteDomain: 'kunde-domene.no' } }),
  });
  assert.equal(markFor(developerMaterialsView(kundeOnly), 'domain'), 'green');

  const salesOnly = evaluateWorkshopNeeds({
    client: baseClient({ websiteDomain: 'sales-only.no' }),
    bank: emptyBank(),
    maker: {},
  });
  const salesView = developerMaterialsView(salesOnly);
  assert.equal(markFor(salesView, 'domain'), 'none');
  assert.notEqual(markFor(salesView, 'domain'), 'red');
  assert.notEqual(markFor(salesView, 'domain'), 'green');
});

test('Lang does not enqueue; CMS stays grey; Layout Maps and SEO enqueue', () => {
  const status = { step1Ready: true, languageLocked: true, generateTextReady: true, hasDomain: true };
  const lang = DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === 'lang');
  const langClick = resolveDeveloperProgressClick(lang, status);
  assert.equal(langClick.enqueue, false);
  assert.equal(langClick.type, 'language');

  const cms = DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === 'cms');
  const cmsClick = resolveDeveloperProgressClick(cms, status);
  assert.equal(cmsClick.enqueue, false);
  assert.equal(cmsClick.type, 'noop');
  assert.equal(cms.target, 'cms');
  assert.notEqual(cms.target, '3');

  for (const id of ['layout', 'maps', 'seo']) {
    const chip = DEVELOPER_PROGRESS_CHIPS.find((row) => row.id === id);
    const click = resolveDeveloperProgressClick(chip, status);
    assert.equal(click.enqueue, true, `${id} must enqueue until that step`);
    assert.equal(click.type, 'enqueue-until');
  }

  const seoNoDomain = resolveDeveloperProgressClick(
    DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === 'seo'),
    { ...status, hasDomain: false }
  );
  assert.equal(seoNoDomain.enqueue, false);
  assert.equal(seoNoDomain.type, 'disabled');
});

test('unfinished later chips enqueue until that step; ready chips offer preview', () => {
  const locked = { step1Ready: true, languageLocked: true, generateTextReady: false };
  const step22 = DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === '2.2');
  const untilMedia = resolveDeveloperProgressClick(step22, locked);
  assert.equal(untilMedia.enqueue, true);
  assert.equal(untilMedia.type, 'enqueue-until');
  assert.equal(untilMedia.untilTarget, 'inject-media');

  const ready = resolveDeveloperProgressClick(step22, { ...locked, generateTextReady: true, injectMediaReady: true });
  assert.equal(ready.enqueue, false);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.target, 'inject-media');

  const step1 = resolveDeveloperProgressClick(
    DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === '1'),
    {}
  );
  assert.equal(step1.enqueue, true);
  assert.equal(step1.untilTarget, '1');
});

test('?panel=custom is the Custom edit path', () => {
  assert.equal(makerCustomEditPath('run-abc'), '/run/run-abc?panel=custom');
  assert.equal(makerCustomEditPath(''), '');
});

test('asoldi.com create-run POSTs never include 127.0.0.1', () => {
  const body = JSON.stringify(asoldiLocalMakerPayload({ forceNewRun: false }));
  assert.equal(body.includes('127.0.0.1'), false);
  assert.equal(JSON.parse(body).makerOnThisComputer, true);
  const tools = readFileSync(join(here, '../app/pages/developer/MakerRunTools.tsx'), 'utf8');
  assert.match(tools, /asoldiLocalMakerPayload/);
  assert.doesNotMatch(tools, /websiteMakerBaseUrl:\s*makerBase/);
  const server = readFileSync(join(here, '../server.js'), 'utf8');
  assert.match(server, /makerOnThisComputer/);
  assert.match(server, /Hostinger WAF 403s a body with 127\.0\.0\.1/);
});

test('Custom edit opens Maker on this computer when the office address is stale', () => {
  assert.equal(editorMakerOrigin(''), 'http://127.0.0.1:3000');
  assert.equal(editorMakerOrigin('http://localhost:3000'), 'http://127.0.0.1:3000');
  assert.equal(editorMakerOrigin('http://192.168.68.92:3000'), 'http://127.0.0.1:3000');
  assert.equal(editorMakerOrigin('https://maker.example.com'), 'https://maker.example.com');
  assert.equal(makerOriginsMatch('http://localhost:3000', 'http://127.0.0.1:3000'), true);
  assert.equal(makerOriginsMatch('http://localhost:3000', 'https://asoldi.com'), false);
  assert.equal(
    makerUnreachableIsLocal('Website Maker is unreachable at http://192.168.68.92:3000 from this host. Start the Maker tunnel, then retry.'),
    true
  );
  assert.equal(
    makerUnreachableIsLocal('Website Creator svarer ikke på http://127.0.0.1:3000. Start Docker Maker på denne PC-en.'),
    true
  );
  assert.equal(makerUnreachableIsLocal('Website Maker run lookup failed (404)'), false);
});

test('QA labels are Norwegian and ticks persist as booleans', () => {
  assert.equal(DEVELOPER_QA_LABELS.textOk, 'Tekst er bra');
  assert.equal(DEVELOPER_QA_LABELS.mediaOk, 'Mediafiler er bra');
  assert.equal(DEVELOPER_QA_LABELS.responsiveOk, 'Responsivitet er bra');
  assert.deepEqual(normalizeDeveloperQa({ textOk: true }), {
    textOk: true,
    mediaOk: false,
    responsiveOk: false,
  });
});

test('handoff progress fields persist without treating sales domain as a fill', () => {
  const patch = makerProgressPatchFromHandoff({
    steps: { 1: 'ready', '1.5': 'idle', 2: 'partial', 3: 'idle' },
    step2Substeps: { 'generate-text': 'ready', 'inject-media': 'idle' },
    language: { confirmed: true, code: 'nb' },
    cms: 'idle',
    customSite: { exists: true, previewPath: '/preview/run-abc/custom' },
    productionDomain: 'bakeri.no',
    latestReadyStep: '2',
  });
  assert.equal(patch.language.confirmed, true);
  assert.equal(patch.customSite.exists, true);
  assert.equal(patch.productionDomain, 'bakeri.no');
  assert.equal(patch.latestReadyStep, '2');
  const status = pipelineStatusFromMakerRun(patch);
  assert.equal(status.step1Ready, true);
  assert.equal(status.generateTextReady, true);
  assert.equal(status.injectMediaReady, false);
  assert.equal(currentPipelineStage({ ...patch, runId: 'run-1' }), '2.1');
  assert.equal(currentPipelineStage({
    runId: 'run-2',
    steps: { '1': 'ready', '1.5': 'ready' },
    step2Substeps: {},
    language: { confirmed: true },
  }), '1.5');
  assert.equal(currentPipelineStage({}), 'none');
});

test('live Maker run nested steps become a persistable handoff', () => {
  const handoff = makerHandoffFromLiveRun({
    steps: {
      '1': { status: 'ready' },
      '1.5': { status: 'ready' },
      '2': {
        status: 'partial',
        substeps: { 'generate-text': { status: 'ready' }, 'inject-media': { status: 'idle' } },
      },
      '3': { status: 'idle' },
    },
    metadata: { finalizedLanguage: { confirmed: true, code: 'nb' }, productionDomain: 'bakeri.no' },
    answers: { websiteDomain: 'bakeri.no' },
  });
  assert.equal(handoff.steps['1'], 'ready');
  assert.equal(handoff.step2Substeps['generate-text'], 'ready');
  assert.equal(handoff.language.confirmed, true);
  assert.equal(handoff.latestReadyStep, '2');
  const status = pipelineStatusFromMakerRun(makerProgressPatchFromHandoff(handoff));
  assert.equal(status.step1Ready, true);
  assert.equal(status.step15Ready, true);
  assert.equal(status.generateTextReady, true);
  assert.equal(status.injectMediaReady, false);
  assert.equal(status.languageLocked, true);
});

test('live Maker status on the developer card wins over a stale idle sales copy', () => {
  const persisted = pipelineStatusFromMakerRun({
    runId: 'run-1',
    steps: { 1: 'idle', '1.5': 'idle', 2: 'idle', 3: 'idle' },
  });
  const live = pipelineStatusFromMakerRun({
    runId: 'run-1',
    steps: { 1: 'ready', '1.5': 'ready', 2: 'partial', 3: 'idle' },
    step2Substeps: { 'generate-text': 'ready', 'inject-media': 'ready' },
    language: { confirmed: true, code: 'nb' },
  });
  const merged = mergeDeveloperPipelineStatus(persisted, live);
  assert.equal(persisted.step1Ready, false);
  assert.equal(merged.step1Ready, true);
  assert.equal(merged.step15Ready, true);
  assert.equal(merged.generateTextReady, true);
  assert.equal(merged.injectMediaReady, true);
  assert.equal(merged.languageLocked, true);
  const storedOnly = mergeDeveloperPipelineStatus(persisted, null);
  assert.equal(storedOnly.step1Ready, false);
});

test('finished Maker steps stay ready on the card even without a language lock', () => {
  const chip15 = DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === '1.5');
  const status = { step1Ready: true, step15Ready: true, languageLocked: false };
  const click = resolveDeveloperProgressClick(chip15, status);
  assert.equal(click.type, 'ready');
  assert.equal(click.enqueue, false);
  assert.equal(developerChipVisual(chip15, status, click), 'ready');
});

test('identical live Maker handoff is not persisted again', () => {
  const stored = {
    runId: 'run-1',
    steps: { 1: 'ready', '1.5': 'ready', 2: 'partial', 3: 'idle' },
    step2Substeps: {
      'generate-text': 'ready',
      'inject-media': 'idle',
      'layout-colors-style': 'idle',
      'maps-embed-sync': 'idle',
    },
    language: { confirmed: true, code: 'nb' },
    latestReadyStep: '2',
  };
  const live = makerHandoffFromLiveRun({
    steps: {
      1: { status: 'ready' },
      '1.5': { status: 'ready' },
      2: { status: 'partial', substeps: { 'generate-text': { status: 'ready' } } },
      3: { status: 'idle' },
    },
    metadata: { finalizedLanguage: { confirmed: true, code: 'nb' } },
  });
  assert.equal(makerHandoffNeedsPersist(stored, 'run-1', live), false);
  assert.equal(makerHandoffNeedsPersist({ runId: 'run-1', steps: { 1: 'idle' } }, 'run-1', live), true);
});

test('Maker preview uses the latest completed step, never an empty Step 4', () => {
  const idle = resolveLatestMakerPreviewStep({});
  assert.equal(idle, '');
  assert.equal(makerLatestPreviewPath('run-abc', idle), '');

  const topspin = resolveLatestMakerPreviewStep({
    step1Ready: true,
    step15Ready: true,
    languageLocked: true,
    generateTextReady: true,
    step2Ready: true,
    injectMediaReady: false,
    seoReady: false,
  });
  assert.equal(topspin, '2');
  assert.equal(
    makerLatestPreviewPath('3da8e039-4866-4f6f-945d-919edafcd513', topspin),
    '/preview/3da8e039-4866-4f6f-945d-919edafcd513/step/2/view?route=/'
  );

  const custom = resolveLatestMakerPreviewStep({ customSiteExists: true, seoReady: true, step2Ready: true });
  assert.equal(custom, 'custom');
  assert.equal(makerLatestPreviewPath('run-abc', 'custom'), '/preview/run-abc/custom/view?route=/');

  const idleDraftScore = scoreMakerRunProgress({
    steps: { 1: 'idle', '1.5': 'idle', 2: 'idle' },
    step2Substeps: { 'generate-text': 'idle' },
  });
  const progressedScore = scoreMakerRunProgress({
    steps: { 1: 'ready', '1.5': 'ready', 2: 'partial' },
    step2Substeps: { 'generate-text': 'ready' },
    language: { confirmed: true },
  });
  assert.ok(progressedScore > idleDraftScore);
});

test('Maker error does not fake an empty client media library', () => {
  const view = developerMediaLibraryView({
    fromClient: [{ fileName: 'logo.png' }],
    fromMaker: [],
    makerError: 'Website Maker is unreachable at http://192.168.1.10:3000 from this host.',
  });
  assert.equal(view.fromClient.length, 1);
  assert.equal(view.fromClient[0].fileName, 'logo.png');
  assert.equal(view.fromMaker.length, 0);
  assert.match(view.makerError, /unreachable/);
});

test('progress chips stay in the locked order and enqueue only through T03', () => {
  assert.deepEqual(
    DEVELOPER_PROGRESS_CHIPS.map((chip) => chip.id),
    ['draft', '1', 'lang', '1.5', '2.1', '2.2', 'layout', 'maps', 'cms', 'seo']
  );
  const card = readFileSync(join(here, '../app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  assert.match(card, /enqueueMakerQueue/);
  assert.match(card, /openLanguageLock/);
  assert.match(card, /Custom edit/);
  assert.match(card, /Tools & details/);
  assert.match(card, /variant="tools"/);
  assert.match(card, /Prosjektdokument/);
  assert.match(card, /Start run|variant="create"/);
  assert.match(card, /Importer nytt eller velg eksisterende template/);
  assert.match(card, /Lagre domene/);
  assert.match(card, /untilTarget/);
  assert.match(card, /DeveloperGoalTimeline/);
  assert.match(card, /sync-maker-run/);
  assert.match(card, /findMakerRunBySalesClientId/);
  assert.match(card, /Maker preview/);
  assert.equal(card.includes('actionPage'), false);
  assert.equal(card.includes('1 / 2'), false);
  assert.equal(card.includes('Open preview'), false);
  const queueClient = readFileSync(join(here, '../app/pages/developer/makerQueue.ts'), 'utf8');
  assert.match(queueClient, /poll=1&adopt=0/);
  const brief = readFileSync(join(here, '../app/pages/developer/DeveloperClientBrief.tsx'), 'utf8');
  assert.match(brief, /Fra kunden/);
  assert.match(brief, /Fra Website Maker/);
  assert.match(brief, /Checklist/);
  assert.match(brief, /flex flex-wrap items-start/);
  assert.equal(brief.includes('Å gjøre'), false);
  assert.equal(card.includes('/step/3'), false);
});

test('Development card still mounts one request thread and the queue bar', () => {
  const section = readFileSync(join(here, '../app/pages/Admin/sections/DevelopmentClientsSection.tsx'), 'utf8');
  assert.match(section, /DeveloperRunQueueBar/);
  assert.match(section, /Forfalt \(siste 2 uker\)/);
  assert.match(section, /DEVELOPER_RECENT_OVERDUE_MS/);
  assert.match(section, /title: 'Neste'/);
  assert.match(section, /renderTimeline\(/);
  assert.equal(section.includes('>Development<'), false);
  assert.equal(section.includes('Før signert kontrakt'), false);
  assert.equal(section.includes('renderGroupedCards('), false);
  assert.equal(section.includes('kind="developer"'), false);
  assert.equal(section.includes("chooseBoard('preview')"), false);
  assert.equal(section.includes("chooseBoard('deployment')"), false);
  assert.equal(section.includes('readStoredDevelopmentBoard'), false);
  assert.equal(section.includes('kindFilter'), false);
  assert.equal(section.includes('Preview website runs'), false);
  assert.equal(section.includes('Deployment website runs'), false);
  assert.equal(section.includes('DeveloperRequestThread'), false);
  assert.equal(section.includes('Start tunnel'), false);
  assert.equal(section.includes('Website Maker URL'), false);
  assert.match(section, /LOCAL_EDITOR_ORIGIN/);
  const card = readFileSync(join(here, '../app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  assert.match(card, /developerCardTimeline/);
  const cardThreads = card.split('<DeveloperRequestThread').length - 1;
  assert.equal(cardThreads, 1);
  assert.match(card, /if \(!salesClientId\) return;/);
  assert.match(card, /Draftfase/);
  assert.match(card, /Mal låst/);
  assert.match(card, /Quick Fill og media/);
  assert.match(card, /asoldi-chip-slide/);
  assert.match(card, /ensureLocalMaker/);
  assert.equal(card.includes('Vis tråd og filer'), false);
  assert.equal(card.includes('if (!detailsOpen) return undefined;'), false);
  assert.match(card, /async function syncMakerRun/);
  assert.match(card, /visibilitychange/);
  assert.match(section, /collapsedBuckets\[storageKey\] !== false/);
  const workspace = readFileSync(join(here, '../app/pages/developer/DeveloperWorkspace.tsx'), 'utf8');
  assert.match(workspace, /Utviklerterminal/);
  assert.match(section, /Utviklerterminal/);
  assert.match(section, /Siste måned/);
  assert.match(section, /Nåværende steg/);
  assert.match(section, /Velg alle/);
  const manage = readFileSync(join(here, '../app/pages/Admin/sections/ManageClientsSection.tsx'), 'utf8');
  assert.match(manage, /Klar for preview/);
  assert.match(manage, /Klar for deployment/);
  const sales = readFileSync(join(here, '../app/pages/Admin/sections/SalesClientsSection.tsx'), 'utf8');
  assert.match(sales, /ligger under Utvikling/);
  assert.equal(sales.includes("persistDevelopmentBoard('deployment')"), false);
  const server = readFileSync(join(here, '../server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/admin\/development\/:id\/workshop-needs', developmentAuth/);
  assert.match(server, /app\.get\('\/api\/admin\/development\/:id\/media', developmentAuth/);
  assert.match(server, /app\.get\('\/api\/admin\/development\/:id\/media\/client\/:fileName', developmentAuth/);
  assert.match(server, /app\.patch\('\/api\/admin\/development\/:id\/goals', developmentAuth/);
  assert.match(server, /app\.post\('\/api\/admin\/development\/:id\/sync-maker-run', developmentAuth/);
  assert.match(server, /listClientUploadFiles/);
  assert.match(server, /loadWorkshopNeedsDocument/);
  const goalsHandler = server.slice(
    server.indexOf("app.patch('/api/admin/development/:id/goals'"),
    server.indexOf("app.post('/api/admin/development/:id/bundle'"),
  );
  assert.match(goalsHandler, /canToggleDeveloperGoals/);
  assert.equal(goalsHandler.includes('assertDevelopmentWork'), false);
  assert.match(section, /revealBucket\(`\$\{prefix\}:noNextAction`\)/);
  assert.match(section, /'website'/);
  assert.match(card, /showFoldDueDate/);
  assert.match(card, /sett neste handling/);
  assert.match(card, /Vis mer på dette kortet/);
  assert.match(card, /applyDeveloperGoalToggle/);
  assert.match(server, /app\.delete\('\/api\/admin\/development\/:id\/media\/client\/:fileName', developmentAuth/);
  assert.match(server, /app\.delete\('\/api\/admin\/development\/:id\/media\/maker', developmentAuth/);
});

function dot(rows, id) {
  return rows.find((row) => row.id === id);
}

test('material dots score Kundedata facts, partial staff and products, and reviews', () => {
  const named = scoreClientMaterials({
    client: baseClient(),
    bank: emptyBank({
      brandIdentity: {
        logos: { normal: '', favicon: '' },
        colors: { primary: '#FF5B00', secondary: '#111827', accent: '#F9F9F8' },
      },
    }),
  });
  assert.equal(dot(named, 'business-name').mark, 'green');
  assert.equal(dot(named, 'logo').mark, 'red');
  assert.equal(dot(named, 'color-primary').mark, 'red');
  assert.equal(dot(named, 'staff-email').mark, 'red');
  assert.equal(named.some((row) => /domain|domene/i.test(`${row.id} ${row.label}`)), false);

  const partialStaff = scoreClientMaterials({
    client: baseClient(),
    bank: emptyBank({
      staff: [{ title: 'Baker', name: 'Kari', phone: '', email: '', imageUrl: '' }],
    }),
  });
  assert.equal(dot(partialStaff, 'staff-name').mark, 'green');
  assert.equal(dot(partialStaff, 'staff-email').mark, 'orange');
  assert.equal(dot(partialStaff, 'staff-phone').mark, 'orange');
  assert.equal(dot(partialStaff, 'staff-image').mark, 'orange');

  const partialPrice = scoreClientMaterials({
    client: baseClient(),
    bank: emptyBank({
      productCatalogs: [{
        layout: 'normal',
        categories: [{
          name: 'Meny',
          products: [
            { title: 'Bolle', price: '40' },
            { title: 'Kake', price: '' },
          ],
        }],
      }],
    }),
  });
  assert.equal(dot(partialPrice, 'product-price').mark, 'orange');
  assert.equal(dot(partialPrice, 'product-name').mark, 'green');

  const twoReviews = scoreClientMaterials({
    client: baseClient(),
    bank: emptyBank(),
    maker: { run: { answers: { reviews: ['Veldig godt brød i sentrum.', 'Hyggelig betjening hver gang.'] } } },
  });
  assert.equal(dot(twoReviews, 'reviews').mark, 'orange');
  assert.match(dot(twoReviews, 'reviews').detail, /2 av 5/);

  const fiveReviews = scoreClientMaterials({
    client: baseClient(),
    bank: emptyBank({
      websiteCreatorQuestions: {
        reviews: ['En.', 'To.', 'Tre.', 'Fire.', 'Fem.'].map((word) => `${word} anmeldelse som er lang nok.`).join('\n'),
      },
    }),
  });
  assert.equal(dot(fiveReviews, 'reviews').mark, 'green');
});

test('draft phase is green after inject, and pending intake blocks later steps', () => {
  const draftChip = DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === 'draft');
  assert.equal(resolveDeveloperProgressClick(draftChip, {}).type, 'draft');
  assert.equal(draftChip.kind, 'draft');
  const pending = resolveDeveloperProgressClick(
    DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === '1'),
    { draftInjected: false }
  );
  assert.equal(pending.type, 'disabled');
  assert.equal(pending.enqueue, false);
  const readyAnyway = resolveDeveloperProgressClick(
    DEVELOPER_PROGRESS_CHIPS.find((chip) => chip.id === '1'),
    { draftInjected: false, step1Ready: true }
  );
  assert.equal(readyAnyway.type, 'ready');
  const gathering = draftPhaseView({
    makerRun: { runId: 'run-1', intakeStatus: 'pending', templateSetId: 'tpl' },
    liveRun: {
      id: 'run-1',
      metadata: {
        intakeStatus: 'pending',
        templateSetId: 'tpl',
        quickFillCompletedAt: '2026-10-03T00:00:00.000Z',
      },
    },
  });
  assert.equal(gathering.templateLocked, true);
  assert.equal(gathering.quickFillDone, true);
  assert.equal(gathering.mediaGatherDone, false);
  assert.equal(gathering.clientDataReady, false);
  assert.equal(gathering.injected, false);
  const injected = draftPhaseView({
    makerRun: {
      runId: 'run-1',
      intakeStatus: 'configured',
      templateSetId: 'tpl',
      quickFillCompletedAt: 't',
      mediaGatherCompletedAt: 't',
    },
  });
  assert.equal(injected.injected, true);
  assert.equal(injected.clientDataReady, true);
  assert.equal(developerChipVisual(draftChip, { draftInjected: true }, { type: 'draft' }), 'ready');
  assert.equal(developerChipVisual(draftChip, { draftInjected: false }, { type: 'draft' }), 'idle');
});

test('preview cards show the meeting clock, deployment cards show website due', () => {
  const preview = developerCardTimeline({
    meetingAt: '2026-10-05T10:00:00.000Z',
    nextActionAt: '2026-10-04T08:00:00.000Z',
    nextActionName: 'SMS',
    developerGoals: { readyForPreview: false },
    websiteDue: { label: 'Ingen frist ennå', started: false, dueAt: '' },
  }, 'preview', Date.parse('2026-10-01T10:00:00.000Z'));
  assert.match(preview.label, /12:00/);
  assert.doesNotMatch(preview.label, /SMS/);
  assert.equal(preview.tone, 'live');
  const cleared = developerCardTimeline({
    meetingAt: '2026-10-05T10:00:00.000Z',
    developerGoals: { readyForPreview: true },
  }, 'preview', Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(cleared.label, '');
  assert.equal(cleared.tone, 'none');
  const deployment = developerCardTimeline({
    rankAt: '2026-10-05T10:00:00.000Z',
    websiteDue: { label: 'Frist: 20. okt. 2026', started: true, dueAt: '2026-10-20T12:00:00.000Z' },
  }, 'deployment', Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(deployment.label, 'Frist: 20. okt. 2026');
  assert.equal(deployment.tone, 'live');
  const developer = developerCardTimeline({
    websiteDue: { label: 'Frist: 20. okt. 2026', started: true, dueAt: '2026-10-20T12:00:00.000Z' },
  }, 'developer', Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(developer.label, 'Frist: 20. okt. 2026');
  assert.equal(developer.tone, 'live');
});
