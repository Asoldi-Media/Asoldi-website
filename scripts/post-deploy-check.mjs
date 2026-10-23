#!/usr/bin/env node
/**
 * Post-deploy check for the hub. GET requests only, no credentials, no made-up tokens: it asks
 * exactly what any visitor can ask, so it is safe to run against production right after a push.
 *
 *   node scripts/post-deploy-check.mjs --domain <a live client domain> [--base https://asoldi.com]
 *     [--expect-commit <sha>] [--timeout-ms 15000] [--json]
 *
 * Checks:
 *   health          GET /api/health: 200, safeMode false, and a build id (an older build without
 *                   one means the deploy has not landed). With --expect-commit the commit must match.
 *   home            GET /: 200 HTML
 *   site-config     GET /api/hub/site-config?domain=<domain>: 200 with a site config and no
 *                   clientAdmin / pendingAdmin / passwordHash anywhere in the body
 *   recordings      GET /myphoner-recordings/<x> without a login: exactly 401
 *   audio           GET /myphoner-audio/<x> without a login: exactly 401
 *   maker-callback  GET /api/admin/sales/maker-status-callback without a token: exactly 401
 *
 * Exit 0 when every check passes, 1 with a list of the failures, 2 on bad arguments.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE = 'https://asoldi.com';
export const ADMIN_FIELDS = ['clientAdmin', 'pendingAdmin', 'passwordHash'];
const USER_AGENT = 'asoldi-post-deploy-check/1';

export function parseArgs(argv = []) {
  const out = { base: DEFAULT_BASE, domain: '', expectCommit: '', timeoutMs: 15_000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--base') out.base = next();
    else if (arg === '--domain') out.domain = next();
    else if (arg === '--expect-commit') out.expectCommit = next();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--json') out.json = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  out.base = String(out.base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(out.base)) throw new Error('--base must be an origin such as https://asoldi.com');
  out.domain = String(out.domain || '').trim().toLowerCase();
  if (!out.domain) throw new Error('--domain <a live client domain> is required (an unknown domain proves nothing)');
  if (!/^[a-z0-9.-]+$/.test(out.domain)) throw new Error('--domain must be a host name such as example.no');
  out.expectCommit = String(out.expectCommit || '').trim().toLowerCase();
  if (out.expectCommit && !/^[0-9a-f]{7,40}$/.test(out.expectCommit)) throw new Error('--expect-commit must be a commit sha');
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return out;
}

/** One GET. Never sends credentials or cookies. Redirects are not followed unless asked. */
export async function getUrl(url, { timeoutMs = 15_000, follow = false, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: follow ? 'follow' : 'manual',
    credentials: 'omit',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9, */*;q=0.1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  return { status: res.status, contentType: String(res.headers.get('content-type') || ''), body };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Runs every check. deps.get(url, { follow }) → { status, contentType, body } (injectable for tests). */
export async function runPostDeployCheck(options, deps = {}) {
  const { base, domain, expectCommit, timeoutMs } = options;
  const get = deps.get || ((url, opts = {}) => getUrl(url, { timeoutMs, ...opts }));
  const probe = `post-deploy-${Date.now().toString(36)}`;
  const checks = [];
  const record = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const run = async (id, fn) => {
    try {
      await fn();
    } catch (error) {
      record(id, false, `request failed: ${error?.cause?.code || error?.name || ''} ${error?.message || error}`.trim());
    }
  };

  let build = null;
  await run('health', async () => {
    const res = await get(`${base}/api/health`);
    const body = parseJson(res.body);
    if (res.status !== 200 || !body) return record('health', false, `HTTP ${res.status} (want 200 JSON)`);
    if (body.safeMode !== false) {
      return record('health', false, body.safeMode === true ? 'safeMode is ON: the hub is not in production mode' : 'no safeMode field: an older build is still running');
    }
    build = body.build && typeof body.build === 'object' ? body.build : null;
    if (!build || !build.id) return record('health', false, 'no build id in /api/health: an older build is still running');
    if (expectCommit && !String(build.commit || '').startsWith(expectCommit)) {
      return record('health', false, `running commit ${build.commit || 'unknown'}, expected ${expectCommit}`);
    }
    return record('health', true, `safeMode false, build ${build.id}${build.commit ? ` (commit ${build.commit.slice(0, 12)}, ${build.source})` : ''}`);
  });

  await run('home', async () => {
    const res = await get(`${base}/`, { follow: true });
    const html = /text\/html/i.test(res.contentType) && /<html|<!doctype html/i.test(res.body);
    record('home', res.status === 200 && html, `HTTP ${res.status}${html ? ' HTML' : ` ${res.contentType || 'no content type'}`}`);
  });

  await run('site-config', async () => {
    const res = await get(`${base}/api/hub/site-config?domain=${encodeURIComponent(domain)}`);
    const found = ADMIN_FIELDS.filter((field) => res.body.includes(`"${field}"`));
    if (found.length) return record('site-config', false, `the public config for ${domain} contains ${found.join(', ')}`);
    const body = parseJson(res.body);
    if (res.status !== 200 || !body || typeof body !== 'object' || !body.features) {
      return record('site-config', false, `HTTP ${res.status} for ${domain} (want 200 with a site config; is the domain a hub site?)`);
    }
    return record('site-config', true, `HTTP 200 for ${domain}, no admin fields`);
  });

  for (const [id, path] of [
    ['recordings', `/myphoner-recordings/${probe}.mp3`],
    ['audio', `/myphoner-audio/${probe}.mp3`],
    ['maker-callback', '/api/admin/sales/maker-status-callback'],
  ]) {
    await run(id, async () => {
      const res = await get(`${base}${path}`);
      record(id, res.status === 401, `HTTP ${res.status} without a login or token (want 401)`);
    });
  }

  return { ok: checks.every((check) => check.ok), base, domain, build, at: new Date().toISOString(), checks };
}

export function formatReport(report) {
  const lines = [`post-deploy-check ${report.base} (${report.at})`];
  for (const check of report.checks) lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.id.padEnd(15)} ${check.detail}`);
  const failed = report.checks.filter((check) => !check.ok).map((check) => check.id);
  lines.push(failed.length ? `FAILED: ${failed.join(', ')}` : 'All checks passed.');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`post-deploy-check: ${error.message}`);
    console.error('usage: node scripts/post-deploy-check.mjs --domain <client domain> [--base https://asoldi.com] [--expect-commit <sha>] [--json]');
    return 2;
  }
  const report = await runPostDeployCheck(options, deps);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`post-deploy-check: ${error?.message || error}`);
      process.exit(2);
    }
  );
}
