import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { authHeaders } from '../shared';

type Check = { ok: boolean; message: string; code?: string };
type Platform = {
  stripe: {
    mode: 'live' | 'test';
    liveKeyPresent: boolean;
    liveKeyIsLive: boolean;
    testKeyPresent: boolean;
    testKeyMasked: string;
    applicationFeePercent: number;
    webhooks: Record<'live' | 'test', { configured: boolean; url: string }>;
  };
  paypal: { mode: 'live' | 'sandbox'; clientId: string; clientSecretSet: boolean; partnerMerchantId: string; bnCode: string };
};
type Connection = {
  siteId: string;
  name: string;
  domain: string;
  stripe: { connected: boolean; mode: string; chargesEnabled: boolean };
  paypal: { connected: boolean; mode: string; paymentsReceivable: boolean; email: string };
};
type Snapshot = { platform: Platform; connections: Connection[]; webhookUrl: string; check?: { stripe: Check; paypal: Check } };

const input = 'w-full px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white text-sm';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? 'bg-green-400' : 'bg-gray-500'}`} />;
}

/** Superadmin: Asoldi as Stripe Connect platform + PayPal partner for client shops. */
export function ShopPaymentsPlatformCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ clientId: '', clientSecret: '', partnerMerchantId: '', bnCode: '', paypalMode: 'sandbox', testSecretKey: '' });

  const load = useCallback(async (check = false) => {
    const res = await fetch(`/api/hub/payments-platform${check ? '?check=1' : ''}`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.message || 'Could not load payment platform');
      return;
    }
    setData(body);
    setForm((f) => ({
      ...f,
      clientId: body.platform.paypal.clientId,
      partnerMerchantId: body.platform.paypal.partnerMerchantId,
      bnCode: body.platform.paypal.bnCode,
      paypalMode: body.platform.paypal.mode,
      clientSecret: '',
      testSecretKey: '',
    }));
  }, []);

  useEffect(() => {
    if (open && !data) void load(true);
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
        return false;
      }
      setMessage(done);
      await load(true);
      return true;
    } finally {
      setBusy(false);
    }
  }

  const p = data?.platform;
  const check = data?.check;
  const stripeMode = p?.stripe.mode || 'live';
  const webhook = p?.stripe.webhooks[stripeMode];

  return (
    <div className="mb-6 rounded-xl bg-[#2a2a2a] border border-white/10">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between p-4 text-left">
        <span className="flex items-center gap-2 text-white font-semibold">
          <CreditCard size={18} /> Shop payments (Stripe Connect + PayPal)
        </span>
        <span className="text-gray-400 text-sm">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-5">
          {!data && !error && <p className="text-gray-400 text-sm">Loading…</p>}
          {p && (
            <>
              <section className="space-y-2">
                <h3 className="text-white font-medium">Stripe Connect</h3>
                <p className="text-sm text-gray-300">
                  <Dot ok={Boolean(check?.stripe.ok)} />
                  {check?.stripe.message || 'Not checked'}
                </p>
                <p className="text-xs text-gray-500">
                  Live key on server: {p.stripe.liveKeyPresent ? (p.stripe.liveKeyIsLive ? 'yes (live)' : 'yes (not a live key)') : 'missing'} · Test key:{' '}
                  {p.stripe.testKeyPresent ? p.stripe.testKeyMasked : 'not saved'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-sm text-gray-300">Mode</label>
                  <select
                    value={stripeMode}
                    disabled={busy}
                    onChange={(e) => void send('PUT', '/api/hub/payments-platform', { stripe: { mode: e.target.value } }, `Stripe mode: ${e.target.value}.`)}
                    className="px-2 py-1 rounded bg-[#1a1a1a] border border-white/20 text-white text-sm"
                  >
                    <option value="live">Live (real money)</option>
                    <option value="test">Test (card 4242…)</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send('POST', '/api/hub/payments-platform/stripe-webhook', {}, `Connect webhook created for ${stripeMode} mode.`)}
                    className="px-3 py-1.5 rounded-lg bg-[#635bff] text-white text-sm disabled:opacity-50"
                  >
                    {webhook?.configured ? 'Recreate webhook' : 'Create webhook'}
                  </button>
                  <span className="text-xs text-gray-500">
                    <Dot ok={Boolean(webhook?.configured)} />
                    Webhook ({stripeMode}) {webhook?.configured ? 'ready' : 'missing'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    className={`${input} flex-1 min-w-[240px]`}
                    placeholder="Stripe TEST secret key (sk_test_…) – optional, for test mode"
                    value={form.testSecretKey}
                    onChange={(e) => setForm((f) => ({ ...f, testSecretKey: e.target.value }))}
                  />
                  <button
                    type="button"
                    disabled={busy || !form.testSecretKey.trim()}
                    onClick={() => void send('PUT', '/api/hub/payments-platform', { stripe: { testSecretKey: form.testSecretKey } }, 'Test key saved.')}
                    className="px-3 py-2 rounded-lg bg-white/10 text-white text-sm disabled:opacity-50"
                  >
                    Save test key
                  </button>
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-white font-medium">PayPal partner</h3>
                <p className="text-sm text-gray-300">
                  <Dot ok={Boolean(check?.paypal.ok)} />
                  {check?.paypal.message || 'Not checked'}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    value={form.paypalMode}
                    onChange={(e) => setForm((f) => ({ ...f, paypalMode: e.target.value }))}
                    className={input}
                  >
                    <option value="sandbox">Sandbox (test)</option>
                    <option value="live">Live (real money)</option>
                  </select>
                  <input className={input} placeholder="Client ID" value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
                  <input
                    className={input}
                    type="password"
                    placeholder={p.paypal.clientSecretSet ? 'Secret saved – leave empty to keep' : 'Secret'}
                    value={form.clientSecret}
                    onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
                  />
                  <input
                    className={input}
                    placeholder="Asoldi PayPal Merchant ID (enables 'Log in with PayPal')"
                    value={form.partnerMerchantId}
                    onChange={(e) => setForm((f) => ({ ...f, partnerMerchantId: e.target.value }))}
                  />
                  <input className={input} placeholder="BN code (from PayPal, optional)" value={form.bnCode} onChange={(e) => setForm((f) => ({ ...f, bnCode: e.target.value }))} />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void send(
                      'PUT',
                      '/api/hub/payments-platform',
                      {
                        paypal: {
                          mode: form.paypalMode,
                          clientId: form.clientId,
                          clientSecret: form.clientSecret,
                          partnerMerchantId: form.partnerMerchantId,
                          bnCode: form.bnCode,
                        },
                      },
                      'PayPal saved.'
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm font-medium disabled:opacity-50"
                >
                  Save PayPal
                </button>
              </section>

              <section className="space-y-1">
                <h3 className="text-white font-medium">Connected shops</h3>
                {data.connections.length === 0 && <p className="text-sm text-gray-500">No client has connected yet.</p>}
                {data.connections.map((row) => (
                  <p key={row.siteId} className="text-sm text-gray-300">
                    {row.name || row.domain}: Stripe{' '}
                    {row.stripe.connected ? (row.stripe.chargesEnabled ? `ready (${row.stripe.mode})` : 'onboarding') : '—'} · PayPal{' '}
                    {row.paypal.connected ? (row.paypal.email ? `email ${row.paypal.email}` : row.paypal.paymentsReceivable ? 'ready' : 'pending') : '—'}
                  </p>
                ))}
              </section>
              <button type="button" disabled={busy} onClick={() => void load(true)} className="text-sm text-gray-400 hover:text-white">
                Check again
              </button>
            </>
          )}
          {message && <p className="text-green-400 text-sm">{message}</p>}
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}
    </div>
  );
}
