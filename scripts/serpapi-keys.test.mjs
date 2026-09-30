import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listSerpApiKeys,
  markSerpApiKeyExhausted,
  runWithSerpApiFailover,
  serpApiErrorMeansNoCredits,
  usableSerpApiKeys,
} from '../lib/serpapi-keys.js';

test('lists primary and backup SerpAPI keys without duplicates', () => {
  const keys = listSerpApiKeys({
    SERPAPI_API_KEY: 'aaa',
    SERPAPI_API_KEY_2: 'bbb',
    SERP_API_KEY: 'aaa',
    SERPAPI_API_KEYS: 'bbb, ccc',
  });
  assert.deepEqual(keys, ['aaa', 'bbb', 'ccc']);
});

test('out-of-search errors are treated as empty account, not a short throttle', () => {
  assert.equal(serpApiErrorMeansNoCredits(429, { error: 'Your account has run out of searches.' }), true);
  assert.equal(serpApiErrorMeansNoCredits(429, { error: 'too many requests' }), false);
});

test('an exhausted key is skipped until the cooldown ends', () => {
  markSerpApiKeyExhausted('dead-key-skip', 60_000);
  const keys = usableSerpApiKeys({
    SERPAPI_API_KEY: 'dead-key-skip',
    SERPAPI_API_KEY_2: 'live-key',
  });
  assert.deepEqual(keys, ['live-key']);
});

test('failover continues the same search on the backup key after the first is empty', async () => {
  const seen = [];
  const result = await runWithSerpApiFailover(async (key) => {
    seen.push(key);
    if (key === 'empty-acc') return { status: 'no-credits' };
    return { status: 'ok', value: { hits: ['facebook.com/x'] } };
  }, {
    env: {
      SERPAPI_API_KEY: 'empty-acc',
      SERPAPI_API_KEY_2: 'full-acc',
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { hits: ['facebook.com/x'] });
  assert.deepEqual(seen, ['empty-acc', 'full-acc']);
});
