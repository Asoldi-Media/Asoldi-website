import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { API, authHeaders } from '../shared';

type MakerHost = {
  hostId: string;
  label: string;
  ownerAccountKey: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string | null;
  createdBy: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revoked: boolean;
  runIdCount: number;
  capabilities: { handlers: string[]; vision: boolean; cdp: boolean };
  version: string;
  makerPort: number | null;
  lastHeartbeatAt: string | null;
  heartbeats: number;
};
type PersistedCounter = { total: number; byReason: Record<string, number>; lastAt: string | null };
type HostsResponse = {
  hosts: MakerHost[];
  scopes: string[];
  tokenEnv: { prod: string; local: string };
  legacyTokenSource: string;
  failures: { windowMinutes: number; failures: number; alertThreshold: number; alertActive: boolean; lastAlertAt: string | null };
  counters: Partial<Record<'makerRejected' | 'makerFailureAlerts', PersistedCounter>>;
};
type NewToken = { hostId: string; token: string; label: string };

const card = 'rounded-xl border border-white/10 bg-[#141414] p-4';
const input = 'px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white text-sm';
const button = 'px-3 py-1.5 rounded-lg text-sm disabled:opacity-50';

function when(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Superadmin → System safety → Maker hosts. Each Website Maker install gets its own token
 * (x-maker-host-token); a token is shown once, right after it is made, and can be revoked here.
 * The legacy Maker callback token (Security card) keeps working beside host tokens.
 */
export function MakerHostsCard() {
  const [data, setData] = useState<HostsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [fresh, setFresh] = useState<NewToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/maker-hosts`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'Could not load Maker hosts.');
        return;
      }
      setData(body);
      setScopes((current) => (current.length ? current : body.scopes || []));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim() || busy) return;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const res = await fetch(`${API}/admin/maker-hosts`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), scopes }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'Could not create the Maker host.');
        return;
      }
      setFresh({ hostId: body.hostId, token: body.token, label: label.trim() });
      setLabel('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(host: MakerHost) {
    if (!window.confirm(`Revoke "${host.label}" (${host.hostId})? Its Maker gets 401 at once; this cannot be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/maker-hosts/${encodeURIComponent(host.hostId)}`, { method: 'DELETE', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.message || 'Could not revoke the Maker host.');
      if (fresh?.hostId === host.hostId) setFresh(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const rejected = data?.counters?.makerRejected;
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-4 mb-3">
        <h3 className="text-white font-medium inline-flex items-center gap-2">
          <KeyRound size={16} /> Maker hosts
        </h3>
        <button type="button" onClick={() => void load()} className={`${button} bg-white/10 text-white hover:bg-white/15 inline-flex items-center gap-2`}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      <p className="text-gray-400 text-xs mb-3">
        Each Website Maker gets its own token. Put it in the Maker <code>.env</code> as{' '}
        <code>{data?.tokenEnv?.prod || 'MAKER_HUB_TOKEN'}</code> (this hub on asoldi.com) or{' '}
        <code>{data?.tokenEnv?.local || 'MAKER_LOCAL_HUB_TOKEN'}</code> (a local hub), or run{' '}
        <code>node scripts/security/provision-maker-host.mjs</code> in the Maker. The legacy callback token ({data?.legacyTokenSource || '…'}) keeps working.
      </p>
      {error && <p className="text-red-400 text-sm mb-2">{error}</p>}

      {fresh && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 mb-3 text-sm">
          <p className="text-amber-300 mb-1">Token for “{fresh.label}” ({fresh.hostId}). It is shown only now; copy it into the Maker .env.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-white break-all bg-black/40 rounded px-2 py-1">{fresh.token}</code>
            <button type="button" onClick={() => void copyToken()} className={`${button} bg-white/10 text-white`}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" onClick={() => setFresh(null)} className={`${button} bg-white/10 text-white`}>Hide</button>
          </div>
        </div>
      )}

      <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-center gap-2 mb-4">
        <input className={input} placeholder="Label, e.g. Office PC (Docker)" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
        {(data?.scopes || []).map((scope) => (
          <label key={scope} className="text-xs text-gray-300 inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) => setScopes((current) => (event.target.checked ? [...current, scope] : current.filter((s) => s !== scope)))}
            />
            {scope}
          </label>
        ))}
        <button type="submit" disabled={busy || !label.trim() || !scopes.length} className={`${button} bg-white text-black`}>New Maker host</button>
      </form>

      {!data?.hosts?.length ? (
        <p className="text-gray-500 text-sm">No Maker hosts yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="py-1 pr-2">Host</th>
                <th className="py-1 pr-2">Token</th>
                <th className="py-1 pr-2">Scopes</th>
                <th className="py-1 pr-2">Last seen</th>
                <th className="py-1 pr-2">Heartbeat</th>
                <th className="py-1 pr-2">Version / port</th>
                <th className="py-1 pr-2">Handlers</th>
                <th className="py-1 pr-2">Runs</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {data.hosts.map((host) => (
                <tr key={host.hostId} className={`border-t border-white/5 align-top ${host.revoked ? 'opacity-50' : ''}`}>
                  <td className="py-1 pr-2 text-white">
                    {host.label}
                    <span className="block text-gray-500">{host.hostId} · {host.ownerAccountKey}</span>
                  </td>
                  <td className="py-1 pr-2 text-gray-300 font-mono">{host.tokenPrefix}…</td>
                  <td className="py-1 pr-2 text-gray-300">{host.scopes.join(', ')}</td>
                  <td className="py-1 pr-2 text-gray-300">{when(host.lastSeenAt)}</td>
                  <td className="py-1 pr-2 text-gray-300">{when(host.lastHeartbeatAt)}{host.heartbeats ? ` (${host.heartbeats})` : ''}</td>
                  <td className="py-1 pr-2 text-gray-300">{host.version || '—'}{host.makerPort ? ` · :${host.makerPort}` : ''}</td>
                  <td className="py-1 pr-2 text-gray-300">{host.capabilities.handlers.join(', ') || '—'}</td>
                  <td className="py-1 pr-2 text-gray-300 tabular-nums">{host.runIdCount}</td>
                  <td className="py-1 text-right">
                    {host.revoked ? (
                      <span className="text-gray-500">revoked {when(host.revokedAt)}</span>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => void revoke(host)} className={`${button} bg-red-500/20 text-red-300 hover:bg-red-500/30`}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-gray-500 text-xs mt-3">
        Refused Maker requests: {rejected?.total ?? 0}
        {rejected?.total ? ` (${Object.entries(rejected.byReason).map(([reason, n]) => `${reason} ${n}`).join(', ')}; last ${when(rejected.lastAt)})` : ''}
        {data?.failures ? ` · last ${data.failures.windowMinutes} min: ${data.failures.failures}${data.failures.alertActive ? ' (alert)' : ''}` : ''}
      </p>
    </div>
  );
}
