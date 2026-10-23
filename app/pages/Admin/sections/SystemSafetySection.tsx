import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { API, authHeaders } from '../shared';
import { MakerHostsCard } from './MakerHostsCard';

type EgressRule = { key: string; label: string; on: boolean; readOnly: boolean; hosts: string[] };
type Intent = { at: string; kind: string; detail: string; layer?: string; host?: string };
type Counters = { email: { outboxed: number; redirected: number }; blocked: Record<string, number>; egress: Record<string, number> };
type SafeModeSnapshot = {
  safeMode: boolean;
  reason: string;
  allow: string[];
  unknownAllow?: string[];
  jobs: Record<string, 'on' | 'off'>;
  counters: Counters;
  since: string;
  egress: EgressRule[];
  keys: Record<string, string>;
  emailRedirectTo?: string;
  outbox: { total: number } | null;
  intents: Intent[];
};
type OutboxItem = {
  id: string;
  at: string;
  to: string[];
  bcc: string[];
  from: string;
  subject: string;
  transport: string;
  size: number;
  attachments: { filename: string; size: number }[];
  redirectedTo?: string;
  previewUrl: string;
};

const card = 'rounded-xl border border-white/10 bg-[#141414] p-4';

function when(iso = '') {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'medium' });
}

function CountList({ counts }: { counts: Record<string, number> }) {
  const rows = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return <p className="text-gray-500 text-xs">None yet.</p>;
  return (
    <ul className="text-sm space-y-1">
      {rows.map(([kind, n]) => (
        <li key={kind} className="flex justify-between gap-4"><span className="text-gray-300">{kind}</span><span className="text-white tabular-nums">{n}</span></li>
      ))}
    </ul>
  );
}

/**
 * Superadmin → System safety. Shows whether this hub runs in safe mode, which loops run,
 * what was blocked, the egress allowlist, and the outbox. Email previews render only in a
 * sandboxed iframe served from a signed, token-free URL with a strict CSP.
 */
export function SystemSafetySection() {
  const [snapshot, setSnapshot] = useState<SafeModeSnapshot | null>(null);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [selected, setSelected] = useState<OutboxItem | null>(null);
  const [text, setText] = useState('');
  const [showText, setShowText] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/system/safe-mode?intents=100`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'Could not load safe mode status.');
        return;
      }
      setSnapshot(body);
      if (body.safeMode) {
        const box = await fetch(`${API}/admin/system/outbox?limit=100`, { headers: authHeaders() });
        const list = await box.json().catch(() => ({}));
        setItems(Array.isArray(list.items) ? list.items : []);
      } else {
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(item: OutboxItem) {
    setSelected(item);
    setShowText(false);
    setText('');
    const res = await fetch(`${API}/admin/system/outbox/${encodeURIComponent(item.id)}`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setText(String(body.text || ''));
      if (body.previewUrl) setSelected({ ...item, previewUrl: body.previewUrl });
    }
  }

  async function downloadEml(item: OutboxItem) {
    const res = await fetch(`${API}/admin/system/outbox/${encodeURIComponent(item.id)}/eml`, { headers: authHeaders() });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.id}.eml`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  if (!snapshot) {
    return (
      <section>
        <h2 className="text-2xl font-semibold text-white mb-2">System safety</h2>
        <p className="text-gray-400 text-sm">{error || (loading ? 'Loading…' : '')}</p>
      </section>
    );
  }

  const jobs = Object.entries(snapshot.jobs || {});
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold text-white">System safety</h2>
        <button type="button" onClick={() => void load()} className="px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15 inline-flex items-center gap-2">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className={`${card} flex items-start gap-3 ${snapshot.safeMode ? 'border-green-500/40' : ''}`}>
        {snapshot.safeMode ? <ShieldCheck className="text-green-400 shrink-0" /> : <ShieldOff className="text-gray-400 shrink-0" />}
        <div className="text-sm">
          <p className="text-white font-medium">
            {snapshot.safeMode ? 'Safe mode is ON' : 'Safe mode is OFF: this hub sends real email and writes to real systems.'}
          </p>
          <p className="text-gray-400">
            Reason: {snapshot.reason}
            {snapshot.since ? ` · since ${when(snapshot.since)}` : ''}
          </p>
          {snapshot.safeMode && (
            <p className="text-gray-400 mt-1">
              Allowed: {snapshot.allow.length ? snapshot.allow.join(', ') : 'nothing extra'}
              {snapshot.emailRedirectTo ? ` · email redirected to ${snapshot.emailRedirectTo}` : ' · email goes to the outbox'}
            </p>
          )}
          {!!snapshot.unknownAllow?.length && <p className="text-amber-400 mt-1">Ignored unknown HUB_SAFE_MODE_ALLOW keys: {snapshot.unknownAllow.join(', ')}</p>}
        </div>
      </div>

      <MakerHostsCard />

      {snapshot.safeMode && (
        <div className="grid gap-4 md:grid-cols-3">
          <div className={card}>
            <h3 className="text-white font-medium mb-2">Background jobs</h3>
            <ul className="text-sm space-y-1">
              {jobs.map(([name, state]) => (
                <li key={name} className="flex justify-between gap-4">
                  <span className="text-gray-300">{name}</span>
                  <span className={state === 'on' ? 'text-green-400' : 'text-gray-500'}>{state}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={card}>
            <h3 className="text-white font-medium mb-2">Email</h3>
            <p className="text-sm text-gray-300">Outboxed: <span className="text-white">{snapshot.counters.email.outboxed}</span></p>
            <p className="text-sm text-gray-300">Redirected: <span className="text-white">{snapshot.counters.email.redirected}</span></p>
            <p className="text-sm text-gray-300">In outbox (30 days): <span className="text-white">{snapshot.outbox?.total ?? 0}</span></p>
            <h3 className="text-white font-medium mt-4 mb-2">Blocked actions</h3>
            <CountList counts={snapshot.counters.blocked} />
          </div>
          <div className={card}>
            <h3 className="text-white font-medium mb-2">Blocked connections</h3>
            <CountList counts={snapshot.counters.egress} />
          </div>
        </div>
      )}

      {snapshot.safeMode && (
        <div className={card}>
          <h3 className="text-white font-medium mb-3">Outbox</h3>
          {!items.length && <p className="text-gray-500 text-sm">No emails yet.</p>}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ul className="divide-y divide-white/10 max-h-[560px] overflow-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void open(item)}
                    className={`w-full text-left px-2 py-2 text-sm hover:bg-white/5 ${selected?.id === item.id ? 'bg-white/10' : ''}`}
                  >
                    <span className="block text-white truncate">{item.subject || '(no subject)'}</span>
                    <span className="block text-gray-400 text-xs truncate">
                      {when(item.at)} · to {item.to.join(', ')}
                      {item.attachments.length ? ` · ${item.attachments.length} attachment(s)` : ''}
                      {item.redirectedTo ? ` · redirected to ${item.redirectedTo}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs text-gray-400">
                  <span className="truncate">From {selected.from || '(default)'} · via {selected.transport || 'outbox'}</span>
                  <button type="button" onClick={() => setShowText((v) => !v)} className="px-2 py-1 rounded bg-white/10 text-white">
                    {showText ? 'HTML preview' : 'Plain text'}
                  </button>
                  <button type="button" onClick={() => void downloadEml(selected)} className="px-2 py-1 rounded bg-white/10 text-white">Download .eml</button>
                </div>
                {showText ? (
                  <pre className="whitespace-pre-wrap text-sm text-gray-200 bg-black/40 rounded-lg p-3 max-h-[520px] overflow-auto">{text || '(no plain text part)'}</pre>
                ) : (
                  <iframe
                    key={selected.previewUrl}
                    title="Email preview"
                    sandbox=""
                    referrerPolicy="no-referrer"
                    src={selected.previewUrl}
                    className="w-full h-[520px] rounded-lg bg-white"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {snapshot.safeMode && (
        <div className={card}>
          <h3 className="text-white font-medium mb-2">Recent blocked attempts</h3>
          {!snapshot.intents.length && <p className="text-gray-500 text-sm">Nothing blocked yet.</p>}
          <ul className="text-xs space-y-1 max-h-72 overflow-auto font-mono">
            {snapshot.intents.map((intent, index) => (
              <li key={`${intent.at}-${index}`} className="text-gray-300">
                <span className="text-gray-500">{when(intent.at)}</span> <span className="text-amber-300">{intent.kind}</span>
                {intent.layer ? <span className="text-gray-500"> [{intent.layer}]</span> : null} {intent.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {snapshot.safeMode && (
        <div className={card}>
          <h3 className="text-white font-medium mb-2">Egress allowlist</h3>
          <p className="text-gray-400 text-xs mb-2">Every other host is refused before a connection opens. Turn a key on with HUB_SAFE_MODE_ALLOW.</p>
          <table className="w-full text-xs">
            <tbody>
              {snapshot.egress.map((rule) => (
                <tr key={`${rule.key}-${rule.label}`} className="border-t border-white/5 align-top">
                  <td className={`py-1 pr-2 ${rule.on ? 'text-green-400' : 'text-gray-500'}`}>{rule.on ? 'on' : 'off'}</td>
                  <td className="py-1 pr-2 text-white">{rule.key}</td>
                  <td className="py-1 pr-2 text-gray-300">{rule.label}</td>
                  <td className="py-1 text-gray-500 break-all">{rule.hosts.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
