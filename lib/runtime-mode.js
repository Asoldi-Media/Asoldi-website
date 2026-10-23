/**
 * Where is this hub running, and is safe mode on?
 *
 * Safe mode keeps a hub that runs with live keys on a PC (or the office LAN box)
 * from touching the real world: emails go to an outbox, external writes are
 * blocked and recorded, and outbound network traffic is limited to an allowlist.
 *
 * HUB_SAFE_MODE=1 → on, HUB_SAFE_MODE=0 → off, unset → on unless this is the
 * Hostinger runtime. asoldi.com therefore never runs in safe mode unless someone
 * sets HUB_SAFE_MODE=1 there explicitly.
 *
 * HUB_SAFE_MODE_ALLOW is a comma list of keys from SAFE_MODE_ALLOW_KEYS that are
 * let through while safe mode is on (for example `prodPublish,lan` on the LAN box).
 */
import os from 'node:os';

/** Every key HUB_SAFE_MODE_ALLOW understands. Kept in one place so docs, UI and tests agree. */
export const SAFE_MODE_ALLOW_KEYS = Object.freeze({
  emailRedirect: 'Send email for real, rewritten to EMAIL_REDIRECT_TO (subject prefixed, bcc dropped).',
  brevoSend: 'Let Brevo API calls through (default: outbox).',
  calendarWrite: 'Create, change or delete Google Calendar events and ACLs.',
  firefliesLiveJoin: 'Send the Fireflies notetaker into a live Meet (addToLive mutation).',
  firefliesIngest: 'Pull recent Fireflies transcripts (read-only API) and run the ingest follow-ups.',
  myphonerWrite: 'POST/PATCH/DELETE to Myphoner (GET is always allowed).',
  myphonerSync: 'Run the Myphoner webhook reconcile and recording retry loops.',
  paymentsLive: 'Stripe calls with live keys and PayPal live.',
  paymentsTest: 'Stripe calls with test keys and PayPal sandbox (on by default).',
  stripeWebhookAdmin: 'Create or delete Stripe webhook endpoints (any mode).',
  prodPublish: 'Log in to asoldi.com and push previews there (LAN autopublish).',
  wordpressWrite: 'Write to the WordPress REST API (reads are allowed).',
  accountingWrite: 'Luca accounting GraphQL mutations (queries are allowed).',
  inboxRead: 'Run the inbox bot loop (classify-only: replies go to the outbox, no calendar writes).',
  imapFlags: 'Let IMAP sessions change flags (default: EXAMINE + BODY.PEEK, so mail stays unread).',
  aiCalls: 'Real LLM calls (DeepSeek, Anthropic, Gemini). Default: replay cassette or deterministic stub.',
  paidApi: 'Paid data APIs (DataForSEO, SerpAPI, Google Places/Geocoding, Deepgram, Brave).',
  publicTunnel: 'Start a public cloudflared tunnel to the local Maker.',
  publicRead: 'GET/HEAD to any public host (client websites, brreg, nominatim).',
  lan: 'Private LAN addresses (192.168.x, 10.x, 172.16-31.x), e.g. the Maker on PC2.',
  geocode: 'Run the sales meeting geocode warmup loop.',
  mapsRanking: 'Run the maps ranking loop.',
  startupBackfills: 'Run the startup recording, links and SSU wins backfills.',
});

/** Keys that are allowed even when HUB_SAFE_MODE_ALLOW does not list them (test-mode payments only). */
export const SAFE_MODE_DEFAULT_ALLOW = Object.freeze(['paymentsTest']);

function clean(value) {
  return String(value ?? '').trim();
}

function slashPath(value) {
  return clean(value).replace(/\\/g, '/');
}

/**
 * True on the Hostinger Node runtime (asoldi.com). Signals, any one is enough:
 * HOSTINGER env set, a cwd (POSIX path) ending in /domains/<site>/nodejs, or a cwd, home or
 * APP_DATA_DIR/DATA_DIR under /home/u<digits>. The live app runs from
 * /home/u<id>/domains/asoldi.com/hbuilds/versions/<build>/ with HOME=/home/u<id>/domains/asoldi.com
 * and keeps its data in HOME/.asoldi-website-data (older deploys ran from .../asoldi.com/nodejs).
 * Windows paths never match.
 */
export function isHostingerRuntime({ env = process.env, cwd, home } = {}) {
  if (clean(env?.HOSTINGER)) return true;
  let workingDir = cwd;
  if (workingDir === undefined) {
    try {
      workingDir = process.cwd();
    } catch {
      workingDir = '';
    }
  }
  let homeDir = home;
  if (homeDir === undefined) {
    try {
      homeDir = os.homedir();
    } catch {
      homeDir = '';
    }
  }
  const cwdPath = slashPath(workingDir);
  const homePath = slashPath(homeDir);
  // POSIX absolute paths only: a Windows folder that ends in domains\<site>\nodejs is still a PC.
  if (/^\/(?:[^/]+\/)*domains\/[^/]+\/nodejs\/?$/i.test(cwdPath)) return true;
  if (/^\/home\/u\d+(\/|$)/.test(cwdPath)) return true;
  if (/^\/home\/u\d+(\/|$)/.test(homePath)) return true;
  const dataPath = slashPath(env?.APP_DATA_DIR || env?.DATA_DIR || '');
  return /^\/home\/u\d+\//.test(dataPath);
}

export function parseSafeModeAllow(raw = '') {
  const known = [];
  const unknown = [];
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    const key = clean(part);
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(SAFE_MODE_ALLOW_KEYS, key)) {
      if (!known.includes(key)) known.push(key);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }
  return { known, unknown };
}

/**
 * { on, reason, allow: Set, unknownAllow: [] }. `ctx` passes cwd/home through to
 * isHostingerRuntime so tests can simulate the Hostinger paths.
 */
export function safeModeState(env = process.env, ctx = {}) {
  const flag = clean(env?.HUB_SAFE_MODE).toLowerCase();
  let on;
  let reason;
  if (['1', 'true', 'on', 'yes'].includes(flag)) {
    on = true;
    reason = 'HUB_SAFE_MODE=1';
  } else if (['0', 'false', 'off', 'no'].includes(flag)) {
    on = false;
    reason = 'HUB_SAFE_MODE=0';
  } else if (isHostingerRuntime({ env, ...ctx })) {
    on = false;
    reason = 'Hostinger runtime';
  } else {
    on = true;
    reason = 'not Hostinger';
  }
  const { known, unknown } = parseSafeModeAllow(env?.HUB_SAFE_MODE_ALLOW);
  const allow = new Set([...SAFE_MODE_DEFAULT_ALLOW, ...known]);
  return { on, reason, allow, explicitAllow: known, unknownAllow: unknown };
}
