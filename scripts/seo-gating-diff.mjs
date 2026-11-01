#!/usr/bin/env node
// Prints, per site, the old decision and the feature-key decision of the two gated SEO jobs, for a
// copy of a hub data dir, before seo.jobGating moves from shadow to auto:
//   blog-scheduler     automatic local posts (old gate: blog flag + a service that entitles them;
//                      new: blog.autoPosts, older name blog.localPosts)
//   rank-tracker.maps  the Maps ranking loop (old gate: analytics access; new: seo.tracking.maps)
//
//   node scripts/seo-gating-diff.mjs --data <data dir> [--json] [--all]
//
// The data dir is only read: the files the decisions need are copied to a temporary folder and
// the decisions run there, in a child process with no network use. Without --all only the sites
// whose decisions differ are listed; the summary counts every site. Output names sites by their key
// and tier only. Exit code 0; 2 for bad arguments.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILES = ['sites.json', 'client-portal-profiles.json', 'sales-clients.json'];
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}

async function child() {
  const { getAllSites } = await import(pathToFileURL(join(root, 'data', 'hub.js')).href);
  const clientPortal = await import(pathToFileURL(join(root, 'data', 'client-portal.js')).href);
  const { legacyLocalBlogAutoPostsEnabled } = await import(pathToFileURL(join(root, 'lib', 'local-blog-brief.js')).href);
  const { featureKeyDecision } = await import(pathToFileURL(join(root, 'lib', 'seo-ops', 'job-gating.js')).href);
  const { findHubSiteForProfile } = await import(pathToFileURL(join(root, 'lib', 'client-analytics-service.js')).href);
  const { mapsRankingGateInput } = await import(pathToFileURL(join(root, 'lib', 'maps-ranking-scheduler.js')).href);
  const { buildMapsSubject } = await import(pathToFileURL(join(root, 'lib', 'maps-ranking.js')).href);
  const rows = [];
  for (const site of getAllSites()) {
    const next = featureKeyDecision(site, 'blog-scheduler');
    rows.push({
      job: 'blog-scheduler',
      siteKey: site.site_key,
      tier: site.sitePlan?.tierId || site.websitePlan || '',
      old: legacyLocalBlogAutoPostsEnabled(site),
      new: Boolean(next.allowed),
      reason: next.reason,
    });
  }
  for (const profile of clientPortal.listClientProfiles()) {
    const hubSite = findHubSiteForProfile(profile);
    const input = mapsRankingGateInput(profile, hubSite);
    const next = featureKeyDecision(input.site, 'rank-tracker.maps');
    const subject = buildMapsSubject(profile, hubSite || {});
    rows.push({
      job: 'rank-tracker.maps',
      siteKey: input.siteKey,
      tier: input.site?.sitePlan?.tierId || input.site?.websitePlan || '',
      old: input.legacy,
      new: Boolean(next.allowed),
      // The loop also needs an address or a town and an id; without them neither gate ranks.
      rankable: Boolean((subject.address || subject.town) && (subject.businessId || subject.siteKey)),
      reason: next.reason,
    });
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

function main() {
  const data = arg('--data');
  if (!data || !existsSync(data)) {
    console.error('usage: node scripts/seo-gating-diff.mjs --data <data dir> [--json] [--all]');
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), 'asoldi-seo-gating-diff-'));
  try {
    for (const file of FILES) {
      if (existsSync(join(data, file))) copyFileSync(join(data, file), join(work, file));
    }
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      cwd: work,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || tmpdir(), TMP: process.env.TMP || tmpdir(), APP_DATA_DIR: work, PERSIST_PRODUCTION_ENV: '0' },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || 'decision run failed\n');
      process.exit(1);
    }
    const rows = JSON.parse(result.stdout.trim().split('\n').pop());
    const differing = rows.filter((row) => row.old !== row.new);
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ sites: rows.length, differing: differing.length, rows: process.argv.includes('--all') ? rows : differing }, null, 2)}\n`);
      return;
    }
    const shown = process.argv.includes('--all') ? rows : differing;
    const line = (cols) => cols.map((col, i) => String(col).padEnd([18, 36, 18, 5, 5, 8][i] || 0)).join(' ').trimEnd();
    console.log(line(['job', 'site', 'tier', 'old', 'new', 'rankable']));
    for (const row of shown) {
      console.log(line([row.job, row.siteKey, row.tier || '-', row.old ? 'on' : 'off', row.new ? 'on' : 'off', row.rankable === undefined ? '' : row.rankable ? 'yes' : 'no']));
    }
    for (const job of ['blog-scheduler', 'rank-tracker.maps']) {
      const all = rows.filter((row) => row.job === job);
      const diff = all.filter((row) => row.old !== row.new);
      console.log(`${job}: ${all.length} sites, ${diff.length} differ (${diff.filter((row) => row.new).length} would start, ${diff.filter((row) => !row.new).length} would stop)`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv.includes('--child')) await child();
else main();
