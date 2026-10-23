/**
 * Safe-mode egress allowlist.
 *
 * While safe mode is on, every outbound connection is checked at three layers:
 *   - fetch()               method, URL, headers and a string body (GraphQL mutation check)
 *   - http/https.request    method, URL and headers (Stripe key mode, Google write methods)
 *   - net.Socket#connect    host and port only; catches SMTP, IMAP, raw TLS and any client
 *                           that captured http.request before the guard was installed.
 *                           Hosts whose rules gate on method, path or headers (Google reads,
 *                           Myphoner GET, Luca queries, Stripe test keys) only get a socket
 *                           opened for a request the two layers above approved.
 * Anything not matched by an enabled rule is refused before a byte leaves the PC
 * and reported to `onBlocked` as an intent. Loopback is always allowed.
 *
 * The rules are data, so the Superadmin page, the soak test and the guard read
 * the same list.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { graphqlDocumentWrites } from './graphql-ops.js';

export class SafeModeEgressError extends Error {
  constructor(message, { kind = 'egress', host = '' } = {}) {
    super(message);
    this.name = 'SafeModeEgressError';
    this.code = 'ESAFEMODE';
    this.kind = kind;
    this.host = host;
    this.safeMode = true;
  }
}

const LOOPBACK_NAMES = new Set(['localhost', 'host.docker.internal', 'gateway.docker.internal', '0.0.0.0', '::', '::1']);
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function clean(value) {
  return String(value ?? '').trim();
}

export function normalizeHost(value = '') {
  let host = clean(value).toLowerCase();
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  host = host.replace(/\.$/, '');
  if (host.startsWith('::ffff:')) host = host.slice(7);
  return host;
}

export function isLoopbackHost(value = '') {
  const host = normalizeHost(value);
  if (!host) return true; // net defaults an empty host to localhost
  if (LOOPBACK_NAMES.has(host)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return host.endsWith('.localhost');
}

export function isPrivateLanHost(value = '') {
  const host = normalizeHost(value);
  return /^10\.\d+\.\d+\.\d+$/.test(host)
    || /^192\.168\.\d+\.\d+$/.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
    || /^169\.254\.\d+\.\d+$/.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || /\.(local|lan|internal)$/.test(host);
}

function hostOfUrl(raw = '') {
  try {
    return normalizeHost(new URL(clean(raw)).hostname);
  } catch {
    return '';
  }
}

export function hostMatches(pattern, host) {
  const target = normalizeHost(host);
  if (!target) return false;
  if (pattern instanceof RegExp) return pattern.test(target);
  const p = normalizeHost(pattern);
  if (!p) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return target === base || target.endsWith(`.${base}`);
  }
  return target === p;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  if (typeof headers.get === 'function') return clean(headers.get(name));
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 1) {
      const entry = headers[i];
      if (Array.isArray(entry) && String(entry[0]).toLowerCase() === wanted) return clean(entry[1]);
      if (typeof entry === 'string' && entry.toLowerCase() === wanted) return clean(headers[i + 1]);
    }
    return '';
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return clean(Array.isArray(value) ? value[0] : value);
  }
  return '';
}

/** 'test' | 'live' | '' from a Stripe Authorization header (Bearer or Basic). */
export function stripeKeyMode(headers) {
  const auth = headerValue(headers, 'authorization');
  if (!auth) return '';
  let token = auth.replace(/^bearer\s+/i, '');
  if (/^basic\s+/i.test(auth)) {
    try {
      token = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8').split(':')[0];
    } catch {
      token = '';
    }
  }
  if (/^(sk|rk|pk)_test_/i.test(token)) return 'test';
  if (/^(sk|rk|pk)_live_/i.test(token)) return 'live';
  return '';
}

/**
 * True when the JSON/GraphQL body could write: a mutation or subscription anywhere in
 * the document, an operationName that is not one of its queries, or a body that cannot
 * be read (persisted queries, unknown shapes).
 */
export function graphqlIsMutation(body) {
  if (body == null || body === '') return true;
  let text = '';
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body) || body instanceof Uint8Array) text = Buffer.from(body).toString('utf8');
  else return true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return graphqlDocumentWrites(text);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) return true;
  return list.some((entry) => !entry || typeof entry !== 'object' || graphqlDocumentWrites(entry.query, entry.operationName));
}

function envHosts(env, keys = []) {
  const out = [];
  for (const key of keys) {
    const raw = clean(env?.[key]);
    if (!raw) continue;
    const host = /^[a-z]+:\/\//i.test(raw) ? hostOfUrl(raw) : normalizeHost(raw.split(':')[0]);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

const AI_HOSTS = ['api.deepseek.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.openai.com', '*.aiplatform.googleapis.com', 'aiplatform.googleapis.com'];
const PAID_HOSTS = ['api.dataforseo.com', 'serpapi.com', 'places.googleapis.com', 'maps.googleapis.com', 'api.deepgram.com', 'search.brave.com', 'api.search.brave.com'];
const PROD_HOSTS = ['asoldi.com', 'www.asoldi.com'];
const GOOGLE_READ_HOSTS = [
  'www.googleapis.com',
  'gmail.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com',
  'mybusinessaccountmanagement.googleapis.com',
  'businessprofileperformance.googleapis.com',
];

/**
 * Rule list for a given env. A rule: { key, label, hosts, ports?, methods?, when?(req, ctx), readOnly }.
 * `key: 'local'` and every `readOnly: true` rule are on whenever safe mode is on;
 * other rules are on only when HUB_SAFE_MODE_ALLOW names their key.
 */
export function buildEgressRules(env = process.env) {
  const smtpHosts = envHosts(env, ['SMTP_HOST', 'SMTP_FALLBACK_HOST']);
  const imapHosts = envHosts(env, ['INBOX_IMAP_HOST']);
  if (!imapHosts.length) imapHosts.push('imap.hostinger.com');
  const wordpressHosts = envHosts(env, ['WORDPRESS_URL']);
  const emailHosts = ['api.resend.com', ...smtpHosts];
  const sensitive = [...AI_HOSTS, ...PAID_HOSTS, ...PROD_HOSTS, ...emailHosts, 'api.brevo.com', 'api.sendinblue.com', 'api.stripe.com', 'api-m.paypal.com', 'api.fireflies.ai', 'go.lucaregnskap.no', 'api.github.com', ...imapHosts];
  return [
    // Named read-only hosts: on whenever safe mode is on.
    {
      key: 'googleRead',
      readOnly: true,
      label: 'Google Calendar/Gmail/Business Profile reads (GET, plus calendar freeBusy)',
      hosts: GOOGLE_READ_HOSTS,
      when: (req) => READ_METHODS.includes(req.method) || (req.method === 'POST' && /^\/calendar\/v3\/freeBusy\b/i.test(req.path)),
    },
    {
      key: 'googleRead',
      readOnly: true,
      label: 'Google OAuth token refresh',
      hosts: ['oauth2.googleapis.com'],
      when: (req) => READ_METHODS.includes(req.method) || (req.method === 'POST' && /^\/token\b/i.test(req.path)),
    },
    {
      key: 'myphonerRead',
      readOnly: true,
      label: 'Myphoner reads (GET)',
      hosts: ['*.myphoner.com', 'myphoner.com'],
      when: (req) => READ_METHODS.includes(req.method),
    },
    {
      key: 'accountingRead',
      readOnly: true,
      label: 'Luca GraphQL queries (no mutations)',
      hosts: ['go.lucaregnskap.no'],
      when: (req) => READ_METHODS.includes(req.method) || (req.method === 'POST' && req.bodyKnown && !graphqlIsMutation(req.body)),
    },
    ...(wordpressHosts.length ? [{
      key: 'wordpressRead',
      readOnly: true,
      label: 'WordPress REST reads (GET)',
      hosts: wordpressHosts,
      when: (req) => READ_METHODS.includes(req.method),
    }] : []),
    // Opt-in keys.
    { key: 'emailRedirect', label: 'Resend and SMTP (redirected sends only)', hosts: emailHosts },
    { key: 'brevoSend', label: 'Brevo API', hosts: ['api.brevo.com', 'api.sendinblue.com'] },
    { key: 'calendarWrite', label: 'Google Calendar writes', hosts: ['www.googleapis.com'], when: (req) => /^\/calendar\//i.test(req.path || '/calendar/') },
    {
      key: 'firefliesIngest',
      label: 'Fireflies GraphQL queries and media downloads',
      hosts: ['api.fireflies.ai', '*.fireflies.ai'],
      when: (req) => READ_METHODS.includes(req.method) || (req.method === 'POST' && req.bodyKnown && !graphqlIsMutation(req.body)),
    },
    { key: 'firefliesLiveJoin', label: 'Fireflies addToLive mutation', hosts: ['api.fireflies.ai'] },
    { key: 'myphonerWrite', label: 'Myphoner writes', hosts: ['*.myphoner.com', 'myphoner.com'] },
    {
      key: 'paymentsTest',
      label: 'Stripe with test keys, PayPal sandbox',
      hosts: ['api.stripe.com', 'api-m.sandbox.paypal.com'],
      when: (req) => {
        if (hostMatches('api-m.sandbox.paypal.com', req.host)) return true;
        if (stripeKeyMode(req.headers) !== 'test') return false;
        return !(req.method !== 'GET' && /^\/v1\/webhook_endpoints/i.test(req.path));
      },
    },
    {
      key: 'paymentsLive',
      label: 'Stripe live keys, PayPal live',
      hosts: ['api.stripe.com', 'api-m.paypal.com'],
      when: (req) => !(req.method !== 'GET' && /^\/v1\/webhook_endpoints/i.test(req.path)),
    },
    {
      key: 'stripeWebhookAdmin',
      label: 'Stripe webhook endpoint create/delete',
      hosts: ['api.stripe.com'],
      when: (req, ctx) => {
        if (!/^\/v1\/webhook_endpoints/i.test(req.path || '')) return false;
        const mode = stripeKeyMode(req.headers);
        return mode === 'live' ? ctx.allow.has('paymentsLive') : ctx.allow.has('paymentsTest');
      },
    },
    { key: 'prodPublish', label: 'asoldi.com (production hub)', hosts: PROD_HOSTS },
    ...(wordpressHosts.length ? [{ key: 'wordpressWrite', label: 'WordPress writes', hosts: wordpressHosts }] : []),
    { key: 'accountingWrite', label: 'Luca GraphQL mutations', hosts: ['go.lucaregnskap.no'] },
    { key: 'inboxRead', label: 'IMAP mailboxes (inbox bot)', hosts: imapHosts },
    { key: 'aiCalls', label: 'LLM APIs', hosts: AI_HOSTS },
    { key: 'paidApi', label: 'Paid data APIs', hosts: PAID_HOSTS },
    {
      key: 'publicRead',
      label: 'GET/HEAD to public websites (not APIs, not asoldi.com)',
      hosts: [/^[a-z0-9.-]+$/],
      when: (req) => READ_METHODS.includes(req.method) && !sensitive.some((pattern) => hostMatches(pattern, req.host)),
      socketWhen: (req) => !sensitive.some((pattern) => hostMatches(pattern, req.host)),
    },
    { key: 'lan', label: 'Private LAN addresses', hosts: [/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/, /\.(local|lan|internal)$/] },
  ];
}

/**
 * Policy = rules + which keys are on. `allow` is the safe-mode allow set
 * (runtime-mode.js safeModeState().allow).
 */
export function buildEgressPolicy({ allow = new Set(), env = process.env } = {}) {
  const rules = buildEgressRules(env);
  const allowSet = allow instanceof Set ? allow : new Set(allow);
  return {
    allow: allowSet,
    rules,
    enabled: (rule) => rule.readOnly === true || allowSet.has(rule.key),
  };
}

/**
 * Host (and port) must match. A full request also has to pass `when`.
 *
 * A socket-only check sees no method, path or headers. So:
 *   - a rule with `socketWhen` decides with that;
 *   - a rule gated by `when` (read-only methods, test keys, no mutations) only admits a
 *     socket opened for a request the fetch/http layer already approved for this host
 *     (`fromApprovedRequest`). A raw tls.connect, http2, or an HTTP client that skips the
 *     patched fetch/http.request gets nothing from it;
 *   - a host-only rule (SMTP, IMAP, LAN) passes on the host.
 */
function ruleMatches(rule, req, ctx) {
  if (!rule.hosts.some((pattern) => hostMatches(pattern, req.host))) return false;
  if (rule.ports && req.port && !rule.ports.includes(Number(req.port))) return false;
  let check = rule.when;
  if (req.socketOnly) {
    if (typeof rule.socketWhen === 'function') check = rule.socketWhen;
    else if (typeof rule.when === 'function') return req.fromApprovedRequest === true;
    else return true;
  }
  if (typeof check !== 'function') return true;
  try {
    return Boolean(check(req, ctx));
  } catch {
    return false;
  }
}

/**
 * { allowed, key, kind } for one request. `req`: { host, port, method, path, headers, body, bodyKnown,
 * socketOnly, fromApprovedRequest }.
 */
export function evaluateEgress(policy, request = {}) {
  const req = {
    host: normalizeHost(request.host),
    port: Number(request.port) || 0,
    method: clean(request.method || (request.socketOnly ? '' : 'GET')).toUpperCase(),
    path: clean(request.path) || (request.socketOnly ? '' : '/'),
    headers: request.headers || {},
    body: request.body,
    bodyKnown: request.bodyKnown === true,
    socketOnly: request.socketOnly === true,
    fromApprovedRequest: request.fromApprovedRequest === true,
  };
  if (isLoopbackHost(req.host)) return { allowed: true, key: 'local', kind: 'local' };
  const ctx = { allow: policy.allow };
  for (const rule of policy.rules) {
    if (!policy.enabled(rule)) continue;
    if (ruleMatches(rule, req, ctx)) return { allowed: true, key: rule.key, kind: rule.key };
  }
  return { allowed: false, key: '', kind: classifyBlocked(policy, req) };
}

/** Which allow key would have let this through (for the intent log), else a host class. */
function classifyBlocked(policy, req) {
  const ctx = { allow: new Set(policy.rules.map((rule) => rule.key)) };
  for (const rule of policy.rules) {
    if (rule.key === 'publicRead' || rule.readOnly) continue;
    if (ruleMatches(rule, req, ctx)) return rule.key;
  }
  if (isPrivateLanHost(req.host)) return 'lan';
  if (req.socketOnly && policy.rules.some((rule) => rule.key !== 'publicRead' && typeof rule.when === 'function' && rule.hosts.some((p) => hostMatches(p, req.host)))) {
    // A method-gated host reached by a socket no approved fetch/http request opened.
    return 'rawSocket';
  }
  for (const rule of policy.rules) {
    if (rule.readOnly && rule.hosts.some((p) => hostMatches(p, req.host))) {
      if (rule.key === 'googleRead') return 'calendarWrite';
      if (rule.key === 'myphonerRead') return 'myphonerWrite';
      if (rule.key === 'accountingRead') return 'accountingWrite';
      if (rule.key === 'wordpressRead') return 'wordpressWrite';
    }
  }
  return 'egress';
}

/** Short, secret-free description of a request for the intent log (no query string). */
export function describeRequest({ method = '', host = '', port = 0, path = '' } = {}) {
  const cleanPath = clean(path).split('?')[0].slice(0, 120);
  const portPart = port && ![80, 443].includes(Number(port)) ? `:${port}` : '';
  return `${method ? `${method} ` : ''}${normalizeHost(host)}${portPart}${cleanPath}`.trim();
}

// ── installer ────────────────────────────────────────────────────────────────

let installed = null;

/**
 * Requests the fetch/http layer approved, as async context. The socket layer admits a
 * method-gated host only when the connect runs inside the context of an approved request
 * for that host and port (fetch's undici pool and the http Agent connect from there).
 */
const approvedRequests = new AsyncLocalStorage();

function runApproved(info, fn) {
  const entry = { host: normalizeHost(info.host), port: Number(info.port) || 0 };
  const parent = approvedRequests.getStore();
  const list = parent ? [...parent.slice(-7), entry] : [entry];
  return approvedRequests.run(list, fn);
}

function socketFromApprovedRequest(host, port) {
  const list = approvedRequests.getStore();
  if (!list) return false;
  const wantedHost = normalizeHost(host);
  const wantedPort = Number(port) || 0;
  return list.some((entry) => entry.host === wantedHost && (!entry.port || !wantedPort || entry.port === wantedPort));
}

function bodyForInspection(body) {
  if (typeof body === 'string') return { body, bodyKnown: true };
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return { body: Buffer.from(body).subarray(0, 65536), bodyKnown: true };
  if (body instanceof URLSearchParams) return { body: body.toString(), bodyKnown: true };
  return { body: undefined, bodyKnown: body == null };
}

function describeFetchArgs(input, init = {}) {
  let url = '';
  let method = clean(init?.method);
  let headers = init?.headers;
  if (typeof input === 'string' || input instanceof URL) {
    url = String(input);
  } else if (input && typeof input === 'object' && 'url' in input) {
    url = String(input.url);
    if (!method) method = clean(input.method);
    if (!headers) headers = input.headers;
  }
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const { body, bodyKnown } = bodyForInspection(init?.body);
  return {
    host: parsed ? parsed.hostname : '',
    port: parsed ? Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) : 0,
    method: (method || 'GET').toUpperCase(),
    path: parsed ? parsed.pathname : '/',
    headers: headers || {},
    body,
    bodyKnown,
  };
}

function describeHttpArgs(args, defaultProtocol) {
  let url = null;
  let options = {};
  let rest = args;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    try {
      url = new URL(String(args[0]));
    } catch {
      url = null;
    }
    rest = args.slice(1);
  }
  if (rest[0] && typeof rest[0] === 'object' && typeof rest[0] !== 'function') options = rest[0];
  const protocol = options.protocol || url?.protocol || defaultProtocol;
  const hostRaw = options.hostname || (options.host ? String(options.host).replace(/:\d+$/, '') : '') || url?.hostname || 'localhost';
  const port = Number(options.port) || Number(url?.port) || (protocol === 'https:' ? 443 : 80);
  const path = options.path || (url ? `${url.pathname}${url.search}` : '/');
  return {
    host: hostRaw,
    port,
    method: clean(options.method || 'GET').toUpperCase(),
    path: String(path).split('?')[0],
    headers: options.headers || {},
    bodyKnown: false,
    socketPath: options.socketPath || '',
  };
}

/** An Agent whose only socket is never connected and is destroyed with `error`. */
function refusingAgent(AgentClass, error) {
  const agent = new AgentClass({ keepAlive: false });
  agent.createConnection = () => {
    const socket = new net.Socket();
    // "Connecting" makes writes wait instead of failing with ERR_SOCKET_CLOSED, so the
    // caller sees the safe-mode error below.
    socket.connecting = true;
    setImmediate(() => socket.destroy(error));
    return socket;
  };
  return agent;
}

function blockedRequest(original, mod, args, info, error, AgentClass) {
  // A real ClientRequest (callers get the usual 'error' event) that never connects.
  // Note: `agent: false` would make Node create a fresh, working Agent, so pass our own.
  let url = null;
  let rest = args;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    url = args[0];
    rest = args.slice(1);
  }
  const options = rest[0] && typeof rest[0] === 'object' ? { ...rest[0] } : {};
  const callback = rest.find((item) => typeof item === 'function');
  const next = { ...options, agent: refusingAgent(AgentClass, error) };
  delete next.signal;
  delete next.createConnection;
  return url ? original.call(mod, url, next, callback) : original.call(mod, next, callback);
}

function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    if (first.path) return { ipc: true };
    return { host: first.host || first.hostname || 'localhost', port: Number(first.port) || 0 };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { ipc: true };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) || 0 };
}

/**
 * Patch fetch, http(s).request/get and net.Socket#connect. `onBlocked(event)` receives
 * { layer, kind, host, port, method, path, detail }. Idempotent: a second call swaps the policy.
 */
export function installEgressGuard(policy, { onBlocked = () => {} } = {}) {
  if (installed) {
    installed.policy = policy;
    installed.onBlocked = onBlocked;
    return installed;
  }
  const state = {
    policy,
    onBlocked,
    originals: {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      connect: net.Socket.prototype.connect,
    },
  };
  const report = (layer, info, verdict) => {
    const event = {
      layer,
      kind: verdict.kind || 'egress',
      host: normalizeHost(info.host),
      port: Number(info.port) || 0,
      method: info.method || '',
      path: clean(info.path).split('?')[0].slice(0, 120),
      detail: describeRequest(info),
    };
    try {
      state.onBlocked(event);
    } catch {
      // never let logging break the caller
    }
    return new SafeModeEgressError(`Blocked by hub safe mode (${event.kind}): ${event.detail}`, { kind: event.kind, host: event.host });
  };

  if (typeof state.originals.fetch === 'function') {
    globalThis.fetch = async function safeModeFetch(input, init) {
      const info = describeFetchArgs(input, init);
      const verdict = evaluateEgress(state.policy, info);
      if (!verdict.allowed) {
        const error = report('fetch', info, verdict);
        throw new TypeError('fetch failed', { cause: error });
      }
      return runApproved(info, () => state.originals.fetch.call(this, input, init));
    };
  }

  const wrap = (mod, originalName, defaultProtocol, layer) => {
    const original = state.originals[originalName];
    const requestFn = originalName.endsWith('Get') ? state.originals[originalName.replace('Get', 'Request')] : original;
    const AgentClass = mod === https ? https.Agent : http.Agent;
    return function safeModeRequest(...args) {
      const info = describeHttpArgs(args, defaultProtocol);
      if (info.socketPath) return original.apply(this, args);
      const verdict = evaluateEgress(state.policy, info);
      if (verdict.allowed) return runApproved(info, () => original.apply(this, args));
      const error = report(layer, info, verdict);
      const req = blockedRequest(requestFn, mod, args, info, error, AgentClass);
      if (originalName.endsWith('Get')) req.end();
      return req;
    };
  };
  http.request = wrap(http, 'httpRequest', 'http:', 'http');
  http.get = wrap(http, 'httpGet', 'http:', 'http');
  https.request = wrap(https, 'httpsRequest', 'https:', 'https');
  https.get = wrap(https, 'httpsGet', 'https:', 'https');

  net.Socket.prototype.connect = function safeModeConnect(...args) {
    const target = connectTarget(args);
    if (target.ipc) return state.originals.connect.apply(this, args);
    const info = { host: target.host, port: target.port, socketOnly: true, fromApprovedRequest: socketFromApprovedRequest(target.host, target.port) };
    const verdict = evaluateEgress(state.policy, info);
    if (verdict.allowed) return state.originals.connect.apply(this, args);
    const error = report('socket', info, verdict);
    process.nextTick(() => this.destroy(error));
    return this;
  };
  try {
    syncBuiltinESMExports();
  } catch {
    // older runtimes
  }
  installed = state;
  return state;
}

export function uninstallEgressGuard() {
  if (!installed) return;
  const { originals } = installed;
  if (originals.fetch) globalThis.fetch = originals.fetch;
  http.request = originals.httpRequest;
  http.get = originals.httpGet;
  https.request = originals.httpsRequest;
  https.get = originals.httpsGet;
  net.Socket.prototype.connect = originals.connect;
  try {
    syncBuiltinESMExports();
  } catch {
    // older runtimes
  }
  installed = null;
}

export function isEgressGuardInstalled() {
  return Boolean(installed);
}

/** Rule list for the Superadmin page: what is on and why. */
export function describeEgressPolicy(policy) {
  if (!policy) return [];
  const seen = new Map();
  for (const rule of policy.rules) {
    const id = `${rule.key}:${rule.label}`;
    if (seen.has(id)) continue;
    seen.set(id, {
      key: rule.key,
      label: rule.label,
      on: policy.enabled(rule),
      readOnly: rule.readOnly === true,
      hosts: rule.hosts.map((pattern) => (pattern instanceof RegExp ? String(pattern) : pattern)),
    });
  }
  return [{ key: 'local', label: 'Loopback (127.0.0.1, localhost, host.docker.internal)', on: true, readOnly: false, hosts: ['localhost', '127.0.0.0/8', '::1'] }, ...seen.values()];
}
