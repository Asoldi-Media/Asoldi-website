import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { authHeaders } from '../shared';

type Counter = { total: number; lastHour: number; lastDay: number; lastAt: string | null };
type FirefliesStatus = {
  webhookUrl: string;
  trustedSource: 'data' | 'none';
  stored: boolean;
  rotatedAt: string | null;
  acceptQueryToken: boolean;
  lastVerified: { via: string; at: string } | null;
  envRetired: boolean;
  retiredEnvPresent: { secret: boolean; token: boolean };
  apiKeyConfigured: boolean;
  apiKeySource: string | null;
  pullIngest: boolean;
  counters: Record<string, Counter>;
};
type SecurityStatus = {
  adminSecretSource: string;
  adminSecretEnvRejected: string | null;
  makerCallbackTokenSource: string;
  tokens: {
    maxTokenAgeDays: number;
    maxTokenAgeSource: 'env' | 'data' | 'default';
    revokedBefore: Record<'all' | 'admin' | 'staff' | 'client', string | null>;
    revokedSubjects: number;
  };
  firefliesWebhook: FirefliesStatus;
  counters: Record<string, Counter>;
};
type Reveal = { webhookUrl: string; secret: string; tokenUrl: string | null; rotatedAt: string };

const input = 'px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white text-sm';
const button = 'px-3 py-1.5 rounded-lg text-sm disabled:opacity-50';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? 'bg-green-400' : 'bg-amber-400'}`} />;
}

function when(value: string | null | undefined) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('nb-NO');
}

function storeAdminToken(token: string) {
  // Keep the admin signed in after "log out all admins": replace whichever key holds the session.
  if (localStorage.getItem('superAdminToken') && !localStorage.getItem('adminToken')) {
    localStorage.setItem('superAdminToken', token);
  } else {
    localStorage.setItem('adminToken', token);
  }
}

/** Superadmin: signing secret source, token policy, Fireflies webhook secret, security counters. */
export function SecurityCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SecurityStatus | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/system/security', { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.message || 'Could not load security status');
      return;
    }
    setData(body);
    setDays(body.tokens?.maxTokenAgeSource === 'data' ? String(body.tokens.maxTokenAgeDays) : '');
  }, []);

  useEffect(() => {
    if (open && !data) void load();
  }, [open, data, load]);

  async function send(method: string, path: string, body?: unknown, done = 'Saved.') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch(path, {
        method,
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.message || 'Request failed');
        return null;
      }
      if (json.token) storeAdminToken(json.token);
      setMessage(done);
      await load();
      return json;
    } finally {
      setBusy(false);
    }
  }

  async function revoke(scope: 'client' | 'staff' | 'admin' | 'all') {
    const label = { client: 'every client portal login', staff: 'every staff login', admin: 'every other admin session', all: 'everyone (you stay signed in)' }[scope];
    if (!window.confirm(`Log out ${label}?`)) return;
    await send('POST', '/api/admin/security/revoke-tokens', { scope }, `Logged out: ${label}.`);
  }

  async function showFirefliesSecret(rotate: boolean) {
    if (rotate && !window.confirm('Make a new Fireflies webhook secret? The current one stops working at once. Transcripts keep arriving through the pull ingest.')) return;
    const json = await send('POST', `/api/admin/security/fireflies-webhook/${rotate ? 'rotate' : 'reveal'}`, {}, rotate ? 'New secret made.' : 'Secret shown below.');
    if (json) setReveal(json as Reveal);
  }

  const ff = data?.firefliesWebhook;
  const counters = data ? (Object.entries(data.counters) as Array<[string, Counter]>) : [];

  return (
    <div className="mb-6 rounded-xl bg-[#2a2a2a] border border-white/10">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between p-4 text-left">
        <span className="flex items-center gap-2 text-white font-semibold">
          <ShieldCheck size={18} /> Security (logins, tokens, Fireflies webhook)
        </span>
        <span className="text-gray-400 text-sm">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-5">
          {!data && !error && <p className="text-gray-400 text-sm">Loading…</p>}
          {data && (
            <>
              <section className="space-y-1">
                <h3 className="text-white font-medium">Signing secrets</h3>
                <p className="text-sm text-gray-300">
                  <Dot ok={!data.adminSecretEnvRejected} />
                  Login tokens are signed with the {data.adminSecretSource === 'env' ? 'ADMIN_SECRET env value' : 'secret generated on the hub disk'}.
                  {data.adminSecretEnvRejected ? ` The ADMIN_SECRET env value is ignored (${data.adminSecretEnvRejected}).` : ''}
                </p>
                <p className="text-sm text-gray-300">
                  <Dot ok />
                  Maker callback token: {data.makerCallbackTokenSource === 'env' ? 'env value' : 'generated on the hub disk'}.
                </p>
              </section>

              <section className="space-y-2">
                <h3 className="text-white font-medium">Login tokens</h3>
                <p className="text-sm text-gray-300">
                  Tokens expire after {data.tokens.maxTokenAgeDays} days ({data.tokens.maxTokenAgeSource === 'env' ? 'AUTH_TOKEN_MAX_AGE_DAYS env' : data.tokens.maxTokenAgeSource === 'data' ? 'set here' : 'default'}).
                  {data.tokens.revokedSubjects ? ` ${data.tokens.revokedSubjects} users have used "log out everywhere" or changed password.` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input className={`${input} w-28`} type="number" min={1} max={365} placeholder="30" value={days} onChange={(e) => setDays(e.target.value)} />
                  <span className="text-sm text-gray-400">days</span>
                  <button
                    type="button"
                    disabled={busy || data.tokens.maxTokenAgeSource === 'env'}
                    onClick={() => void send('PUT', '/api/admin/security/token-settings', { maxTokenAgeDays: days ? Number(days) : null }, 'Token age saved.')}
                    className={`${button} bg-[#FF5B00] text-white`}
                  >
                    Save
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(['client', 'staff', 'admin', 'all'] as const).map((scope) => (
                    <button key={scope} type="button" disabled={busy} onClick={() => void revoke(scope)} className={`${button} border border-white/20 text-gray-200 hover:bg-white/10`}>
                      {{ client: 'Log out all clients', staff: 'Log out all staff', admin: 'Log out other admins', all: 'Log out everyone' }[scope]}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500">
                  Last forced logout: clients {when(data.tokens.revokedBefore.client)} · staff {when(data.tokens.revokedBefore.staff)} · admins {when(data.tokens.revokedBefore.admin)} · everyone {when(data.tokens.revokedBefore.all)}
                </p>
              </section>

              {ff && (
                <section className="space-y-2">
                  <h3 className="text-white font-medium">Fireflies webhook</h3>
                  <p className="text-sm text-gray-300">
                    <Dot ok={ff.stored} />
                    Trusted secret: {ff.stored ? `on the hub disk (made ${when(ff.rotatedAt)})` : 'missing: the data folder is not writable'}.
                    {' '}Last accepted webhook: {ff.lastVerified ? `${ff.lastVerified.via}, ${when(ff.lastVerified.at)}` : 'none yet'}.
                  </p>
                  <p className="text-sm text-gray-300">
                    <Dot ok={ff.pullIngest} />
                    Pull ingest (every 60 s): {ff.pullIngest ? `on, API key from ${ff.apiKeySource}` : 'off: set FIREFLIES_API_KEY or FIREFLIES_API'}. Transcripts, the recording e-mail and the media copy all work this way, also before the new secret is pasted into Fireflies.
                  </p>
                  {(ff.retiredEnvPresent.secret || ff.retiredEnvPresent.token) && (
                    <p className="text-xs text-gray-500">
                      FIREFLIES_WEBHOOK_SECRET / FIREFLIES_WEBHOOK_TOKEN in the env are retired: requests using them get 401
                      {ff.counters['fireflies-webhook-retired-credential'] ? ` (${ff.counters['fireflies-webhook-retired-credential'].total} since restart)` : ''}.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={busy} onClick={() => void showFirefliesSecret(false)} className={`${button} bg-[#FF5B00] text-white`}>
                      Show secret for Fireflies
                    </button>
                    <button type="button" disabled={busy} onClick={() => void showFirefliesSecret(true)} className={`${button} border border-white/20 text-gray-200 hover:bg-white/10`}>
                      Make a new secret
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void send('POST', '/api/admin/security/fireflies-webhook/query-token', { enabled: !ff.acceptQueryToken }, 'Saved.')}
                      className={`${button} border border-white/20 text-gray-200 hover:bg-white/10`}
                    >
                      {ff.acceptQueryToken ? 'Turn off ?token= URLs' : 'Allow ?token= URLs'}
                    </button>
                  </div>
                  {reveal && (
                    <div className="rounded-lg border border-white/10 bg-[#1a1a1a] p-3 space-y-2 text-sm">
                      <p className="text-gray-300">
                        In Fireflies: Settings → Developer settings → Webhooks. Webhook URL and secret:
                      </p>
                      <input className={`${input} w-full font-mono`} readOnly value={reveal.webhookUrl} onFocus={(e) => e.currentTarget.select()} />
                      <input className={`${input} w-full font-mono`} readOnly value={reveal.secret} onFocus={(e) => e.currentTarget.select()} />
                      {reveal.tokenUrl && (
                        <>
                          <p className="text-xs text-gray-500">Only if Fireflies cannot sign: this URL carries a token instead.</p>
                          <input className={`${input} w-full font-mono`} readOnly value={reveal.tokenUrl} onFocus={(e) => e.currentTarget.select()} />
                        </>
                      )}
                      <button type="button" onClick={() => setReveal(null)} className="text-xs text-gray-400 hover:text-white">Hide</button>
                    </div>
                  )}
                </section>
              )}

              {counters.length > 0 && (
                <section className="space-y-1">
                  <h3 className="text-white font-medium">Since the last restart</h3>
                  <ul className="text-xs text-gray-400 space-y-0.5">
                    {counters.map(([kind, row]) => (
                      <li key={kind}>
                        {kind}: {row.total} (last hour {row.lastHour}, last {when(row.lastAt)})
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          {message && <p className="text-sm text-green-400">{message}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
