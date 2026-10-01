import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPipelineQueuePostBody,
  LOCAL_MAKER_ORIGIN,
  makerApiUrl,
  makerBrowserUnreachableMessage,
} from '../lib/maker-browser-client.js';

const here = dirname(fileURLToPath(import.meta.url));

test('Maker API URLs stay on this computer port 3000', () => {
  assert.equal(LOCAL_MAKER_ORIGIN, 'http://127.0.0.1:3000');
  assert.equal(makerApiUrl('/api/pipeline-queue'), 'http://127.0.0.1:3000/api/pipeline-queue');
  assert.match(makerBrowserUnreachableMessage(), /Start Docker Maker on port 3000/);
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
  assert.doesNotMatch(makerQueue, /admin\/development\/maker-queue/);
});
