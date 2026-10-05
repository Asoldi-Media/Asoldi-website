import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asoldiPageIsOnThisComputer,
  buildPipelineQueuePostBody,
  LOCAL_MAKER_ORIGIN,
  makerApiUrl,
  makerBrowserUnreachableMessage,
  makerHealthUrl,
} from '../lib/maker-browser-client.js';

const here = dirname(fileURLToPath(import.meta.url));

test('Maker API URLs stay on this computer port 3000', () => {
  assert.equal(LOCAL_MAKER_ORIGIN, 'http://127.0.0.1:3000');
  assert.equal(makerApiUrl('/api/pipeline-queue'), 'http://127.0.0.1:3000/api/pipeline-queue');
  assert.equal(makerHealthUrl(), 'http://127.0.0.1:3000/api/health');
  assert.match(makerBrowserUnreachableMessage(), /127\.0\.0\.1:3000/);
  assert.match(makerBrowserUnreachableMessage(), /ikke bruk localhost:3000/i);
  assert.equal(asoldiPageIsOnThisComputer('asoldi.com'), false);
  assert.equal(asoldiPageIsOnThisComputer('127.0.0.1'), true);
  assert.equal(asoldiPageIsOnThisComputer('localhost'), true);
});

test('queue POST sends run ids to Maker, not a host field', () => {
  assert.deepEqual(
    buildPipelineQueuePostBody({
      runIds: ['run-a', 'run-a', ' run-b '],
      salesClientIds: ['c1', 'c1'],
      untilTarget: 'layout-colors-style',
    }),
    {
      runIds: ['run-a', 'run-b'],
      salesClientIds: ['c1'],
      untilTarget: 'layout-colors-style',
    }
  );
});

test('developer queue helpers call Maker from the browser', () => {
  const makerQueue = readFileSync(join(here, '../app/pages/developer/makerQueue.ts'), 'utf8');
  assert.match(makerQueue, /fetchLocalMakerJson/);
  assert.match(makerQueue, /\/api\/pipeline-queue/);
  assert.match(makerQueue, /waitForLocalMaker/);
  assert.match(makerQueue, /asoldiPageIsOnThisComputer/);
  assert.doesNotMatch(makerQueue, /skipped: true/);
  assert.match(makerQueue, /\/api\/health|makerBrowserUnreachableMessage/);
  assert.doesNotMatch(makerQueue, /admin\/development\/maker-queue/);
  const websiteMaker = readFileSync(join(here, '../app/pages/sales/websiteMaker.ts'), 'utf8');
  assert.match(websiteMaker, /export const LOCAL_MAKER_URL = LOCAL_EDITOR_ORIGIN/);
  assert.doesNotMatch(websiteMaker, /export const LOCAL_MAKER_URL = 'http:\/\/localhost:3000'/);
});

test('Start run opens the Maker window on the click, same as preview', () => {
  const tools = readFileSync(join(here, '../app/pages/developer/MakerRunTools.tsx'), 'utf8');
  const createFn = tools.slice(
    tools.indexOf('export async function createSalesMakerRun'),
    tools.indexOf('export function MakerRunTools')
  );
  const popupIdx = createFn.indexOf('const popup = openMakerCreatePopup()');
  const firstAwait = createFn.search(/\bawait\s+\w/);
  assert.ok(popupIdx >= 0 && firstAwait > popupIdx);
  assert.doesNotMatch(createFn, /ensureLocalMaker/);
  const card = readFileSync(join(here, '../app/pages/developer/DeveloperClientCard.tsx'), 'utf8');
  const draft = card.slice(
    card.indexOf('async function openDraftPhase'),
    card.indexOf('async function enqueueTarget')
  );
  assert.doesNotMatch(draft, /ensureLocalMaker/);
  assert.match(draft, /window\.open/);
});
