// Quota ledger and fair share: a one-day simulation over 50 sites with a fake clock, plus the
// day rollover across DST, Brevo reconciliation, per-site recipient counters and the site view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-email-quota-'));
process.env.APP_DATA_DIR = dataDir;

const store = await import('../data/email-store.js');
const quotaLib = await import('../lib/email-quota.js');
const { createEmailQuota, memoryLedgerStore, osloDayKey, osloHour, nextResetAt } = quotaLib;

const SETTINGS = store.defaultEmailSettings();
const settingsWith = (patch = {}) => () => store.deepMerge(SETTINGS, patch);

/** Instant for a local Oslo wall time on a day without a DST change (CET, UTC+1). */
function osloCet(day, hh, mm = 0) {
  return Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+01:00`);
}

function quota(patch = {}) {
  const mem = memoryLedgerStore();
  return { q: createEmailQuota({ store: mem, settings: settingsWith(patch) }), mem };
}

const DAY = '2026-11-03';
const L = 300;
const SAFETY = 15;
const P = L - SAFETY;

test('(a) (b) one day, 50 sites: the total never exceeds limit − safety, and p1 is admitted while there is room', async () => {
  const { q, mem } = quota();
  const sites = Array.from({ length: 50 }, (_, i) => `site_${i}`);
  let p1Checked = 0;
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    const now = osloCet(DAY, Math.floor(minute / 60), minute % 60);
    for (let i = 0; i < sites.length; i += 1) {
      const site = sites[i];
      const ledger = mem.peek();
      const used = ledger ? ledger.total - ledger.asoldi : 0;
      const siteP1 = ledger?.bySite?.[site]?.p1 || 0;
      const roll = (i * 7 + minute) % 11;
      if (roll === 0 || roll === 5) {
        const result = await q.tryAcquire({ siteId: site, cls: 'p1', now });
        if (P - used >= 1 && siteP1 < 40) {
          assert.equal(result.ok, true, `p1 refused with room left at ${new Date(now).toISOString()} for ${site}`);
          p1Checked += 1;
        }
      } else if (roll === 1) {
        await q.tryAcquire({ siteId: site, cls: 's', now });
      } else if (roll === 2 || roll === 3) {
        await q.tryAcquire({ siteId: site, cls: 'p3', now });
      } else if (roll === 4) {
        await q.tryAcquire({ siteId: site, cls: 'p2', now });
      }
      assert.ok(mem.peek().total <= L - SAFETY, `total ${mem.peek().total} over the cap`);
    }
  }
  assert.ok(p1Checked > 50, 'the simulation exercised p1 many times');
  assert.equal(mem.peek().total, L - SAFETY, 'a busy day uses the whole pool and stops there');
});

test('(c) five sites demanding 1000 p3 each: no site gets more than twice another before 16:00', async () => {
  const { q } = quota();
  const sites = ['a', 'b', 'c', 'd', 'e'];
  const got = Object.fromEntries(sites.map((s) => [s, 0]));
  let attempts = 0;
  for (let minute = 8 * 60; minute < 16 * 60 && attempts < 5000; minute += 1) {
    const now = osloCet(DAY, Math.floor(minute / 60), minute % 60);
    for (const site of sites) {
      attempts += 1;
      const result = await q.tryAcquire({ siteId: site, cls: 'p3', now });
      if (result.ok) got[site] += 1;
    }
  }
  const values = Object.values(got);
  assert.ok(Math.min(...values) > 0);
  assert.ok(Math.max(...values) <= 2 * Math.min(...values), JSON.stringify(got));
  assert.equal(q.fairShare('a', { now: osloCet(DAY, 15) }), Math.floor((P - 75 - 40) / 5));
});

test('(d) p2/p3 cannot use the p1 reserve before 20:00; after 20:00 they can', async () => {
  const { q, mem } = quota();
  const sites = Array.from({ length: 10 }, (_, i) => `busy_${i}`);
  for (let minute = 6 * 60; minute < 20 * 60; minute += 2) {
    const now = osloCet(DAY, Math.floor(minute / 60), minute % 60);
    for (const site of sites) await q.tryAcquire({ siteId: site, cls: minute % 4 ? 'p3' : 'p2', now });
    const ledger = mem.peek();
    assert.ok(ledger.total <= P - 75, `p2/p3 used ${ledger.total} before 20:00`);
  }
  const before = mem.peek().total;
  assert.equal(before, P - 75, 'everything but the reserve was used');
  const late = await q.tryAcquire({ siteId: 'busy_0', cls: 'p3', now: osloCet(DAY, 20, 5) });
  assert.equal(late.ok, true, 'after 20:00 the reserve is open to p2/p3 (borrowing is on after 16:00)');
  const refused = await q.tryAcquire({ siteId: 'busy_1', cls: 'p2', now: osloCet(DAY, 19, 59) });
  assert.equal(refused.ok, false, 'a refusal before 20:00 points at 20:00');
  assert.equal(refused.retryAt, new Date(osloCet(DAY, 20)).toISOString());
});

test('(e) 50 signup sends from one site admit 10 and leave its p1 capacity at 40', async () => {
  const { q } = quota();
  const now = osloCet(DAY, 12);
  let ok = 0;
  for (let i = 0; i < 50; i += 1) if ((await q.tryAcquire({ siteId: 'shop', cls: 's', now })).ok) ok += 1;
  assert.equal(ok, 10);
  const view = q.siteQuotaView('shop', { now });
  assert.equal(view.site.remaining.p1, 40);
  let p1 = 0;
  for (let i = 0; i < 45; i += 1) if ((await q.tryAcquire({ siteId: 'shop', cls: 'p1', now })).ok) p1 += 1;
  assert.equal(p1, 40);
  const pool = quota();
  let s = 0;
  for (let i = 0; i < 6; i += 1) for (let j = 0; j < 10; j += 1) if ((await pool.q.tryAcquire({ siteId: `sig_${i}`, cls: 's', now })).ok) s += 1;
  assert.equal(s, 40, 'the signup pool caps all sites together');
});

test('(f) the day rolls over at 00:00 Oslo exactly once per day across both DST changes', async () => {
  const { q, mem } = quota();
  // DST ends 2026-10-25 at 03:00 CEST: Oct 25 lasts 25 hours.
  const times = [
    '2026-10-24T21:30:00Z', // 23:30 CEST Oct 24
    '2026-10-24T22:30:00Z', // 00:30 CEST Oct 25 → reset
    '2026-10-25T00:30:00Z', // 02:30 CEST Oct 25
    '2026-10-25T01:30:00Z', // 02:30 CET Oct 25 (the repeated hour)
    '2026-10-25T22:30:00Z', // 23:30 CET Oct 25
    '2026-10-25T23:30:00Z', // 00:30 CET Oct 26 → reset
  ].map(Date.parse);
  for (const now of times) assert.equal((await q.tryAcquire({ siteId: 'dst', cls: 'p1', now })).ok, true);
  const ledger = mem.peek();
  assert.deepEqual(ledger.history.map((row) => [row.day, row.total]), [['2026-10-24', 1], ['2026-10-25', 4]]);
  assert.equal(ledger.day, '2026-10-26');
  assert.equal(ledger.total, 1);
  assert.equal(new Date(nextResetAt(Date.parse('2026-10-25T12:00:00Z'))).toISOString(), '2026-10-25T23:00:00.000Z');
  // DST starts 2026-03-29 at 02:00 CET: that day lasts 23 hours.
  assert.equal(new Date(nextResetAt(Date.parse('2026-03-29T12:00:00Z'))).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(osloDayKey(Date.parse('2026-03-29T22:00:00Z')), '2026-03-30');
  assert.equal(osloHour(Date.parse('2026-03-29T01:30:00Z')), 3);
  const spring = quota();
  for (const iso of ['2026-03-28T22:30:00Z', '2026-03-29T00:30:00Z', '2026-03-29T21:30:00Z', '2026-03-29T22:30:00Z']) await spring.q.tryAcquire({ siteId: 'dst', cls: 'p1', now: Date.parse(iso) });
  assert.deepEqual(spring.mem.peek().history.map((row) => [row.day, row.total]), [['2026-03-28', 1], ['2026-03-29', 2]]);
});

test('(g) reconciliation with 10 credits left raises the total so that only 10 more are admitted', async () => {
  const { q, mem } = quota();
  const now = osloCet(DAY, 9);
  await q.tryAcquire({ siteId: 'r1', cls: 'p1', now });
  const result = await q.reconcileWithBrevo({ plan: [{ type: 'free', creditsType: 'sendLimit', credits: 10 }] }, { now });
  assert.equal(result.adjusted, true);
  assert.equal(mem.peek().total, L - SAFETY - 10);
  let ok = 0;
  for (let i = 0; i < 30; i += 1) if ((await q.tryAcquire({ siteId: `r${i % 3}`, cls: 'p1', now })).ok) ok += 1;
  assert.equal(ok, 10);
  const more = await q.reconcileWithBrevo({ plan: [{ type: 'free', creditsType: 'sendLimit', credits: 200 }] }, { now });
  assert.equal(more.adjusted, false, 'more credits than the ledger expects never lowers the total');
  const none = await q.reconcileWithBrevo({ plan: [{ type: 'safe-mode-stub', creditsType: 'sendLimit', credits: null }] }, { now });
  assert.equal(none.adjusted, false);
});

test('(h) per-recipient counters are per site: site A reaching the cap does not limit site B', async () => {
  const { q } = quota();
  const now = osloCet(DAY, 10);
  const recipientHash = 'sha256:abc';
  assert.equal((await q.tryAcquire({ siteId: 'A', cls: 'p1', now, recipientHash, marketing: true })).ok, true);
  assert.equal((await q.tryAcquire({ siteId: 'A', cls: 'p2', now, recipientHash, marketing: true })).ok, true);
  const third = await q.tryAcquire({ siteId: 'A', cls: 'p1', now, recipientHash, marketing: true });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'recipient_rate');
  assert.equal(third.retryAt, new Date(osloCet('2026-11-04', 0)).toISOString());
  assert.equal((await q.tryAcquire({ siteId: 'B', cls: 'p1', now, recipientHash, marketing: true })).ok, true);
  assert.equal((await q.tryAcquire({ siteId: 'A', cls: 'p1', now, recipientHash, marketing: false })).ok, true, 'non-marketing sends are not counted');
  const camp = quota();
  assert.equal((await camp.q.tryAcquire({ siteId: 'C', cls: 'p3', now, recipientHash, campaign: true })).ok, true);
  const again = await camp.q.tryAcquire({ siteId: 'C', cls: 'p3', now: osloCet('2026-11-05', 10), recipientHash, campaign: true });
  assert.equal(again.code, 'recipient_rate', 'campaigns to one address are spaced by perRecipientCampaignEveryDays');
  assert.equal((await camp.q.tryAcquire({ siteId: 'C', cls: 'p3', now: osloCet('2026-11-06', 10), recipientHash, campaign: true })).ok, true);
});

test('(i) siteQuotaView has no pool numbers and no other site ids; the snapshot has both', async () => {
  const { q } = quota();
  const now = osloCet(DAY, 11);
  for (const site of ['own_site', 'other_site_x', 'other_site_y']) await q.tryAcquire({ siteId: site, cls: 'p2', now });
  const view = q.siteQuotaView('own_site', { now });
  const text = JSON.stringify(view);
  assert.equal(text.includes('other_site'), false);
  assert.equal(typeof view.pool, 'string');
  assert.deepEqual(Object.keys(view).sort(), ['day', 'mode', 'nextResetAt', 'pool', 'site']);
  assert.equal(/"total"|"size"|"history"|"bySite"|"asoldi"/.test(text), false);
  assert.deepEqual(view.site.used, { p1: 0, s: 0, p2: 1, p3: 0 });
  const snap = q.quotaSnapshot({ now });
  assert.ok(snap.bySite.other_site_x);
  assert.equal(snap.pool.size, P);
});

test('release gives a ticket back the same day only; tests are capped per site', async () => {
  const { q, mem } = quota();
  const now = osloCet(DAY, 12);
  const got = await q.tryAcquire({ siteId: 'rel', cls: 'p1', now, recipientHash: 'h', marketing: true });
  assert.equal(mem.peek().total, 1);
  assert.equal(await q.release(got.ticket, { now }), true);
  assert.equal(mem.peek().total, 0);
  assert.equal(mem.peek().byRecipient['rel:h'], undefined);
  const next = await q.tryAcquire({ siteId: 'rel', cls: 'p1', now });
  assert.equal(await q.release(next.ticket, { now: osloCet('2026-11-04', 1) }), false, 'yesterday\'s ticket changes nothing today');
  let tests = 0;
  for (let i = 0; i < 25; i += 1) if ((await q.tryAcquire({ siteId: 'tst', cls: 'p1', kind: 'test', now })).ok) tests += 1;
  assert.equal(tests, 20);
});

test('monthly mode paces the remaining month at 1.5× the even share', async () => {
  const { q } = quota({ quota: { mode: 'monthly', limit: 6000 } });
  const view = q.quotaSnapshot({ now: osloCet('2026-11-01', 10) });
  assert.equal(view.limit, Math.floor((6000 / 30) * 1.5));
  assert.equal(view.mode, 'monthly');
});

test('the file ledger fails closed when unreadable and serializes concurrent acquires', async () => {
  const q = createEmailQuota({ settings: settingsWith() });
  const now = osloCet(DAY, 13);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => q.tryAcquire({ siteId: `f${i % 3}`, cls: 'p1', now })));
  assert.equal(results.filter((r) => r.ok).length, 30);
  assert.equal(JSON.parse((await import('node:fs')).readFileSync(join(dataDir, 'email-ledger.json'), 'utf8')).total, 30, 'no update was lost');
  writeFileSync(join(dataDir, 'email-ledger.json'), '{"day": "2026-11-03", "total": ', 'utf8');
  await assert.rejects(q.tryAcquire({ siteId: 'f0', cls: 'p1', now }), (error) => error.code === 'quota_unavailable');
  assert.throws(() => q.siteQuotaView('f0', { now }), (error) => error.code === 'quota_unavailable');
});
