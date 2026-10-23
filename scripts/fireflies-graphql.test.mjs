import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FirefliesApiError,
  INGEST_RESERVE,
  firefliesGraphql,
  firefliesRateLimitStatus,
  isTransientFirefliesError,
  parseRetryAfterMs,
  resetFirefliesGraphqlStateForTests,
} from '../lib/fireflies-graphql.js';

function reply(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test.beforeEach(() => resetFirefliesGraphqlStateForTests());

test('a normal answer returns data and records the reported budget', async () => {
  const result = await firefliesGraphql({
    query: 'query { user { email } }',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.fireflies.ai/graphql');
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      return reply({ data: { user: { email: 'eier@firma.no' } } }, {
        headers: { 'x-ratelimit-limit-api': '60', 'x-ratelimit-remaining-api': '42', 'x-ratelimit-reset-api': '30' },
      });
    },
  });
  assert.equal(result.data.user.email, 'eier@firma.no');
  assert.deepEqual(result.errors, []);
  const status = firefliesRateLimitStatus();
  assert.equal(status.api.limit, 60);
  assert.equal(status.api.remaining, 42);
});

test('too_many_requests on HTTP 200 pauses the bucket for every later caller', async () => {
  let calls = 0;
  const limited = async () => {
    calls += 1;
    return reply({
      data: null,
      errors: [{ message: 'Too many requests. Please retry after Fri, 23 Oct 2026 13:56:26 GMT', code: 'too_many_requests' }],
    });
  };
  await assert.rejects(
    () => firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: limited }),
    (error) => error instanceof FirefliesApiError && error.code === 'rate-limited' && error.retryAfterMs > 0,
  );
  assert.equal(calls, 1);
  // The second call does not reach Fireflies at all.
  await assert.rejects(
    () => firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: limited }),
    (error) => error.code === 'rate-limited' && isTransientFirefliesError(error),
  );
  assert.equal(calls, 1);
  assert.ok(firefliesRateLimitStatus().pausedUntil.api);
});

test('HTTP 429 with Retry-After pauses only its own bucket', async () => {
  await assert.rejects(
    () => firefliesGraphql({
      query: 'mutation { addToLiveMeeting }',
      apiKey: 'k',
      lane: 'live',
      bucket: 'join',
      fetchImpl: async () => reply({ errors: [{ message: 'slow down' }] }, { status: 429, headers: { 'retry-after': '120' } }),
    }),
    (error) => error.code === 'rate-limited' && error.bucket === 'join' && error.retryAfterMs >= 119_000,
  );
  // General API calls still go through.
  const ok = await firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: async () => reply({ data: { a: 1 } }) });
  assert.equal(ok.data.a, 1);
});

test('ingest calls leave the last of the per-minute budget to live calls', async () => {
  await firefliesGraphql({
    query: 'query { a }',
    apiKey: 'k',
    fetchImpl: async () => reply({ data: { a: 1 } }, {
      headers: { 'x-ratelimit-remaining-api': String(INGEST_RESERVE), 'x-ratelimit-reset-api': '20' },
    }),
  });
  await assert.rejects(
    () => firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: async () => reply({ data: { a: 2 } }) }),
    (error) => error.code === 'reserve',
  );
  const live = await firefliesGraphql({ query: 'query { a }', apiKey: 'k', lane: 'live', fetchImpl: async () => reply({ data: { a: 3 } }) });
  assert.equal(live.data.a, 3);
});

test('the timeout covers a body that never finishes', async () => {
  await assert.rejects(
    () => firefliesGraphql({
      query: 'query { a }',
      apiKey: 'k',
      timeoutMs: 3000,
      fetchImpl: async (url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      }),
    }),
    (error) => error.code === 'timeout',
  );
});

test('partial data comes back with its errors; non-JSON and HTTP errors throw', async () => {
  const partial = await firefliesGraphql({
    query: 'query { a b }',
    apiKey: 'k',
    fetchImpl: async () => reply({ data: { a: 1, b: null }, errors: [{ message: 'b failed', code: 'object_not_found' }] }),
  });
  assert.equal(partial.data.a, 1);
  assert.equal(partial.errors.length, 1);
  await assert.rejects(
    () => firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: async () => new Response('<html>down</html>', { status: 200 }) }),
    (error) => error.code === 'bad-response',
  );
  await assert.rejects(
    () => firefliesGraphql({ query: 'query { a }', apiKey: 'k', fetchImpl: async () => reply({ errors: [{ message: 'nope', code: 'forbidden' }] }, { status: 403 }) }),
    (error) => error.code === 'forbidden' && error.status === 403 && !isTransientFirefliesError(error),
  );
  await assert.rejects(() => firefliesGraphql({ query: 'query { a }', apiKey: '' }), (error) => error.code === 'no-api-key');
});

test('retry-after parsing reads seconds, dates, epoch metadata and the message', () => {
  const now = Date.parse('2026-10-23T13:55:59.000Z');
  assert.equal(parseRetryAfterMs({ headerValue: '30', nowMs: now }), 30_000);
  assert.equal(parseRetryAfterMs({ headerValue: 'Fri, 23 Oct 2026 13:56:26 GMT', nowMs: now }), 27_000);
  assert.equal(parseRetryAfterMs({ error: { extensions: { metadata: { retryAfter: now + 5000 } } }, nowMs: now }), 5000);
  assert.equal(parseRetryAfterMs({ error: { message: 'Too many requests. Please retry after Fri, 23 Oct 2026 13:56:26 GMT' }, nowMs: now }), 27_000);
  assert.equal(parseRetryAfterMs({ nowMs: now }), 0);
});
