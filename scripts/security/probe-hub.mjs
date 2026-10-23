#!/usr/bin/env node
/**
 * Read-only security probe for the hub. Every request is a GET; nothing is written.
 *
 *   node scripts/security/probe-hub.mjs --target https://asoldi.com --expect-prod \
 *     --site-domain <live client domain> [--admin-token-file ~/.asoldi-secrets/probe-admin-token] \
 *     [--alert-dir ~/.asoldi-probes/alerts] [--email-to ops@asoldi.com] [--no-doh] [--json]
 *
 * Checks:
 *   dns           (unless --no-doh) the host resolves over DNS-over-HTTPS
 *   admin-token   (with --admin-token-file) the token file can be read
 *   health        /api/health answers; with --expect-prod, safeMode must not be true
 *   default-secret-token  a token signed with an old built-in default secret gets 401 on an admin route
 *   site-config   /api/hub/site-config?domain=<a live site> answers 200 and holds no passwordHash /
 *                 pendingAdmin / clientAdmin (--site-domain is required with --expect-prod)
 *   recordings    /myphoner-recordings/… without a login gets exactly 401 (the staff gate)
 *   fireflies     /api/webhooks/fireflies reports an API key, so the pull ingest runs
 *   counters      (admin token only) rejected or header-less Maker callbacks, retired Fireflies
 *                 credentials and throttled logins in the last hour stay under their thresholds
 *
 * DNS: by default the target host is resolved over DNS-over-HTTPS (1.1.1.1, then 8.8.8.8) and the
 * connection is pinned to that address, so a filtering resolver (Telenor Nettvern) cannot hide or
 * redirect the host. TLS still verifies the real host name. When DoH fails, the HTTP checks still
 * run with the system resolver and the dns check fails.
 *
 * On any failure (including DNS, an unreadable token file or a crash of the probe itself): writes
 * <alert-dir>/<time>-<host>.json, e-mails --email-to through Resend when RESEND_API_KEY is set,
 * and exits 1. Schedule it on the operator PC (Task Scheduler / cron); it is not run from the hub.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

export const PUBLIC_DEFAULT_SECRETS = ['change-me-in-production', 'change-me'];
export const DEFAULT_THRESHOLDS = {
  'maker-callback-rejected': 20,
  'maker-callback-missing-token': 50,
  // Fireflies keeps delivering with the retired secret until someone pastes the new one, so normal
  // traffic shows up here (a few per meeting). Only a burst far above that is a signal.
  'fireflies-webhook-retired-credential': 200,
  'login-throttled': 50,
};
const LEAK_FIELDS = ['passwordHash', 'pendingAdmin', 'clientAdmin'];
const DOH_ENDPOINTS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/resolve'];

export function forgeToken(secret, payload) {
  const data = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64url');
}

/** Resolves an A record over DoH. fetchImpl is injectable for tests. */
export async function resolveOverDoh(host, { fetchImpl = fetch, endpoints = DOH_ENDPOINTS, timeoutMs = 5000 } = {}) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host === 'localhost') return host === 'localhost' ? '127.0.0.1' : host;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(host)}&type=A`;
      const res = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`DoH ${res.status}`);
      const body = await res.json();
      const answer = (body.Answer || []).find((row) => row.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(row.data));
      if (answer) return answer.data;
      throw new Error('no A record');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`DoH lookup for ${host} failed: ${lastError?.message || lastError}`);
}

/** A dns.lookup replacement that always answers with the pinned address (both callback shapes). */
export function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (opts.all) cb(null, [{ address, family: 4 }]);
    else cb(null, address, 4);
  };
}

export function httpGet(url, { headers = {}, address = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      { method: 'GET', headers: { 'user-agent': 'asoldi-probe-hub/1', ...headers }, ...(address ? { lookup: pinnedLookup(address) } : {}) },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Runs every check. deps: { get(url, {headers}) → {status, body}, now }.
 * Returns { ok, target, at, checks: [{ id, ok, detail }] }.
 */
export async function runProbe(options = {}, deps = {}) {
  const target = String(options.target || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(target)) throw new Error('--target must be an origin such as https://asoldi.com');
  const now = deps.now ? deps.now() : Date.now();
  const get = deps.get || ((url, opts) => httpGet(url, opts));
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const checks = [];
  const record = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail });
  const safe = async (id, fn) => {
    try {
      await fn();
    } catch (error) {
      record(id, false, `request failed: ${error?.message || error}`);
    }
  };

  await safe('health', async () => {
    const res = await get(`${target}/api/health`, {});
    const body = parseJson(res.body);
    if (res.status !== 200 || !body) return record('health', false, `HTTP ${res.status}`);
    if (options.expectProd && body.safeMode === true) return record('health', false, 'safeMode is ON in production');
    return record('health', true, `up ${body.uptime ?? '?'} s${body.safeMode !== undefined ? `, safeMode=${body.safeMode}` : ''}`);
  });

  for (const secret of PUBLIC_DEFAULT_SECRETS) {
    const id = `default-secret-token:${secret.length}`;
    await safe(id, async () => {
      const token = forgeToken(secret, { role: 'admin', username: 'asoldi.com', at: now });
      const res = await get(`${target}/api/hub/sites`, { headers: { authorization: `Bearer ${token}` } });
      record(id, res.status === 401, `HTTP ${res.status} for a token signed with an old default secret (want 401)`);
    });
  }

  if (options.siteDomain) {
    await safe('site-config', async () => {
      const res = await get(`${target}/api/hub/site-config?domain=${encodeURIComponent(options.siteDomain)}`, {});
      const body = parseJson(res.body);
      const leaked = LEAK_FIELDS.filter((field) => res.body.includes(`"${field}"`));
      if (leaked.length) return record('site-config', false, `public config contains ${leaked.join(', ')}`);
      // Only a real site's config proves anything: a 404 for an unknown domain would hide what the body contains.
      if (res.status !== 200 || !body || typeof body !== 'object') {
        return record('site-config', false, `HTTP ${res.status} for ${options.siteDomain} (want 200 with a site config)`);
      }
      return record('site-config', true, 'HTTP 200, no admin fields');
    });
  } else if (options.expectProd) {
    record('site-config', false, '--site-domain is required with --expect-prod (a live client domain)');
  }

  await safe('recordings', async () => {
    // The staff gate answers 401 for any path; a 404 would mean the gate is gone (static 404).
    const res = await get(`${target}/myphoner-recordings/probe-${now}.mp3`, {});
    record('recordings', res.status === 401, `HTTP ${res.status} without a login (want 401)`);
  });

  await safe('fireflies', async () => {
    const res = await get(`${target}/api/webhooks/fireflies`, {});
    const body = parseJson(res.body) || {};
    record('fireflies', body.apiKey === true, body.apiKey === true ? 'API key present, pull ingest runs' : 'no Fireflies API key: transcripts are not pulled');
  });

  if (options.adminToken) {
    await safe('counters', async () => {
      const res = await get(`${target}/api/admin/system/security`, { headers: { authorization: `Bearer ${options.adminToken}` } });
      const body = parseJson(res.body);
      if (res.status !== 200 || !body) return record('counters', false, `security status HTTP ${res.status}`);
      const spikes = Object.entries(thresholds)
        .map(([kind, limit]) => [kind, Number(body.counters?.[kind]?.lastHour || 0), limit])
        .filter(([, count, limit]) => count > limit)
        .map(([kind, count, limit]) => `${kind} ${count}/h (limit ${limit})`);
      return record('counters', !spikes.length, spikes.length ? `spike: ${spikes.join(', ')}` : 'no spikes in the last hour');
    });
  }

  return { ok: checks.every((check) => check.ok), target, at: new Date(now).toISOString(), checks };
}

export function writeAlert(report, alertDir) {
  mkdirSync(alertDir, { recursive: true });
  const host = new URL(report.target).host.replace(/[^a-z0-9.-]/gi, '_');
  const file = join(alertDir, `${report.at.replace(/[:.]/g, '-')}-${host}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export async function emailAlert(report, { to, apiKey, from = 'Asoldi probe <noreply@asoldi.com>', fetchImpl = fetch } = {}) {
  if (!to || !apiKey) return { sent: false, reason: !to ? 'no recipient' : 'no RESEND_API_KEY' };
  const failed = report.checks.filter((check) => !check.ok);
  const text = [`Probe of ${report.target} at ${report.at} failed:`, '', ...failed.map((c) => `- ${c.id}: ${c.detail}`)].join('\n');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: `[probe] ${new URL(report.target).host}: ${failed.length} check(s) failed`, text }),
  });
  return { sent: res.ok, status: res.status };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function expandHome(path) {
  const text = String(path || '');
  return /^~(?=$|[\\/])/.test(text) ? join(homedir(), text.slice(1)) : text;
}

const USAGE = 'usage: probe-hub.mjs --target https://host [--expect-prod --site-domain d] [--admin-token-file f] [--alert-dir d] [--email-to a] [--no-doh] [--json]';

/**
 * Exit code: 0 all checks pass, 1 a check failed (alert written and e-mailed), 2 bad arguments.
 * deps (tests): { resolve(host), get(url, opts), fetchImpl (Resend), now() }.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const target = String(argValue(argv, '--target') || '').replace(/\/+$/, '');
  let host = '';
  try {
    host = /^https?:\/\/[^/]+$/.test(target) ? new URL(target).hostname : '';
  } catch {
    host = '';
  }
  if (!host) {
    console.error(USAGE);
    return 2;
  }
  // PROBE_DOH_ENDPOINTS (comma list) replaces the public resolvers, e.g. for a local test.
  const dohEndpoints = String(env.PROBE_DOH_ENDPOINTS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const resolveHost = deps.resolve || ((name) => resolveOverDoh(name, dohEndpoints.length ? { endpoints: dohEndpoints } : {}));
  const preChecks = [];
  let report;
  let address = '';
  try {
    const tokenFile = argValue(argv, '--admin-token-file');
    let adminToken = String(env.PROBE_ADMIN_TOKEN || '').trim();
    if (tokenFile) {
      try {
        adminToken = readFileSync(expandHome(tokenFile), 'utf8').trim();
        if (!adminToken) preChecks.push({ id: 'admin-token', ok: false, detail: '--admin-token-file is empty' });
      } catch (error) {
        adminToken = '';
        preChecks.push({ id: 'admin-token', ok: false, detail: `cannot read --admin-token-file (${error?.code || error?.message || error})` });
      }
    }
    if (!argv.includes('--no-doh')) {
      try {
        address = await resolveHost(host);
        preChecks.push({ id: 'dns', ok: true, detail: `${host} → ${address} over DoH` });
      } catch (error) {
        // Unresolvable, lapsed domain or DoH blocked: still try the system resolver, and alert.
        address = '';
        preChecks.push({ id: 'dns', ok: false, detail: String(error?.message || error) });
      }
    }
    const get = deps.get || ((url, opts) => httpGet(url, { ...opts, address }));
    report = await runProbe(
      { target, expectProd: argv.includes('--expect-prod'), siteDomain: argValue(argv, '--site-domain'), adminToken },
      { get, now: deps.now }
    );
    report.checks.unshift(...preChecks);
  } catch (error) {
    report = {
      target,
      at: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
      checks: [...preChecks, { id: 'probe', ok: false, detail: `probe crashed: ${error?.message || error}` }],
    };
  }
  report.ok = report.checks.every((check) => check.ok);
  report.resolvedAddress = address || null;
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.id}  ${check.detail}`);
  if (report.ok) return 0;
  let where = '';
  try {
    where = `alert written to ${writeAlert(report, expandHome(argValue(argv, '--alert-dir')) || join(homedir(), '.asoldi-probes', 'alerts'))}`;
  } catch (error) {
    where = `could not write the alert file (${error?.code || error?.message || error})`;
  }
  const mail = await emailAlert(report, { to: argValue(argv, '--email-to'), apiKey: env.RESEND_API_KEY, fetchImpl: deps.fetchImpl || fetch })
    .catch((error) => ({ sent: false, reason: error?.message || String(error) }));
  console.log(`probe-hub: ${where}${mail.sent ? ', e-mailed' : mail.reason ? ` (no e-mail: ${mail.reason})` : ''}.`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not process.exit(): exiting while a fetch or socket is still closing crashes libuv on Windows.
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`probe-hub: ${error?.message || error}`);
      process.exitCode = 2;
    }
  );
}
